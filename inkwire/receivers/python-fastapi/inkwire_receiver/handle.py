"""One handler per endpoint. Every response carries ``Inkwire-Version: 1``.

Each handler returns ``(status, headers, body)`` and never raises for a client error: the
protocol error shape is built here, so an adapter only has to turn the tuple into a response.
"""

from __future__ import annotations

import json
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

from pydantic import ValidationError

from .auth import ApiKey, authorize, require_write
from .errors import InkwireError
from .media import validate_image
from .render import render_markdown, size_images, slugify
from .schema import ContentInput, MediaPatchInput, MediaUrlInput, PatchInput, RestoreInput, validation_message
from .seo import effective_seo, merge_overrides, overrides_from_input
from .seo_warnings import seo_warnings
from .store import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    ContentStore,
    ListFilter,
    MediaListFilter,
    MediaResult,
    MediaUpload,
    StoredContent,
    StoredRevision,
    content_id,
)

VERSION_HEADER = ("Inkwire-Version", "1")
DEFAULT_KINDS = ("post", "page")
KNOWN_FEATURES = (
    "upsert",
    "list",
    "get",
    "update",
    "delete",
    "terms",
    "schedule",
    "media",
    "media_url",
    "media_list",
    "media_update",
    "revisions",
    "warnings",
    "redirects",
    "translations",
)
MAX_SLUG_LENGTH = 255
TERMS_DEFAULT_LIMIT = 100
TERMS_MAX_LIMIT = 500
TERMS_SCAN_CAP = 10_000
TERM_KINDS = ("tag", "category")
# Entries read per write to check duplicates and links, and media read to size images.
# ponytail: full scans; a store with a url lookup or an index would skip them.
WARN_SCAN_CAP = 2_000
SIZE_SCAN_CAP = 2_000

Response = tuple[int, dict[str, str], dict]


@dataclass
class Site:
    name: str | None = None
    url: str | None = None
    description: str | None = None
    language: str | None = None


@dataclass
class Limits:
    markdown_bytes: int | None = None
    media_bytes: int | None = None
    #: How many past versions an entry keeps (feature ``revisions``), default 50.
    revisions: int | None = None


@dataclass
class InkwireConfig:
    """What the adapter tells the core about its site.

    The advertised features come from the store (media, media_list, media_update) and from
    ``schedule``: set it only when the site really holds a ``published`` entry with a future
    ``published_at`` back until that time. The file store has no renderer, so it does not.
    """

    site: Site | None = None
    kinds: list[str] = field(default_factory=lambda: list(DEFAULT_KINDS))
    limits: Limits | None = None
    schedule: bool = False
    url_for: Callable[[StoredContent], str] | None = None


# --- response helpers -------------------------------------------------------


def _headers(extra: Mapping[str, str] | None = None) -> dict[str, str]:
    headers = {VERSION_HEADER[0]: VERSION_HEADER[1]}
    if extra:
        headers.update({k: v for k, v in extra.items() if v is not None})
    return headers


def _ok(body: dict, extra: Mapping[str, str] | None = None) -> Response:
    return 200, _headers(extra), body


def _error(error: InkwireError) -> Response:
    return error.http_status, _headers(), {"error": {"code": error.code, "message": error.message}}


def _handle_errors(fn):
    """Decorator: an adapter call never sees a client error as an exception."""

    async def wrapper(*args, **kwargs) -> Response:
        try:
            return await fn(*args, **kwargs)
        except InkwireError as error:
            return _error(error)
        except Exception:  # noqa: BLE001 - the protocol's 500 shape, never a stack trace to a caller
            return _error(InkwireError("internal", "unexpected error"))

    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_json(raw_body: Any) -> Any:
    """Accept already-parsed JSON or the raw string/bytes an adapter forwards untouched."""
    if isinstance(raw_body, (bytes, bytearray, memoryview)):
        raw_body = bytes(raw_body)
        if not raw_body.strip():
            raise InkwireError("invalid_payload", "body: empty request body")
        try:
            raw_body = raw_body.decode("utf-8")
        except UnicodeDecodeError:
            raise InkwireError("invalid_payload", "body: malformed JSON") from None
    if isinstance(raw_body, str):
        if not raw_body.strip():
            raise InkwireError("invalid_payload", "body: empty request body")
        try:
            return json.loads(raw_body)
        except ValueError:
            raise InkwireError("invalid_payload", "body: malformed JSON") from None
    return raw_body


def _validate(model, raw_body: Any):
    body = _parse_json(raw_body)
    try:
        return model.model_validate(body)
    except ValidationError as exc:
        raise InkwireError("invalid_payload", validation_message(exc)) from None


