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
from .media import extension_for, image_size, validate_image
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
    "lang",
    "translation_key",
    "published_at",
    "updated_at",
)
LANG_RE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$")
SEO_FIELDS = ("title", "description", "image_url", "noindex", "og_title", "og_description", "json_ld")
MEDIA_ID_RE = re.compile(r"[0-9a-f]{16}")
MEDIA_SIDECAR = ".meta.json"


class _BadFrontmatter(ValueError):
    """The file opens with a frontmatter block that is not a YAML mapping."""


def split_frontmatter(text: str, *, strict: bool = False) -> tuple[dict, str]:
    """``("---\\ntitle: x\\n---\\n\\nbody")`` -> ``({"title": "x"}, "body")``; tolerant of absence.

    Exactly one newline after the closing fence (the blank separator line) is dropped so a
    written entry reads back byte-for-byte; any further leading newlines belong to the body.
    ``strict`` raises ``_BadFrontmatter`` for a block that is not valid YAML (the store hides such
    files rather than guess at them).
    """
    match = FRONTMATTER.match(text)
    if not match:
        return {}, text
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        if strict:
            raise _BadFrontmatter() from None
        return {}, text
    if data is None:
        data = {}
    if not isinstance(data, dict):
        if strict:
            raise _BadFrontmatter()
        return {}, text
    body = text[match.end() :]
    if body.startswith("\r\n"):
        body = body[2:]
    elif body.startswith("\n"):
        body = body[1:]
    return data, body


_DATE_ONLY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_NO_ZONE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$")


def _iso(value: Any) -> str | None:
    """A frontmatter date as ISO-8601 with an offset: date-only and zone-less values are read as UTC."""
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return f"{value.isoformat()}T00:00:00.000Z"
    if isinstance(value, str):
        text = value.strip()
        if _DATE_ONLY.match(text):
            return f"{text}T00:00:00.000Z"
        if _NO_ZONE.match(text):
            return f"{text.replace(' ', 'T')}Z"
        return text or None
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


_ALIASES = {
    "excerpt": ("excerpt", "description"),
    "categories": ("categories", "category"),
    "published_at": ("published_at", "date", "pubDate"),
    "updated_at": ("updated_at", "lastmod"),
    "translation_key": ("translation_key", "translationKey"),  # Hugo's spelling
}


def _norm(value: Any) -> Any:
    return None if value in (None, [], {}) else value


def _edit_text(previous_raw: str, before: StoredContent, after: StoredContent) -> str | None:
    """Saves an edit into an existing file without rewriting what it did not change.

    Every frontmatter key the receiver does not manage (``layout``, ``heroImage``, ``weight``...)
    survives, and a field the file spells its own way (``date``, ``lastmod``, ``description``,
    ``draft``) is updated under that spelling. Key order is kept; YAML comments are not (PyYAML).
    Returns ``None`` when the file has no usable frontmatter: the caller writes a fresh one.
    """
    if not FRONTMATTER.match(previous_raw):
        return None
    try:
        front, _ = split_frontmatter(previous_raw, strict=True)
    except _BadFrontmatter:
        return None

    def changed(name: str) -> bool:
        return _norm(before.get(name)) != _norm(after.get(name))

    def put(name: str, value: Any) -> None:
        names = _ALIASES.get(name, (name,))
        if _norm(value) is None:
            for alias in names:
                front.pop(alias, None)
        else:
            front[next((alias for alias in names if alias in front), name)] = value

    if changed("title"):
        front["title"] = after["title"]
    if changed("status"):
        draft = after["status"] == "draft"
        own = [name for name in ("draft", "published", "status") if name in front] or ["status"]
        for name in own:
            front[name] = draft if name == "draft" else (not draft) if name == "published" else after["status"]
    for name in ("external_id", "tags", "cover_image_url", "cover_image_alt", "canonical_url", "author", "version",
                 "excerpt", "categories", "published_at", "updated_at", "seo", "lang", "translation_key"):
        if changed(name):
            put(name, after.get(name))
    # kind and slug come from the path; a file that spells them out keeps them true.
    for name in ("slug", "kind"):
        if name in front and changed(name):
            front[name] = after[name]

    dumped = yaml.safe_dump(front, allow_unicode=True, sort_keys=False, default_flow_style=False).strip()
    return f"---\n{dumped}\n---\n\n{after.get('markdown') or ''}"


