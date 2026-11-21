"""The store contract (four async methods) and an in-memory implementation.

A site provides ``get``, ``list``, ``save`` and ``remove``, all scoped by the API key's
site (``key``). Slug collisions and ``external_id`` lookups are ordinary ``list``
calls with exact filters, so a database-backed store stays trivial to write.

The media methods are optional and each one switches on a discovery feature:

- ``media`` (and ``fetch_media`` for ``{url}`` uploads): the store can save files -> ``media``
- ``list_media``: the store can list them, newest first (``recency_key`` / ``page_of``) -> ``media_list``
- ``update_media``: the store can change a file's ``alt`` / ``title`` -> ``media_update``

A store that cannot do one simply omits the method and the receiver omits the feature.
"""

from __future__ import annotations

import base64
import binascii
import json
import secrets
import string
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Callable, TypeVar
from urllib.parse import unquote
from typing import Literal, Optional, Protocol, TypedDict, runtime_checkable

from .errors import InkwireError
from .media import image_size, validate_image

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
    og_title: str
    og_description: str
    json_ld: str


class SeoMetadata(TypedDict, total=False):
    """The effective values a renderer consumes."""

    title: str
    description: str
    image_url: str
    noindex: bool
    og_title: str
    og_description: str
    json_ld: str


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
    categories: Optional[list[str]]
    cover_image_url: Optional[str]
    cover_image_alt: Optional[str]
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
    category: str | None = None
    search: str | None = None
    external_id: str | None = None
    slug: str | None = None
    limit: int = 20
    cursor: str | None = None


@dataclass
class MediaListFilter:
    """``GET /api/media``: ``search`` matches alt, title and filename (case-insensitive)."""

    search: str | None = None
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
    """One media item as the wire shows it: ``{id, url, alt?, title?, mime_type, created_at}``."""

    id: str
    url: str
    alt: str | None = None
    title: str | None = None
    mime_type: str = ""
    created_at: str = ""
    width: int | None = None
    height: int | None = None

    def as_dict(self) -> dict:
        body: dict = {"id": self.id, "url": self.url}
        if self.alt is not None:
            body["alt"] = self.alt
        if self.title is not None:
            body["title"] = self.title
        body["mime_type"] = self.mime_type
        if self.width and self.height:
            body["width"], body["height"] = self.width, self.height
        body["created_at"] = self.created_at
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
_MAX_TIME_MS = 8_640_000_000_000_000

T = TypeVar("T")


def clamp_limit(limit: int | None) -> int:
    if limit is None:
        return DEFAULT_LIMIT
    return max(1, min(MAX_LIMIT, int(limit)))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _millis(moment: str | None) -> int:
    try:
        parsed = datetime.fromisoformat(str(moment).replace("Z", "+00:00").replace("z", "+00:00"))
    except ValueError:
        return 0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def recency_key(moment: str | None, id: str) -> str:
    """Newest first, then id: a sort key that works as a plain ascending string."""
    return f"{_MAX_TIME_MS - _millis(moment):017d}|{id}"


def encode_cursor(key: str) -> str:
    raw = json.dumps({"k": key}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> str:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()))
        if isinstance(data, dict) and isinstance(data.get("k"), str):
            return data["k"]
    except (ValueError, binascii.Error, UnicodeDecodeError):
        pass
    raise InkwireError("invalid_payload", "cursor: not a cursor this receiver issued")


def page_of(
    items: list[T], key_of: Callable[[T], str], limit: int, cursor: str | None = None
) -> tuple[list[T], str | None]:
    """Keyset page over ``items`` already sorted ascending by ``key_of``.

    The page starts after the cursor's key, so an entry added or removed between two pages never
    repeats or skips its neighbours.
    """
    after = decode_cursor(cursor) if cursor else None
    rest = items if after is None else [item for item in items if key_of(item) > after]
    page = rest[: clamp_limit(limit)]
    more = len(rest) > len(page)
    return page, (encode_cursor(key_of(page[-1])) if more and page else None)


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
    if filter.category is not None and filter.category not in (entry.get("categories") or []):
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


def entry_key(entry: StoredContent) -> str:
    return recency_key(entry.get("updated_at"), str(entry.get("id", "")))


def paginate(
    entries: list[StoredContent], filter: ListFilter
) -> tuple[list[StoredContent], str | None]:
    """Order newest first (``updated_at`` descending, ties by ``id``) and cut one keyset page."""
    return page_of(sorted(entries, key=entry_key), entry_key, filter.limit, filter.cursor)


def media_matches(item: MediaResult, search: str | None) -> bool:
    """``search`` matches the alt text, the title and the filename (the last segment of the url)."""
    if not search:
        return True
    filename = unquote(item.url.rsplit("/", 1)[-1])
    haystack = "\n".join([item.alt or "", item.title or "", filename]).lower()
    return search.lower() in haystack


def media_key(item: MediaResult) -> str:
    return recency_key(item.created_at, item.id)


def paginate_media(items: list[MediaResult], filter: MediaListFilter) -> tuple[list[MediaResult], str | None]:
    """Filter, order (newest first by ``created_at``, ties by ``id``) and page a set of media."""
    found = sorted((item for item in items if media_matches(item, filter.search)), key=media_key)
    return page_of(found, media_key, filter.limit, filter.cursor)


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
        self._media_meta: dict[str, MediaResult] = {}  # keyed by (key, id)
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
        return paginate(entries, filter)

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
        size = image_size(upload.data, upload.content_type) or (None, None)
        result = MediaResult(
            id=hex_id,
            url=f"{self._media_url_base}/{hex_id}-{safe_filename(upload.filename)}",
            alt=upload.alt,
            mime_type=upload.content_type,
            created_at=now_iso(),
            width=size[0],
            height=size[1],
        )
        self._media[hex_id] = upload.data
        self._media_meta[self._k(key, hex_id)] = result
        return replace(result)

    async def list_media(self, key: str, filter: MediaListFilter) -> tuple[list[MediaResult], str | None]:
        own = [replace(item) for stored_key, item in self._media_meta.items() if stored_key.startswith(f"{key}\x00")]
        return paginate_media(own, filter)

    async def update_media(self, key: str, id: str, patch: dict) -> MediaResult | None:
        """``patch`` holds only the fields to change; a ``None`` value clears that field."""
        item = self._media_meta.get(self._k(key, id))
        if item is None:
            return None
        for name in ("alt", "title"):
            if name in patch:
                setattr(item, name, patch[name])
        return replace(item)

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
    "MediaListFilter",
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
    "entry_key",
    "matches",
    "media_key",
    "media_matches",
    "now_iso",
    "page_of",
    "paginate",
    "paginate_media",
    "recency_key",
    "safe_filename",
    "fetch_media_bytes",
]