def _query_value(query: Any, name: str) -> str | None:
    value = query.get(name) if hasattr(query, "get") else None
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def _query_limit(query: Any, default: int, maximum: int) -> int:
    """``limit``: a positive integer, clamped to ``maximum``; anything else is a 400."""
    raw = _query_value(query, "limit")
    if raw is None:
        return default
    try:
        parsed = int(raw)
    except ValueError:
        raise InkwireError("invalid_payload", "limit: must be a positive integer") from None
    if parsed < 1:
        raise InkwireError("invalid_payload", "limit: must be a positive integer")
    return min(parsed, maximum)


# --- config helpers ---------------------------------------------------------


def _kinds(config: InkwireConfig | None) -> list[str]:
    if config and config.kinds:
        return list(config.kinds)
    return ["post"]


def _require_kind(kind: str, config: InkwireConfig | None) -> str:
    if kind not in _kinds(config):
        raise InkwireError("invalid_payload", f"kind: '{kind}' is not held by this receiver")
    return kind


def _check_markdown(markdown: str, config: InkwireConfig | None) -> None:
    limit = config.limits.markdown_bytes if config and config.limits else None
    if limit and len(markdown.encode("utf-8")) > limit:
        raise InkwireError("too_large", f"markdown: over the receiver's limit of {limit} bytes")


def _media_limit(config: InkwireConfig | None) -> int | None:
    return config.limits.media_bytes if config and config.limits else None


def public_url(entry: StoredContent, config: InkwireConfig | None = None) -> str:
    """The entry's public URL: the store's own, the adapter's hook, or the default layout."""
    if entry.get("url"):
        return str(entry["url"])
    if config and config.url_for is not None:
        return config.url_for(entry)
    base = (config.site.url if config and config.site and config.site.url else "").rstrip("/")
    kind, slug = entry.get("kind", "post"), entry.get("slug", "")
    if kind == "post":
        path = f"/blog/{slug}"
    elif kind == "page":
        path = f"/{slug}"
    else:
        path = f"/{kind}/{slug}"
    return base + path


def _summary(entry: StoredContent, config: InkwireConfig | None) -> dict:
    summary = {
        "id": entry.get("id", ""),
        "external_id": entry.get("external_id"),
        "kind": entry.get("kind", "post"),
        "title": entry.get("title", ""),
        "slug": entry.get("slug", ""),
        "url": public_url(entry, config),
        "status": entry.get("status", "draft"),
        "excerpt": entry.get("excerpt"),
        "tags": list(entry.get("tags") or []),
        "published_at": entry.get("published_at"),
        "updated_at": entry.get("updated_at"),
    }
    if entry.get("categories") is not None:  # absent, not [], once cleared or never set
        summary["categories"] = list(entry["categories"])
    for name in ("lang", "translation_key"):
        if entry.get(name):
            summary[name] = entry[name]
    return summary


def _full(entry: StoredContent, config: InkwireConfig | None) -> dict:
    body = _summary(entry, config)
    body.update(
        {
            "markdown": entry.get("markdown", ""),
            "html": entry.get("html") or render_markdown(entry.get("markdown", "")),
            "cover_image_url": entry.get("cover_image_url"),
            "cover_image_alt": entry.get("cover_image_alt"),
            "canonical_url": entry.get("canonical_url"),
            "author": entry.get("author"),
            "seo": effective_seo(entry),
        }
    )
    return body


def entry_etag(entry: StoredContent) -> str:
    return entry.get("etag") or f'"{entry.get("id", "")}-{int(entry.get("version") or 1)}"'


def _etag_matches(if_match: str | None, entry: StoredContent) -> bool:
    if if_match is None or not if_match.strip():
        return True

    def normalize(value: str) -> str:
        token = value.strip()
        if token.startswith("W/"):
            token = token[2:].strip()
        return token.strip('"')

    current = normalize(entry_etag(entry))
    for candidate in if_match.split(","):
        token = candidate.strip()
        if token == "*" or normalize(token) == current:
            return True
    return False


async def _find_one(store: ContentStore, key: str, **filters) -> StoredContent | None:
    items, _ = await store.list(key, ListFilter(limit=1, **filters))
    return items[0] if items else None


async def _unique_slug(store: ContentStore, key: str, kind: str, title: str) -> str:
    base = slugify(title)
    slug = base
    suffix_number = 1
    while await _find_one(store, key, kind=kind, slug=slug):
        suffix_number += 1
        suffix = f"-{suffix_number}"
        slug = base[: MAX_SLUG_LENGTH - len(suffix)] + suffix
    return slug


def _store_supports(store: ContentStore, method: str) -> bool:
    return callable(getattr(store, method, None))


# --- dry runs, redirects, translations, warnings ----------------------------


def _dry_run(query: Any) -> bool:
    raw = query.get("dry_run") if query is not None and hasattr(query, "get") else None
    if raw is None or raw == "false":
        return False
    if raw in ("true", ""):
        return True
    raise InkwireError("invalid_payload", 'dry_run must be "true" or "false"')


def _has_redirects(store: ContentStore) -> bool:
    return all(_store_supports(store, m) for m in ("save_redirect", "find_redirect", "move_redirects"))


