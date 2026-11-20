"""The store contract (four async methods) and an in-memory implementation.

A site provides ``get``, ``list``, ``save`` and ``remove``, all scoped by the API key's
site (``key``). Slug collisions and ``external_id`` lookups are ordinary ``list``
calls with exact filters, so a database-backed store stays trivial to write.

``media`` and ``fetch_media`` are optional: a store that can hold files adds them and
the adapter advertises the ``media`` feature; one that cannot simply omits them.
"""

from __future__ import annotations

import base64
import binascii
import json
import secrets
import string
from dataclasses import dataclass
from typing import Literal, Optional, Protocol, TypedDict, runtime_checkable

from .errors import InkwireError
from .media import validate_image

ContentStatus = Literal["draft", "published"]


class Author(TypedDict, total=False):
    name: str
    email: str


class SeoOverrides(TypedDict, total=False):
    """What the caller overrode. Absent key = derive it from the entry (SEO Profile 1)."""

    title: str
    description: str
    image_url: str
    noindex: bool


class SeoMetadata(TypedDict, total=False):
    """The effective values a renderer consumes."""

    title: str
    description: str
    image_url: str
    noindex: bool


class StoredContent(TypedDict, total=False):
    """The stored shape, shared by every store and by the handlers."""

    id: str
    key: str
    external_id: Optional[str]
    kind: str
    title: str
    slug: str
    markdown: str
    html: str
    excerpt: Optional[str]
    tags: Optional[list[str]]
    cover_image_url: Optional[str]
    canonical_url: Optional[str]
    seo: Optional[SeoOverrides]
    author: Optional[Author]
    status: ContentStatus
    published_at: str
    updated_at: str
    version: int
    etag: str
    url: str


@dataclass
class ListFilter:
    """Everything ``GET /api/content`` can filter on. ``external_id``/``slug`` are exact."""

    status: str | None = None
    kind: str | None = None
    tag: str | None = None
    search: str | None = None
    external_id: str | None = None
    slug: str | None = None
    limit: int = 20
    cursor: str | None = None


@dataclass
class MediaUpload:
    data: bytes
    filename: str
    content_type: str
    alt: str | None = None


@dataclass
class MediaResult:
    id: str
    url: str
    alt: str | None = None

    def as_dict(self) -> dict:
        body: dict = {"id": self.id, "url": self.url}
        if self.alt is not None:
            body["alt"] = self.alt
        return body


@runtime_checkable
class ContentStore(Protocol):
    async def get(self, key: str, id: str) -> StoredContent | None: ...

    async def list(self, key: str, filter: ListFilter) -> tuple[list[StoredContent], str | None]: ...

    async def save(self, key: str, entry: StoredContent) -> StoredContent: ...

    async def remove(self, key: str, id: str) -> bool: ...


# --- shared helpers (both shipped stores use them, so they behave identically) ---

DEFAULT_LIMIT = 20
MAX_LIMIT = 100


def clamp_limit(limit: int | None) -> int:
    if limit is None:
        return DEFAULT_LIMIT
    return max(1, min(MAX_LIMIT, int(limit)))


def encode_cursor(offset: int) -> str:
    raw = json.dumps({"o": int(offset)}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()))
        offset = int(data["o"])
        if offset < 0:
            raise ValueError
        return offset
    except (ValueError, KeyError, TypeError, binascii.Error, UnicodeDecodeError):
        raise InkwireError("invalid_payload", "cursor: invalid cursor") from None


def matches(entry: StoredContent, filter: ListFilter) -> bool:
    if filter.status is not None and entry.get("status") != filter.status:
        return False
    if filter.kind is not None and entry.get("kind") != filter.kind:
        return False
    if filter.external_id is not None and entry.get("external_id") != filter.external_id:
        return False
    if filter.slug is not None and entry.get("slug") != filter.slug:
        return False
    if filter.tag is not None and filter.tag not in (entry.get("tags") or []):
        return False
    if filter.search:
        needle = filter.search.lower()
        haystack = "\n".join(
            [
                entry.get("title") or "",
                entry.get("excerpt") or "",
                entry.get("markdown") or "",
            ]
        ).lower()
        if needle not in haystack:
            return False
    return True


def newest_first(entries: list[StoredContent]) -> list[StoredContent]:
    """Deterministic order: published_at descending, id ascending as the tie-break."""
    ordered = sorted(entries, key=lambda e: str(e.get("id", "")))
    ordered.sort(key=lambda e: str(e.get("published_at", "")), reverse=True)
    return ordered