class FileStore:
    """Stores entries as ``<root>/<kind>/<slug>.md``; ids are ``<kind>:<slug>``.

    Redirects live in ``<root>/.redirects.json`` and each entry's past versions in
    ``<root>/.revisions/<kind>.<slug>.json``, newest first (the TypeScript FileStore's format).
    """

    translations = True

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
        self._redirects_lock = threading.Lock()
        self._revisions_lock = threading.Lock()

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

    def _read(self, path: Path, kind: str, key: str) -> StoredContent | None:
        raw = path.read_text(encoding="utf-8", errors="replace")
        try:
            front, body = split_frontmatter(raw, strict=True)
        except _BadFrontmatter:
            return None
        stat = path.stat()
        slug = path.stem
        mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")

        title = _text(front.get("title"))
        if not title:
            heading = HEADING.search(body)
            title = heading.group(1).strip() if heading else slug.replace("-", " ")

        # Hugo, Astro and Jekyll mark drafts with `draft: true` or `published: false`.
        status = "draft" if (
            front.get("status") == "draft" or front.get("draft") is True or front.get("published") is False
        ) else "published"

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
        lang = _text(front.get("lang"))
        translation_key = _text(front.get("translation_key")) or _text(front.get("translationKey"))
        return {
            "id": content_id,
            "key": key,
            "external_id": _text(front.get("external_id")),
            "kind": kind,  # the path decides, whatever the frontmatter says
            "title": title,
            "slug": slug,
            "markdown": body,
            "html": render_markdown(body),
            "excerpt": _text(front.get("excerpt")) or _text(front.get("description")),
            "tags": _tags(front.get("tags")),
            "categories": _tags(front.get("categories") or front.get("category")),
            "cover_image_url": _text(front.get("cover_image_url")),
            "cover_image_alt": _text(front.get("cover_image_alt")),
            "canonical_url": _text(front.get("canonical_url")),
            "seo": seo,
            "author": author,
            "lang": lang if lang and LANG_RE.match(lang) else None,
            "translation_key": translation_key[:255] if translation_key else None,
            "status": status,
            "published_at": _iso(front.get("published_at")) or _iso(front.get("date")) or _iso(front.get("pubDate")) or mtime,
            "updated_at": _iso(front.get("updated_at")) or _iso(front.get("lastmod")) or mtime,
            "version": _int(front.get("version")),
            # mtime + size: touching the file on disk is a new ETag, whatever wrote it
            "etag": f'"{content_id}-{stat.st_mtime_ns // 1_000_000}-{stat.st_size}"',
        }

    def _get_sync(self, key: str, content_id: str) -> StoredContent | None:
        split = self.split_id(content_id)
        if split is None:
            return None
        path = self._path(*split)
        return self._read(path, split[0], key) if path.is_file() else None  # None also for hidden files

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
                if entry is not None and matches(entry, filter):
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
        # Never overwrite a file that is not this entry (including one whose frontmatter is unreadable).
        if previous_path != target and target.exists():
            raise InkwireError("conflict", f"{entry['kind']}/{entry['slug']}.md already exists")

        # An edit of an existing file changes only what changed in it (its own frontmatter keys survive).
        text = None
        if previous and previous_path is not None and previous_path.is_file():
            before = self._read(previous_path, previous[0], key)
            if before is not None:
                text = _edit_text(previous_path.read_text(encoding="utf-8", errors="replace"), before, entry)

        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{target.name}.tmp-{secrets.token_hex(4)}")
        try:
            tmp.write_text(text or self._serialize(entry), encoding="utf-8")
            os.replace(tmp, target)
        finally:
            if tmp.exists():
                tmp.unlink()

        if previous_path is not None and previous_path != target and previous_path.is_file():
            previous_path.unlink()
        saved = self._read(target, entry["kind"], key)
        if saved is None:
            raise InkwireError("internal", "the entry was written but could not be read back")
        return saved

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
        dims = image_size(upload.data, upload.content_type)
        if dims:
            meta["width"], meta["height"] = dims
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
            width=meta["width"] if isinstance(meta.get("width"), int) else None,
            height=meta["height"] if isinstance(meta.get("height"), int) else None,
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

    # --- redirects: one JSON list for the whole site (ponytail: rewritten on each change; a
    # database store wants a table once a site has thousands of renames) ---

    @property
    def _redirects_file(self) -> Path:
        return self.root / ".redirects.json"

    def _read_redirects(self) -> list[dict]:
        try:
            parsed = json.loads(self._redirects_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        return [r for r in parsed if isinstance(r, dict)] if isinstance(parsed, list) else []

    def _write_redirects(self, items: list[dict]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self._atomic_write(self._redirects_file, json.dumps(items).encode("utf-8"))

    def _save_redirect_sync(self, redirect: dict) -> None:
        with self._redirects_lock:
            rest = [r for r in self._read_redirects() if (r.get("kind"), r.get("slug")) != (redirect["kind"], redirect["slug"])]
            self._write_redirects([*rest, dict(redirect)])

    def _move_redirects_sync(self, from_id: str, to_id: str) -> None:
        with self._redirects_lock:
            items = self._read_redirects()
            if any(r.get("id") == from_id for r in items):
                self._write_redirects([{**r, "id": to_id} if r.get("id") == from_id else r for r in items])

    async def save_redirect(self, key: str, redirect: dict) -> None:
        await asyncio.to_thread(self._save_redirect_sync, redirect)

    async def find_redirect(self, key: str, kind: str, slug: str) -> dict | None:
        items = await asyncio.to_thread(self._read_redirects)
        return next((r for r in items if r.get("kind") == kind and r.get("slug") == slug), None)

    async def move_redirects(self, key: str, from_id: str, to_id: str) -> None:
        await asyncio.to_thread(self._move_redirects_sync, from_id, to_id)

    # --- revisions: one JSON list per entry (hidden like .redirects.json: never a kind, never served) ---

    def _history_file(self, id: str) -> Path | None:
        split = self.split_id(id)
        return self.root / ".revisions" / f"{split[0]}.{split[1]}.json" if split else None

    def _list_revisions_sync(self, id: str) -> list[dict]:
        path = self._history_file(id)
        try:
            parsed = json.loads(path.read_text(encoding="utf-8")) if path else []
        except FileNotFoundError:
            return []
        return [r for r in parsed if isinstance(r, dict)] if isinstance(parsed, list) else []

    def _save_revision_sync(self, id: str, revision: dict, keep: int) -> None:
        path = self._history_file(id)
        if path is None:
            return
        with self._revisions_lock:
            history = [revision, *self._list_revisions_sync(id)][:keep]
            path.parent.mkdir(parents=True, exist_ok=True)
            self._atomic_write(path, json.dumps(history, ensure_ascii=False).encode("utf-8"))

    def _move_revisions_sync(self, from_id: str, to_id: str) -> None:
        src, dst = self._history_file(from_id), self._history_file(to_id)
        if src is None or dst is None or src == dst:
            return
        with self._revisions_lock:
            moved = self._list_revisions_sync(from_id)
            if not moved:
                return
            dst.parent.mkdir(parents=True, exist_ok=True)
            self._atomic_write(dst, json.dumps([*moved, *self._list_revisions_sync(to_id)], ensure_ascii=False).encode("utf-8"))
            src.unlink(missing_ok=True)

    async def save_revision(self, key: str, id: str, revision: dict, keep: int) -> None:
        await asyncio.to_thread(self._save_revision_sync, id, revision, keep)

    async def list_revisions(self, key: str, id: str) -> list[dict]:
        return await asyncio.to_thread(self._list_revisions_sync, id)

    async def move_revisions(self, key: str, from_id: str, to_id: str) -> None:
        await asyncio.to_thread(self._move_revisions_sync, from_id, to_id)

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