# Revisions: every write that replaces an entry (update, restore, delete) first keeps the version it
# replaces, so the first edit of a page that predates Inkwire is undoable too.

DEFAULT_KEEP_REVISIONS = 50


def _has_revisions(store: ContentStore) -> bool:
    return all(_store_supports(store, m) for m in ("save_revision", "list_revisions", "move_revisions"))


def _keep(config: InkwireConfig | None) -> int:
    limit = config.limits.revisions if config and config.limits and config.limits.revisions else DEFAULT_KEEP_REVISIONS
    return max(1, int(limit))


async def _keep_revision(store: ContentStore, key: str, entry: StoredContent, by: str, config: InkwireConfig | None) -> None:
    if not _has_revisions(store):
        return
    was = {k: v for k, v in entry.items() if k != "key"}
    revision = f"{_base36(int(time.time() * 1000))}{secrets.token_hex(4)}"
    stored: StoredRevision = {"revision": revision, "created_at": _now(), "replaced_by": by, "entry": was}
    await store.save_revision(key, entry["id"], stored, _keep(config))  # type: ignore[attr-defined]


def _base36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out or "0"


async def _follow_move(store: ContentStore, key: str, from_id: str, to_id: str) -> None:
    """A store whose ids follow the kind and slug moved the entry: its history and redirects go with it."""
    if from_id == to_id:
        return
    if _has_revisions(store):
        await store.move_revisions(key, from_id, to_id)  # type: ignore[attr-defined]
    if _has_redirects(store):
        await store.move_redirects(key, from_id, to_id)  # type: ignore[attr-defined]


def _revision_summary(r: StoredRevision) -> dict:
    e = r.get("entry") or {}
    return {
        "revision": r["revision"],
        "created_at": r["created_at"],
        "replaced_by": r["replaced_by"],
        "kind": e.get("kind"),
        "slug": e.get("slug"),
        "title": e.get("title"),
        "status": e.get("status"),
    }


def _require_revisions(store: ContentStore) -> None:
    if not _has_revisions(store):
        raise InkwireError("not_found", "this receiver keeps no revisions")


async def _after_move(store: ContentStore, key: str, before: StoredContent, saved: StoredContent) -> None:
    """After a save that replaced ``before``: history and redirects follow the id, the old address redirects."""
    await _follow_move(store, key, before["id"], saved["id"])
    if not _has_redirects(store):
        return
    if before.get("kind") != saved.get("kind") or before.get("slug") != saved.get("slug"):
        await store.save_redirect(  # type: ignore[attr-defined]
            key, {"kind": before["kind"], "slug": before["slug"], "id": saved["id"], "created_at": _now()}
        )


def _require_translations(store: ContentStore, body: Any) -> None:
    if not getattr(store, "translations", False) and isinstance(body, dict) and ("lang" in body or "translation_key" in body):
        raise InkwireError("invalid_payload", "this receiver does not store translations: unknown field lang, translation_key")


async def _render(store: ContentStore, key: str, markdown: str) -> str:
    """Sanitized HTML, with ``width``/``height`` on images from the media library."""
    html = render_markdown(markdown)
    if "<img" not in html or not _store_supports(store, "list_media"):
        return html
    sizes: dict[str, tuple[int, int]] = {}
    cursor: str | None = None
    seen = 0
    while seen < SIZE_SCAN_CAP:
        items, cursor = await store.list_media(key, MediaListFilter(limit=MAX_LIMIT, cursor=cursor))  # type: ignore[attr-defined]
        for item in items:
            if item.width and item.height:
                sizes[item.url] = (item.width, item.height)
        seen += len(items)
        if not cursor or not items:
            break
    return size_images(html, sizes)


async def _site_entries(store: ContentStore, key: str, config: InkwireConfig | None, except_id: str | None) -> list[StoredContent]:
    out: list[StoredContent] = []
    cursor: str | None = None
    while len(out) < WARN_SCAN_CAP:
        items, cursor = await store.list(key, ListFilter(limit=MAX_LIMIT, cursor=cursor))
        out.extend({**item, "url": public_url(item, config)} for item in items if item.get("id") != except_id)
        if not cursor or not items:
            break
    return out


async def _warnings(store: ContentStore, key: str, config: InkwireConfig | None, entry: StoredContent, except_id: str | None) -> list[dict]:
    redirects = None
    if _has_redirects(store):
        async def redirects(kind: str, slug: str) -> bool:
            return bool(await store.find_redirect(key, kind, slug))  # type: ignore[attr-defined]

    site_url = config.site.url if config and config.site else None
    others = await _site_entries(store, key, config, except_id)
    return await seo_warnings(entry, site_url=site_url, others=others, redirects=redirects)