def paginate(
    entries: list[StoredContent], filter: ListFilter
) -> tuple[list[StoredContent], str | None]:
    offset = decode_cursor(filter.cursor)
    limit = clamp_limit(filter.limit)
    page = entries[offset : offset + limit]
    following = offset + limit
    return page, (encode_cursor(following) if following < len(entries) else None)


def content_id(kind: str, slug: str) -> str:
    """The id FileStore and MemoryStore hand out: stable, URL-path safe, kind-scoped."""
    return f"{kind}:{slug}"


_SAFE_NAME = set(string.ascii_lowercase + string.digits + "._-")


def safe_filename(filename: str, fallback: str = "image") -> str:
    name = (filename or "").replace("\\", "/").rsplit("/", 1)[-1].strip().lower()
    cleaned = "".join(ch if ch in _SAFE_NAME else "-" for ch in name).strip(".-")
    cleaned = cleaned.strip("-") or fallback
    return cleaned[:120]


class MemoryStore:
    """In-memory store for local development and tests."""

    def __init__(self, *, media_url_base: str = "https://inkwire-memory.invalid/media", fetcher=None):
        self._entries: dict[str, StoredContent] = {}
        self._media: dict[str, bytes] = {}
        self._media_meta: dict[str, MediaResult] = {}
        self._media_url_base = media_url_base.rstrip("/")
        self._fetcher = fetcher

    @staticmethod
    def _k(key: str, id: str) -> str:
        return f"{key}\x00{id}"

    async def get(self, key: str, id: str) -> StoredContent | None:
        entry = self._entries.get(self._k(key, id))
        return dict(entry) if entry is not None else None

    async def list(self, key: str, filter: ListFilter) -> tuple[list[StoredContent], str | None]:
        entries = [
            dict(entry)
            for stored_key, entry in self._entries.items()
            if stored_key.startswith(f"{key}\x00") and matches(entry, filter)
        ]
        return paginate(newest_first(entries), filter)

    async def save(self, key: str, entry: StoredContent) -> StoredContent:
        entry_id = content_id(entry["kind"], entry["slug"])
        previous_id = entry.get("id") or entry_id
        version = int(entry.get("version") or 1)
        saved: StoredContent = {
            **entry,
            "key": key,
            "id": entry_id,
            "version": version,
            "etag": entry.get("etag") or f'"{entry_id}-{version}"',
        }
        if previous_id != entry_id:
            self._entries.pop(self._k(key, previous_id), None)
        self._entries[self._k(key, entry_id)] = saved
        return dict(saved)

    async def remove(self, key: str, id: str) -> bool:
        return self._entries.pop(self._k(key, id), None) is not None

    async def media(self, key: str, upload: MediaUpload) -> MediaResult:
        hex_id = secrets.token_hex(8)
        result = MediaResult(
            id=hex_id, url=f"{self._media_url_base}/{hex_id}-{safe_filename(upload.filename)}", alt=upload.alt
        )
        self._media[result.id] = upload.data
        self._media_meta[result.id] = result
        return result

    async def fetch_media(self, key: str, url: str, alt: str | None = None) -> MediaResult:
        if self._fetcher is None:
            raise InkwireError("internal", "this store cannot fetch remote media")
        data, filename, content_type = await fetch_media_bytes(self._fetcher, url)
        sniffed = validate_image(data, filename=filename, content_type=content_type)
        return await self.media(
            key, MediaUpload(data=data, filename=filename, content_type=sniffed, alt=alt)
        )

    def media_bytes(self, id: str) -> bytes | None:
        return self._media.get(id)


async def fetch_media_bytes(fetcher, url: str) -> tuple[bytes, str, str]:
    """Fetch through the caller's guarded fetcher; normalize the (bytes, name, type) result."""
    result = fetcher(url)
    if hasattr(result, "__await__"):
        result = await result
    if isinstance(result, tuple):
        data, filename, content_type = result
        return bytes(data), str(filename), str(content_type)
    response = result
    if getattr(response, "status_code", 200) >= 400:
        raise InkwireError("invalid_payload", f"media: could not fetch {url}")
    data = response.content
    content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
    filename = url.rsplit("/", 1)[-1].split("?", 1)[0] or "image"
    return bytes(data), filename, content_type


__all__ = [
    "Author",
    "ContentStatus",
    "ContentStore",
    "DEFAULT_LIMIT",
    "ListFilter",
    "MAX_LIMIT",
    "MediaResult",
    "MediaUpload",
    "MemoryStore",
    "SeoMetadata",
    "SeoOverrides",
    "StoredContent",
    "clamp_limit",
    "content_id",
    "decode_cursor",
    "encode_cursor",
    "matches",
    "newest_first",
    "paginate",
    "safe_filename",
    "fetch_media_bytes",
]
