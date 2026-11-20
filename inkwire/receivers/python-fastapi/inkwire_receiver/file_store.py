"""A directory of markdown files: the store for sites that render from ``content/``.

Layout::

    <root>/<kind>/<slug>.md          YAML frontmatter + the markdown body
    <root>/media/<hex>-<name>        uploaded images
    <root>/media/<hex>-<name>.meta.json   sidecar: id, filename, mime_type, created_at, alt, title, size

Files the site already has are first-class: a file with no frontmatter (or partial frontmatter)
is read with defaults — the kind comes from the folder, the title from the first ``# `` heading,
``external_id`` is null and the status is ``published``. Writing is atomic (temp file + rename),
and every file name is validated as a slug before it touches a path.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import threading
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from .errors import InkwireError
from .media import extension_for, validate_image
from .render import render_markdown
from .schema import KIND_RE, SLUG_RE
from .store import (
    ListFilter,
    MediaListFilter,
    MediaResult,
    MediaUpload,
    StoredContent,
    fetch_media_bytes,
    matches,
    now_iso,
    paginate,
    paginate_media,
    safe_filename,
)

FRONTMATTER = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)
HEADING = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
FRONTMATTER_FIELDS = (
    "title",
    "kind",
    "slug",
    "external_id",
    "status",
    "excerpt",
    "tags",
    "categories",
    "cover_image_url",
    "cover_image_alt",
    "canonical_url",
    "seo",
    "author",
    "published_at",
    "updated_at",
)
SEO_FIELDS = ("title", "description", "image_url", "noindex", "og_title", "og_description", "json_ld")
MEDIA_ID_RE = re.compile(r"[0-9a-f]{16}")
MEDIA_SIDECAR = ".meta.json"


def split_frontmatter(text: str) -> tuple[dict, str]:
    """``("---\\ntitle: x\\n---\\n\\nbody")`` -> ``({"title": "x"}, "body")``; tolerant of absence.

    Exactly one newline after the closing fence (the blank separator line) is dropped so a
    written entry reads back byte-for-byte; any further leading newlines belong to the body.
    """
    match = FRONTMATTER.match(text)
    if not match:
        return {}, text
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        return {}, text
    if not isinstance(data, dict):
        return {}, text
    body = text[match.end() :]
    if body.startswith("\r\n"):
        body = body[2:]
    elif body.startswith("\n"):
        body = body[1:]
    return data, body


def _iso(value: Any) -> str | None:
    """Frontmatter dates come back as ``date``/``datetime`` objects from PyYAML."""
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    return None


def _text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (str, int, float)):
        return str(value)
    return None


def _tags(value: Any) -> list[str] | None:
    if value is None:
        return None
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        return [str(tag) for tag in value]
    return None


class FileStore:
    """Stores entries as ``<root>/<kind>/<slug>.md``; ids are ``<kind>:<slug>``."""

    def __init__(
        self,
        root: str | os.PathLike[str],
        media_url_base: str = "/inkwire-media",
        *,
        fetcher=None,
        max_media_bytes: int | None = None,
    ):
        self.root = Path(root).expanduser().resolve()
        self.media_url_base = media_url_base.rstrip("/")
        self._fetcher = fetcher
        self.max_media_bytes = max_media_bytes
        self._media_lock = threading.Lock()

    # --- path safety ------------------------------------------------------

    def _path(self, kind: str, slug: str) -> Path:
        """The only place a name becomes a path. Slugs and kinds are validated first."""
        if not isinstance(kind, str) or not KIND_RE.match(kind):
            raise InkwireError("invalid_payload", f"kind: '{kind}' is not a valid kind")
        if not isinstance(slug, str) or not SLUG_RE.match(slug) or ".." in slug:
            raise InkwireError("invalid_payload", f"slug: '{slug}' is not a valid file name")
        path = (self.root / kind / f"{slug}.md").resolve()
        if not path.is_relative_to(self.root):
            raise InkwireError("invalid_payload", f"slug: '{slug}' escapes the content directory")
        return path

    @staticmethod
    def split_id(content_id: str) -> tuple[str, str] | None:
        if not isinstance(content_id, str) or ":" not in content_id:
            return None
        kind, _, slug = content_id.partition(":")
        if not KIND_RE.match(kind) or not SLUG_RE.match(slug) or ".." in slug:
            return None
        return kind, slug

    # --- reading ----------------------------------------------------------

    def _read(self, path: Path, kind: str, key: str) -> StoredContent:
        raw = path.read_text(encoding="utf-8", errors="replace")
        front, body = split_frontmatter(raw)
        stat = path.stat()
        slug = path.stem
        mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")

        title = _text(front.get("title"))
        if not title:
            heading = HEADING.search(body)
            title = heading.group(1).strip() if heading else slug

        stored_kind = _text(front.get("kind")) or kind
        status = _text(front.get("status"))
        if status not in ("draft", "published"):
            status = "published"

        seo: dict | None = None
        if isinstance(front.get("seo"), dict):
            seo = {name: front["seo"][name] for name in SEO_FIELDS if front["seo"].get(name) is not None} or None
        author: dict | None = None
        if isinstance(front.get("author"), dict):
            author = {
                name: front["author"][name]
                for name in ("name", "email")
                if front["author"].get(name) is not None
            } or None

        content_id = f"{kind}:{slug}"
        return {
            "id": content_id,
            "key": key,
            "external_id": _text(front.get("external_id")),
            "kind": stored_kind,
            "title": title,
            "slug": _text(front.get("slug")) or slug,
            "markdown": body,
            "html": render_markdown(body),
            "excerpt": _text(front.get("excerpt")),
            "tags": _tags(front.get("tags")),
            "categories": _tags(front.get("categories")),
            "cover_image_url": _text(front.get("cover_image_url")),
            "cover_image_alt": _text(front.get("cover_image_alt")),
            "canonical_url": _text(front.get("canonical_url")),
            "seo": seo,
            "author": author,
            "status": status,
            "published_at": _iso(front.get("published_at")) or mtime,
            "updated_at": _iso(front.get("updated_at")) or mtime,
            "version": _int(front.get("version")),
            # mtime + size: touching the file on disk is a new ETag, whatever wrote it
            "etag": f'"{content_id}-{stat.st_mtime_ns // 1_000_000}-{stat.st_size}"',
        }

    def _get_sync(self, key: str, content_id: str) -> StoredContent | None:
        split = self.split_id(content_id)
        if split is None:
            return None
        path = self._path(*split)
        return self._read(path, split[0], key) if path.is_file() else None

    def _list_sync(self, key: str, filter: ListFilter) -> tuple[list[StoredContent], str | None]:
        kinds = [filter.kind] if filter.kind else self._kinds()
        entries: list[StoredContent] = []
        for kind in kinds:
            directory = self.root / kind
            if not directory.is_dir():
                continue
            for path in sorted(directory.glob("*.md")):
                if not SLUG_RE.match(path.stem):
                    continue
                entry = self._read(path, kind, key)
                if matches(entry, filter):
                    entries.append(entry)
        return paginate(entries, filter)

    def _kinds(self) -> list[str]:
        if not self.root.is_dir():
            return []
        return sorted(
            child.name
            for child in self.root.iterdir()
            if child.is_dir() and child.name != "media" and KIND_RE.match(child.name)
        )

    # --- writing ----------------------------------------------------------

    def _serialize(self, entry: StoredContent) -> str:
        front: dict = {}
        for name in FRONTMATTER_FIELDS:
            value = entry.get(name)
            if value in (None, [], {}):
                if name in ("title", "kind", "slug"):
                    front[name] = value
                continue
            front[name] = value
        dumped = yaml.safe_dump(front, allow_unicode=True, sort_keys=False, default_flow_style=False).strip()
        body = entry.get("markdown") or ""
        return f"---\n{dumped}\n---\n\n{body}"

    def _save_sync(self, key: str, entry: StoredContent) -> StoredContent:
        target = self._path(entry["kind"], entry["slug"])
        previous = self.split_id(entry.get("id") or "")
        previous_path = self._path(*previous) if previous else None

        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{target.name}.tmp-{secrets.token_hex(4)}")
        try:
            tmp.write_text(self._serialize(entry), encoding="utf-8")
            os.replace(tmp, target)
        finally:
            if tmp.exists():
                tmp.unlink()

        if previous_path is not None and previous_path != target and previous_path.is_file():
            previous_path.unlink()
        return self._read(target, entry["kind"], key)

    def _remove_sync(self, key: str, content_id: str) -> bool:
        split = self.split_id(content_id)
        if split is None:
            return False
        path = self._path(*split)
        if not path.is_file():
            return False
        path.unlink()
        return True

    # --- media ------------------------------------------------------------

    @staticmethod
    def _atomic_write(path: Path, data: bytes) -> None:
        tmp = path.with_name(f".{path.name}.tmp-{secrets.token_hex(4)}")
        try:
            tmp.write_bytes(data)
            os.replace(tmp, path)
        finally:
            if tmp.exists():
                tmp.unlink()

    @property
    def _media_dir(self) -> Path:
        return self.root / "media"

    def _save_media(self, upload: MediaUpload) -> MediaResult:
        self._media_dir.mkdir(parents=True, exist_ok=True)
        hex_id = secrets.token_hex(8)
        extension = extension_for(upload.content_type, upload.filename)
        name = safe_filename(upload.filename)
        if "." not in name:
            name = f"{name}.{extension}"
        filename = f"{hex_id}-{name}"
        meta = {
            "id": hex_id,
            "filename": filename,
            "mime_type": upload.content_type,
            "created_at": now_iso(),
            "alt": upload.alt,
            "title": None,
            "size": len(upload.data),
        }
        # the image first, the sidecar last: a library entry only exists once its sidecar does
        self._atomic_write(self._media_dir / filename, upload.data)
        self._write_media_meta(self._media_dir / f"{filename}{MEDIA_SIDECAR}", meta)
        return self._media_item(meta)

    def _write_media_meta(self, path: Path, meta: dict) -> None:
        self._atomic_write(path, json.dumps(meta, ensure_ascii=False).encode("utf-8"))

    def _media_item(self, meta: dict) -> MediaResult:
        return MediaResult(
            id=meta["id"],
            url=f"{self.media_url_base}/{meta['filename']}",
            alt=meta.get("alt"),
            title=meta.get("title"),
            mime_type=meta["mime_type"],
            created_at=meta["created_at"],
        )

    def _read_media_meta(self, path: Path) -> dict | None:
        """The sidecar as a dict, or ``None`` when it is not one of ours or its image is gone."""
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(meta, dict):
            return None
        for field in ("id", "filename", "mime_type", "created_at"):
            if not isinstance(meta.get(field), str):
                return None
        filename = meta["filename"]
        if not MEDIA_ID_RE.fullmatch(meta["id"]) or Path(filename).name != filename:
            return None
        if not (path.parent / filename).is_file():
            return None
        return meta

    def _find_media_meta(self, id: str) -> tuple[Path, dict] | None:
        """Ids are opaque to callers; ours are 16 hex characters, so anything else never reaches a path."""
        if not isinstance(id, str) or not MEDIA_ID_RE.fullmatch(id) or not self._media_dir.is_dir():
            return None
        for path in sorted(self._media_dir.glob(f"{id}-*{MEDIA_SIDECAR}")):
            meta = self._read_media_meta(path)
            if meta is not None and meta["id"] == id:
                return path, meta
        return None

    def _list_media_sync(self, filter: MediaListFilter) -> tuple[list[MediaResult], str | None]:
        items: list[MediaResult] = []
        if self._media_dir.is_dir():
            for path in self._media_dir.glob(f"*{MEDIA_SIDECAR}"):
                meta = self._read_media_meta(path)
                if meta is not None:
                    items.append(self._media_item(meta))
        return paginate_media(items, filter)

    def _update_media_sync(self, id: str, patch: dict) -> MediaResult | None:
        with self._media_lock:
            found = self._find_media_meta(id)
            if found is None:
                return None
            path, meta = found
            for name in ("alt", "title"):
                if name in patch:
                    meta[name] = patch[name]
            self._write_media_meta(path, meta)
            return self._media_item(meta)

    # --- protocol ---------------------------------------------------------

    async def get(self, key: str, id: str) -> StoredContent | None:
        return await asyncio.to_thread(self._get_sync, key, id)

    async def list(self, key: str, filter: ListFilter) -> tuple[list[StoredContent], str | None]:
        return await asyncio.to_thread(self._list_sync, key, filter)

    async def save(self, key: str, entry: StoredContent) -> StoredContent:
        return await asyncio.to_thread(self._save_sync, key, entry)

    async def remove(self, key: str, id: str) -> bool:
        return await asyncio.to_thread(self._remove_sync, key, id)

    async def media(self, key: str, upload: MediaUpload) -> MediaResult:
        return await asyncio.to_thread(self._save_media, upload)

    async def list_media(self, key: str, filter: MediaListFilter) -> tuple[list[MediaResult], str | None]:
        return await asyncio.to_thread(self._list_media_sync, filter)

    async def update_media(self, key: str, id: str, patch: dict) -> MediaResult | None:
        """``patch`` holds only the fields to change; a ``None`` value clears that field."""
        return await asyncio.to_thread(self._update_media_sync, id, patch)

    @property
    def fetches_media_urls(self) -> bool:
        """True when a guarded fetcher is set: the receiver then advertises ``media_url``."""
        return self._fetcher is not None

    async def fetch_media(self, key: str, url: str, alt: str | None = None) -> MediaResult:
        if self._fetcher is None:
            raise InkwireError(
                "invalid_payload", "media: fetching a url is not enabled on this receiver; upload the file instead"
            )
        data, filename, content_type = await fetch_media_bytes(self._fetcher, url)
        if self.max_media_bytes and len(data) > self.max_media_bytes:
            raise InkwireError("too_large", f"media: over the receiver's limit of {self.max_media_bytes} bytes")
        sniffed = validate_image(data, filename=filename, content_type=content_type)
        return await self.media(
            key, MediaUpload(data=data, filename=filename, content_type=sniffed, alt=alt)
        )


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 1


__all__ = ["FRONTMATTER_FIELDS", "FileStore", "split_frontmatter"]