def _place(entry: StoredContent, before: StoredContent | None, config: InkwireConfig | None) -> str:
    """Where the entry will live: its own address if it stays put, else the one the config gives it."""
    if before is not None and before.get("kind") == entry.get("kind") and before.get("slug") == entry.get("slug"):
        return public_url(before, config)
    return public_url({k: v for k, v in entry.items() if k != "url"}, config)  # type: ignore[arg-type]


# --- POST /api/content ------------------------------------------------------


@_handle_errors
async def handle_upsert(
    *,
    auth_header: str | None,
    raw_body: Any,
    keys: list,
    store: ContentStore,
    config: InkwireConfig | None = None,
    query: Any = None,
) -> Response:
    """Create or update one entry, upserting on ``(key, kind, external_id)``.

    ``?dry_run=true``: validate and answer as the write would, with its warnings, writing nothing
    (a read-only key may ask)."""
    dry_run = _dry_run(query)
    api_key = authorize(auth_header, keys)
    if not dry_run:
        require_write(api_key)
    key = api_key.scope

    body = _parse_json(raw_body)
    _require_translations(store, body)
    payload = _validate(ContentInput, body)
    _require_kind(payload.kind, config)
    _check_markdown(payload.markdown, config)

    existing = await _find_one(store, key, kind=payload.kind, external_id=payload.external_id)

    if payload.slug is not None:
        owner = await _find_one(store, key, kind=payload.kind, slug=payload.slug)
        if owner is not None and (existing is None or owner.get("id") != existing.get("id")):
            raise InkwireError("conflict", f"slug: '{payload.slug}' is already used by another entry")
        slug = payload.slug
    elif existing is not None:
        slug = existing["slug"]
    else:
        slug = await _unique_slug(store, key, payload.kind, payload.title)

    now = _now()
    entry: StoredContent = {
        "id": (existing or {}).get("id") or content_id(payload.kind, slug),
        "key": key,
        "external_id": payload.external_id,
        "kind": payload.kind,
        "title": payload.title,
        "slug": slug,
        "markdown": payload.markdown,
        "html": await _render(store, key, payload.markdown),
        "excerpt": payload.excerpt,
        "tags": payload.tags,
        "categories": payload.categories,
        "cover_image_url": payload.cover_image_url,
        "cover_image_alt": payload.cover_image_alt,
        "canonical_url": payload.canonical_url,
        "seo": overrides_from_input(payload.seo),
        "author": (payload.author.model_dump(exclude_none=True) or None) if payload.author else None,
        "lang": payload.lang,
        "translation_key": payload.translation_key,
        "status": payload.status,
        "published_at": payload.published_at or (existing or {}).get("published_at") or now,
        "updated_at": now,
        "version": int((existing or {}).get("version") or 0) + 1,
    }
    url = _place(entry, existing, config)
    warnings = await _warnings(store, key, config, {**entry, "url": url}, (existing or {}).get("id"))
    if dry_run:
        return _ok(
            {
                "id": (existing or {}).get("id"),
                "external_id": payload.external_id,
                "url": url,
                "slug": slug,
                "kind": payload.kind,
                "status": payload.status,
                "created": existing is None,
                "dry_run": True,
                "warnings": warnings,
            }
        )
    if existing is not None:
        await _keep_revision(store, key, existing, "update", config)
    saved = await store.save(key, entry)
    if existing is not None:
        await _after_move(store, key, existing, saved)
    return _ok(
        {
            "id": saved.get("id", ""),
            "external_id": payload.external_id,
            "url": public_url(saved, config),
            "slug": saved.get("slug", slug),
            "kind": saved.get("kind", payload.kind),
            "status": saved.get("status", payload.status),
            "created": existing is None,
            "warnings": warnings,
        }
    )


# --- GET /api/content -------------------------------------------------------


@_handle_errors
async def handle_list(
    *,
    auth_header: str | None,
    query: Any,
    keys: list,
    store: ContentStore,
    config: InkwireConfig | None = None,
) -> Response:
    """List entries: ``status``, ``kind``, ``tag``, ``category``, ``search``, ``external_id``, ``slug``, ``limit``, ``cursor``."""
    api_key = authorize(auth_header, keys)
    key = api_key.scope

    if not getattr(store, "translations", False) and (_query_value(query, "lang") or _query_value(query, "translation_key")):
        raise InkwireError("invalid_payload", "this receiver does not store translations: lang and translation_key are not filters here")
    status = _query_value(query, "status")
    if status is not None and status not in ("draft", "published"):
        raise InkwireError("invalid_payload", "status: must be 'draft' or 'published'")

    list_filter = ListFilter(
        status=status,
        kind=_query_value(query, "kind"),
        tag=_query_value(query, "tag"),
        category=_query_value(query, "category"),
        search=_query_value(query, "search"),
        external_id=_query_value(query, "external_id"),
        slug=_query_value(query, "slug"),
        lang=_query_value(query, "lang"),
        translation_key=_query_value(query, "translation_key"),
        limit=_query_limit(query, DEFAULT_LIMIT, MAX_LIMIT),
        cursor=_query_value(query, "cursor"),
    )
    items, next_cursor = await store.list(key, list_filter)
    return _ok({"items": [_summary(item, config) for item in items], "next_cursor": next_cursor})


# --- GET /api/content/{id} --------------------------------------------------


@_handle_errors
async def handle_get(
    *,
    auth_header: str | None,
    id: str,
    keys: list,
    store: ContentStore,
    config: InkwireConfig | None = None,
) -> Response:
    """One full entry, its effective ``seo`` and an ``ETag``."""
    api_key = authorize(auth_header, keys)
    entry = await store.get(api_key.scope, str(id))
    if entry is None:
        raise InkwireError("not_found", f"no content with id '{id}'")
    return _ok(_full(entry, config), {"ETag": entry_etag(entry)})


# --- PATCH /api/content/{id} ------------------------------------------------


@_handle_errors
async def handle_patch(
    *,
    auth_header: str | None,
    id: str,
    raw_body: Any,
    if_match: str | None = None,
    keys: list,
    store: ContentStore,
    config: InkwireConfig | None = None,
    query: Any = None,
) -> Response:
    """Edit part of an entry; ``If-Match`` makes concurrent edits safe (412, nothing written).

    ``?dry_run=true``: the entry as the edit would make it, with its warnings, nothing written (no ETag)."""
    dry_run = _dry_run(query)
    api_key = authorize(auth_header, keys)
    if not dry_run:
        require_write(api_key)
    key = api_key.scope

    body = _parse_json(raw_body)
    _require_translations(store, body)
    payload = _validate(PatchInput, body)
    sent = payload.model_fields_set

    existing = await store.get(key, str(id))
    if existing is None:
        raise InkwireError("not_found", f"no content with id '{id}'")
    if not _etag_matches(if_match, existing):
        raise InkwireError("stale", "If-Match no longer matches: the entry changed since you read it")

    target_kind = payload.kind if "kind" in sent and payload.kind is not None else existing.get("kind", "post")
    _require_kind(target_kind, config)
    target_slug = payload.slug if "slug" in sent and payload.slug is not None else existing.get("slug", "")

    if "kind" in sent or "slug" in sent:
        owner = await _find_one(store, key, kind=target_kind, slug=target_slug)
        if owner is not None and owner.get("id") != existing.get("id"):
            raise InkwireError("conflict", f"slug: '{target_slug}' is already used by another entry")

    markdown = payload.markdown if "markdown" in sent and payload.markdown is not None else existing.get("markdown", "")
    _check_markdown(markdown, config)

    now = _now()
    entry: StoredContent = {
        **existing,
        "kind": target_kind,
        "slug": target_slug,
        "markdown": markdown,
        "html": await _render(store, key, markdown),
        "updated_at": now,
        "version": int(existing.get("version") or 1) + 1,
    }
    for name in (
        "title",
        "excerpt",
        "tags",
        "categories",
        "cover_image_url",
        "cover_image_alt",
        "canonical_url",
        "lang",
        "translation_key",
        "status",
    ):
        if name in sent:
            entry[name] = getattr(payload, name)  # type: ignore[literal-required]
    if "author" in sent:
        entry["author"] = (payload.author.model_dump(exclude_none=True) or None) if payload.author else None
    if "seo" in sent:
        entry["seo"] = merge_overrides(existing.get("seo"), payload.seo)
    if "published_at" in sent:
        entry["published_at"] = payload.published_at or now

    entry.pop("etag", None)  # the store issues the new ETag for the new bytes
    url = _place(entry, existing, config)
    warnings = await _warnings(store, key, config, {**entry, "url": url}, existing.get("id"))
    if dry_run:
        return _ok({**_full({**entry, "url": url}, config), "dry_run": True, "warnings": warnings})
    await _keep_revision(store, key, existing, "update", config)
    saved = await store.save(key, entry)
    await _after_move(store, key, existing, saved)
    return _ok({**_full(saved, config), "warnings": warnings}, {"ETag": entry_etag(saved)})


# --- DELETE /api/content/{id} ----------------------------------------------


@_handle_errors
async def handle_delete(
    *,
    auth_header: str | None,
    id: str,
    if_match: str | None = None,
    keys: list,
    store: ContentStore,
    config: InkwireConfig | None = None,
) -> Response:
    """Remove the entry (it must stop being public); honours ``If-Match``. The removed version is
    kept first (feature ``revisions``), so a delete can be undone."""
    api_key = authorize(auth_header, keys)
    require_write(api_key)
    key = api_key.scope

    existing = await store.get(key, str(id))
    if existing is None:
        raise InkwireError("not_found", f"no content with id '{id}'")
    if not _etag_matches(if_match, existing):
        raise InkwireError("stale", "If-Match no longer matches: the entry changed since you read it")
    await _keep_revision(store, key, existing, "delete", config)
    removed = await store.remove(key, str(id))
    if not removed:
        raise InkwireError("not_found", f"no content with id '{id}'")
    return _ok({"id": str(id), "deleted": True})


# --- GET /api/content/{id}/revisions[/{revision}]  (feature ``revisions``) ---


@_handle_errors
async def handle_revisions(*, auth_header: str | None, id: str, keys: list, store: ContentStore) -> Response:
    """The past versions of an entry, newest first (a deleted entry's too)."""
    api_key = authorize(auth_header, keys)
    _require_revisions(store)
    items = await store.list_revisions(api_key.scope, str(id))  # type: ignore[attr-defined]
    if not items and await store.get(api_key.scope, str(id)) is None:
        raise InkwireError("not_found", f"no content with id '{id}'")
    return _ok({"items": [_revision_summary(r) for r in items]})


@_handle_errors
async def handle_revision(
    *, auth_header: str | None, id: str, revision: str, keys: list, store: ContentStore, config: InkwireConfig | None = None
) -> Response:
    """One past version in full, with its effective ``seo``."""
    api_key = authorize(auth_header, keys)
    _require_revisions(store)
    found = next((r for r in await store.list_revisions(api_key.scope, str(id)) if r["revision"] == revision), None)  # type: ignore[attr-defined]
    if found is None:
        raise InkwireError("not_found", f"no revision '{revision}' of entry '{id}'")
    return _ok({**_revision_summary(found), "entry": _full({**found["entry"], "key": api_key.scope}, config)})


# --- POST /api/content/{id}/restore  (feature ``revisions``) ----------------


@_handle_errors
async def handle_restore(
    *,
    auth_header: str | None,
    id: str,
    raw_body: Any,
    if_match: str | None = None,
    keys: list,
    store: ContentStore,
    config: InkwireConfig | None = None,
) -> Response:
    """Make the entry what it was at ``revision``: a new write (the version it replaces is kept, so a
    restore is undoable too). Brings a deleted entry back. ``If-Match`` is checked against the current entry."""
    api_key = authorize(auth_header, keys)
    require_write(api_key)
    _require_revisions(store)
    payload = _validate(RestoreInput, raw_body)
    key = api_key.scope

    current = await store.get(key, str(id))
    if current is not None and not _etag_matches(if_match, current):
        raise InkwireError("stale", "If-Match no longer matches: the entry changed since you read it")
    found = next((r for r in await store.list_revisions(key, str(id)) if r["revision"] == payload.revision), None)  # type: ignore[attr-defined]
    if found is None:
        raise InkwireError("not_found", f"no revision '{payload.revision}' of entry '{id}'")
    was = found["entry"]
    _require_kind(was["kind"], config)
    self_id = (current or {}).get("id") or str(id)
    owner = await _find_one(store, key, kind=was["kind"], slug=was["slug"])
    if owner is not None and owner.get("id") != self_id:
        raise InkwireError("conflict", f"slug: '{was['slug']}' is already used by another entry")
    if was.get("external_id") is not None:
        other = await _find_one(store, key, kind=was["kind"], external_id=was["external_id"])
        if other is not None and other.get("id") != self_id:
            raise InkwireError("conflict", f"external_id '{was['external_id']}' is now used by another entry ({other['id']})")

    if current is not None:
        await _keep_revision(store, key, current, "restore", config)
    fields = {k: v for k, v in was.items() if k not in ("id", "url", "etag", "version", "updated_at", "key")}
    entry: StoredContent = {
        **fields,  # type: ignore[typeddict-item]
        "id": self_id,
        "key": key,
        # Rendered again: the sanitizer in force now applies, not the one at the time.
        "html": await _render(store, key, was.get("markdown") or ""),
        "updated_at": _now(),
        "version": max(int((current or {}).get("version") or 0), int(was.get("version") or 0)) + 1,
    }
    saved = await store.save(key, entry)
    if current is not None:
        await _after_move(store, key, current, saved)
    else:
        await _follow_move(store, key, self_id, saved["id"])
    warnings = await _warnings(store, key, config, {**saved, "url": public_url(saved, config)}, saved["id"])
    return _ok({**_full(saved, config), "warnings": warnings}, {"ETag": entry_etag(saved)})


# --- GET /api/redirects -----------------------------------------------------


@_handle_errors
async def handle_redirect(
    *,
    auth_header: str | None,
    query: Any,
    keys: list,
    store: ContentStore,
    config: InkwireConfig | None = None,
) -> Response:
    """Where an old address (``kind``, ``slug``) leads now (feature ``redirects``)."""
    api_key = authorize(auth_header, keys)
    if not _has_redirects(store):
        raise InkwireError("not_found", "this receiver keeps no redirects")
    kind = _query_value(query, "kind") or "post"
    slug = _query_value(query, "slug")
    if not slug:
        raise InkwireError("invalid_payload", "slug is required")
    if await _find_one(store, api_key.scope, kind=kind, slug=slug):
        raise InkwireError("not_found", f"an entry lives at {kind}/{slug}: nothing redirects from there")
    redirect = await store.find_redirect(api_key.scope, kind, slug)  # type: ignore[attr-defined]
    entry = await store.get(api_key.scope, redirect["id"]) if redirect else None
    if entry is None:
        raise InkwireError("not_found", f"nothing redirects from {kind}/{slug}")
    return _ok({"kind": kind, "slug": slug, "id": entry["id"], "url": public_url(entry, config), "status": entry.get("status", "draft")})


# --- GET /api/terms ---------------------------------------------------------


async def _scan_terms(store: ContentStore, key: str) -> dict[str, dict[str, dict]]:
    """Page through the store's list (drafts and every kind included), at most ``TERMS_SCAN_CAP`` entries.

    Returns ``{kind: {lowercased name: {"count": n, "spellings": {spelling: uses}}}}``; ``count`` is
    the number of entries carrying the term, however many times one entry spells it.
    """
    found: dict[str, dict[str, dict]] = {kind: {} for kind in TERM_KINDS}
    scanned = 0
    cursor: str | None = None
    while scanned < TERMS_SCAN_CAP:
        items, cursor = await store.list(key, ListFilter(limit=MAX_LIMIT, cursor=cursor))
        for entry in items[: TERMS_SCAN_CAP - scanned]:
            for kind, names in (("tag", entry.get("tags")), ("category", entry.get("categories"))):
                seen: set[str] = set()
                for name in names or []:
                    folded = name.lower()
                    term = found[kind].setdefault(folded, {"count": 0, "spellings": {}})
                    term["spellings"][name] = term["spellings"].get(name, 0) + 1
                    if folded not in seen:
                        seen.add(folded)
                        term["count"] += 1
        scanned += len(items)
        if cursor is None or not items:
            break
    return found


@_handle_errors
async def handle_terms(
    *,
    auth_header: str | None,
    query: Any,
    keys: list,
    store: ContentStore,
) -> Response:
    """The tags and categories entries carry: ``kind``, ``search``, ``limit``. Read-only keys may call it."""
    api_key = authorize(auth_header, keys)

    kind = _query_value(query, "kind")
    if kind is not None and kind not in TERM_KINDS:
        raise InkwireError("invalid_payload", "kind: must be 'tag' or 'category'")
    search = (_query_value(query, "search") or "").lower()
    limit = _query_limit(query, TERMS_DEFAULT_LIMIT, TERMS_MAX_LIMIT)

    found = await _scan_terms(store, api_key.scope)
    items: list[dict] = []
    for term_kind in TERM_KINDS:
        if kind is not None and kind != term_kind:
            continue
        for term in found[term_kind].values():
            # the most used spelling; ties go to the one seen first (the newest entry's)
            name = max(term["spellings"], key=lambda spelling: term["spellings"][spelling])
            if search in name.lower():
                items.append({"kind": term_kind, "name": name, "slug": slugify(name), "count": term["count"]})
    items.sort(key=lambda item: (-item["count"], item["name"].lower(), item["name"], item["kind"]))
    return _ok({"items": items[:limit]})


# --- POST /api/media --------------------------------------------------------


def _as_upload(upload: Any) -> MediaUpload:
    if isinstance(upload, MediaUpload):
        return upload
    data, filename, content_type = upload
    return MediaUpload(data=bytes(data), filename=str(filename or "image"), content_type=str(content_type or ""))


def _require_media(store: ContentStore, method: str) -> None:
    """A store without the method omits the feature, so its endpoint does not exist."""
    if not _store_supports(store, method):
        raise InkwireError("not_found", "this receiver does not offer that media feature")


@_handle_errors
async def handle_media(
    *,
    auth_header: str | None,
    keys: list,
    store: ContentStore,
    config: InkwireConfig | None = None,
    content_type: str | None = None,
    raw_body: Any = None,
    upload: Any = None,
    alt: str | None = None,
) -> Response:
    """Store one image: a multipart upload (parsed by the adapter) or ``{url, alt}`` to fetch."""
    api_key = authorize(auth_header, keys)
    require_write(api_key)
    key = api_key.scope
    _require_media(store, "media")

    if upload is not None:
        media = _as_upload(upload)
        sniffed = validate_image(
            media.data,
            filename=media.filename,
            content_type=media.content_type or content_type,
            require_declared=True,
        )
        limit = _media_limit(config)
        if limit and len(media.data) > limit:
            raise InkwireError("too_large", f"media: over the receiver's limit of {limit} bytes")
        result: MediaResult = await store.media(  # type: ignore[attr-defined]
            key,
            MediaUpload(
                data=media.data,
                filename=media.filename,
                content_type=sniffed,
                alt=(media.alt if media.alt is not None else alt) or None,
            ),
        )
        return _ok(result.as_dict())

    declared = (content_type or "").split(";")[0].strip().lower()
    if declared.startswith("multipart/form-data"):
        raise InkwireError(
            "invalid_payload", "media: multipart bodies must be parsed by the adapter and passed as `upload`"
        )

    payload = _validate(MediaUrlInput, raw_body)
    if not _store_supports(store, "fetch_media"):
        raise InkwireError(
            "invalid_payload", "media: fetching a url is not enabled on this receiver; upload the file instead"
        )
    try:
        result = await store.fetch_media(key, payload.url, payload.alt)  # type: ignore[attr-defined]
    except InkwireError:
        raise
    except Exception:  # network, DNS, TLS, a store without a fetcher: the url could not be fetched
        raise InkwireError("invalid_payload", "media: could not fetch the url") from None
    return _ok(result.as_dict())


# --- GET /api/media ---------------------------------------------------------


@_handle_errors
async def handle_media_list(
    *,
    auth_header: str | None,
    query: Any,
    keys: list,
    store: ContentStore,
) -> Response:
    """The media library, newest first: ``search``, ``limit``, ``cursor``. Read-only keys may call it."""
    api_key = authorize(auth_header, keys)
    _require_media(store, "list_media")
    media_filter = MediaListFilter(
        search=_query_value(query, "search"),
        limit=_query_limit(query, DEFAULT_LIMIT, MAX_LIMIT),
        cursor=_query_value(query, "cursor"),
    )
    items, next_cursor = await store.list_media(api_key.scope, media_filter)  # type: ignore[attr-defined]
    return _ok({"items": [item.as_dict() for item in items], "next_cursor": next_cursor})


# --- PATCH /api/media/{id} --------------------------------------------------


@_handle_errors
async def handle_media_update(
    *,
    auth_header: str | None,
    id: str,
    raw_body: Any,
    keys: list,
    store: ContentStore,
) -> Response:
    """Set or clear (``null``) a media item's ``alt`` and/or ``title``."""
    api_key = authorize(auth_header, keys)
    require_write(api_key)
    _require_media(store, "update_media")

    payload = _validate(MediaPatchInput, raw_body)
    item = await store.update_media(api_key.scope, str(id), payload.changes())  # type: ignore[attr-defined]
    if item is None:
        raise InkwireError("not_found", f"no media with id '{id}'")
    return _ok(item.as_dict())


# --- GET /api/inkwire -------------------------------------------------------


def _features(store: ContentStore, config: InkwireConfig) -> list[str]:
    """What this receiver can do: fixed for content and terms, derived from the store for media."""
    features = ["upsert", "list", "get", "update", "delete", "terms"]
    if config.schedule:
        features.append("schedule")
    for feature, method in (("media", "media"), ("media_list", "list_media"), ("media_update", "update_media")):
        if _store_supports(store, method):
            features.append(feature)
            if feature == "media" and getattr(store, "fetches_media_urls", False):
                features.append("media_url")
    if _has_revisions(store):
        features.append("revisions")
    features.append("warnings")
    if _has_redirects(store):
        features.append("redirects")
    if getattr(store, "translations", False):
        features.append("translations")
    return features


def discovery_body(store: ContentStore, config: InkwireConfig | None = None) -> dict:
    """``{inkwire, site?, features, kinds, limits?}``."""
    config = config or InkwireConfig()
    body: dict = {"inkwire": 1}
    if config.site is not None:
        site = {
            name: value
            for name in ("name", "url", "description", "language")
            if (value := getattr(config.site, name))
        }
        if site:
            body["site"] = site
    body["features"] = _features(store, config)
    body["kinds"] = _kinds(config)
    if config.limits is not None:
        limits = {}
        if config.limits.markdown_bytes:
            limits["markdown_bytes"] = int(config.limits.markdown_bytes)
        if config.limits.media_bytes:
            limits["media_bytes"] = int(config.limits.media_bytes)
        if limits:
            body["limits"] = limits
    if "revisions" in body["features"]:
        body["limits"] = {**body.get("limits", {}), "revisions": _keep(config)}
    return body


@_handle_errors
async def handle_discovery(
    *, auth_header: str | None, keys: list, store: ContentStore, config: InkwireConfig | None = None
) -> Response:
    """Discovery: what this receiver can do (same bearer auth as everything else)."""
    authorize(auth_header, keys)
    return _ok(discovery_body(store, config))


__all__ = [
    "DEFAULT_KINDS",
    "InkwireConfig",
    "KNOWN_FEATURES",
    "Limits",
    "Response",
    "Site",
    "discovery_body",
    "entry_etag",
    "handle_delete",
    "handle_discovery",
    "handle_get",
    "handle_list",
    "handle_media",
    "handle_media_list",
    "handle_media_update",
    "handle_patch",
    "handle_redirect",
    "handle_restore",
    "handle_revision",
    "handle_revisions",
    "handle_terms",
    "handle_upsert",
    "public_url",
]
