"""One handler per endpoint. Every response carries ``Inkwire-Version: 1``.

Each handler returns ``(status, headers, body)`` and never raises for a client error: the
protocol error shape is built here, so an adapter only has to turn the tuple into a response.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

from pydantic import ValidationError

from .auth import ApiKey, authorize, require_write
from .errors import InkwireError
from .media import validate_image
from .render import render_markdown, slugify
from .schema import ContentInput, MediaUrlInput, PatchInput, validation_message
from .seo import effective_seo, merge_overrides, overrides_from_input
from .store import (
    ContentStore,
    ListFilter,
    MediaResult,
    MediaUpload,
    StoredContent,
    clamp_limit,
    content_id,
)

VERSION_HEADER = ("Inkwire-Version", "1")
DEFAULT_KINDS = ("post", "page")
KNOWN_FEATURES = ("upsert", "list", "get", "update", "delete", "media")
MAX_SLUG_LENGTH = 255

Response = tuple[int, dict[str, str], dict]


@dataclass
class Site:
    name: str | None = None
    url: str | None = None


@dataclass
class Limits:
    markdown_bytes: int | None = None
    media_bytes: int | None = None


@dataclass
class InkwireConfig:
    """What the adapter tells the core about its site."""

    site: Site | None = None
    kinds: list[str] = field(default_factory=lambda: list(DEFAULT_KINDS))
    limits: Limits | None = None
    features: list[str] | None = None
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
    return {
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


def _full(entry: StoredContent, config: InkwireConfig | None) -> dict:
    body = _summary(entry, config)
    body.update(
        {
            "markdown": entry.get("markdown", ""),
            "html": entry.get("html") or render_markdown(entry.get("markdown", "")),
            "cover_image_url": entry.get("cover_image_url"),
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


# --- POST /api/content ------------------------------------------------------


@_handle_errors
async def handle_upsert(
    *,
    auth_header: str | None,
    raw_body: Any,
    keys: list,
    store: ContentStore,
    config: InkwireConfig | None = None,
) -> Response:
    """Create or update one entry, upserting on ``(key, kind, external_id)``."""
    api_key = authorize(auth_header, keys)
    require_write(api_key)
    key = api_key.scope

    payload = _validate(ContentInput, raw_body)
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
        "html": render_markdown(payload.markdown),
        "excerpt": payload.excerpt,
        "tags": payload.tags,
        "cover_image_url": payload.cover_image_url,
        "canonical_url": payload.canonical_url,
        "seo": overrides_from_input(payload.seo),
        "author": (payload.author.model_dump(exclude_none=True) or None) if payload.author else None,
        "status": payload.status,
        "published_at": payload.published_at or (existing or {}).get("published_at") or now,
        "updated_at": now,
        "version": int((existing or {}).get("version") or 0) + 1,
    }
    saved = await store.save(key, entry)
    return _ok(
        {
            "id": saved.get("id", ""),
            "external_id": payload.external_id,
            "url": public_url(saved, config),
            "slug": saved.get("slug", slug),
            "kind": saved.get("kind", payload.kind),
            "status": saved.get("status", payload.status),
            "created": existing is None,
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
    """List entries: ``status``, ``kind``, ``tag``, ``search``, ``external_id``, ``slug``, ``limit``, ``cursor``."""
    api_key = authorize(auth_header, keys)
    key = api_key.scope

    status = _query_value(query, "status")
    if status is not None and status not in ("draft", "published"):
        raise InkwireError("invalid_payload", "status: must be 'draft' or 'published'")

    limit_raw = _query_value(query, "limit")
    limit = clamp_limit(None)
    if limit_raw is not None and limit_raw != "":
        try:
            parsed = int(limit_raw)
        except ValueError:
            raise InkwireError("invalid_payload", "limit: must be a positive integer") from None
        if parsed < 1:
            raise InkwireError("invalid_payload", "limit: must be a positive integer")
        limit = clamp_limit(parsed)

    list_filter = ListFilter(
        status=status,
        kind=_query_value(query, "kind"),
        tag=_query_value(query, "tag"),
        search=_query_value(query, "search"),
        external_id=_query_value(query, "external_id"),
        slug=_query_value(query, "slug"),
        limit=limit,
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
) -> Response:
    """Edit part of an entry; ``If-Match`` makes concurrent edits safe (412, nothing written)."""
    api_key = authorize(auth_header, keys)
    require_write(api_key)
    key = api_key.scope

    payload = _validate(PatchInput, raw_body)
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
        "html": render_markdown(markdown),
        "updated_at": now,
        "version": int(existing.get("version") or 1) + 1,
    }
    for name in ("title", "excerpt", "tags", "cover_image_url", "canonical_url", "status"):
        if name in sent:
            entry[name] = getattr(payload, name)  # type: ignore[literal-required]
    if "author" in sent:
        entry["author"] = (payload.author.model_dump(exclude_none=True) or None) if payload.author else None
    if "seo" in sent:
        entry["seo"] = merge_overrides(existing.get("seo"), payload.seo)
    if "published_at" in sent:
        entry["published_at"] = payload.published_at or now

    entry.pop("etag", None)  # the store issues the new ETag for the new bytes
    saved = await store.save(key, entry)
    return _ok(_full(saved, config), {"ETag": entry_etag(saved)})


# --- DELETE /api/content/{id} ----------------------------------------------


@_handle_errors
async def handle_delete(
    *,
    auth_header: str | None,
    id: str,
    if_match: str | None = None,
    keys: list,
    store: ContentStore,
) -> Response:
    """Remove the entry (it must stop being public); honours ``If-Match``."""
    api_key = authorize(auth_header, keys)
    require_write(api_key)
    key = api_key.scope

    existing = await store.get(key, str(id))
    if existing is None:
        raise InkwireError("not_found", f"no content with id '{id}'")
    if not _etag_matches(if_match, existing):
        raise InkwireError("stale", "If-Match no longer matches: the entry changed since you read it")
    removed = await store.remove(key, str(id))
    if not removed:
        raise InkwireError("not_found", f"no content with id '{id}'")
    return _ok({"id": str(id), "deleted": True})


# --- POST /api/media --------------------------------------------------------


def _as_upload(upload: Any) -> MediaUpload:
    if isinstance(upload, MediaUpload):
        return upload
    data, filename, content_type = upload
    return MediaUpload(data=bytes(data), filename=str(filename or "image"), content_type=str(content_type or ""))


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
        if not _store_supports(store, "media"):
            raise InkwireError("internal", "this store does not support media uploads")
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
        raise InkwireError("internal", "this store cannot fetch remote media")
    try:
        result = await store.fetch_media(key, payload.url, payload.alt)  # type: ignore[attr-defined]
    except InkwireError:
        raise
    except Exception:  # network, DNS, TLS, a store without a fetcher: the url could not be fetched
        raise InkwireError("invalid_payload", "media: could not fetch the url") from None
    body = result.as_dict() if isinstance(result, MediaResult) else dict(result)
    return _ok(body)


# --- GET /api/inkwire -------------------------------------------------------


def discovery_body(config: InkwireConfig | None = None) -> dict:
    """``{inkwire, site?, features, kinds, limits?}`` — ``upsert`` is always advertised."""
    config = config or InkwireConfig()
    features = ["upsert"]
    for feature in config.features or []:
        if feature not in features:
            features.append(feature)
    body: dict = {"inkwire": 1}
    if config.site is not None:
        site = {}
        if config.site.name:
            site["name"] = config.site.name
        if config.site.url:
            site["url"] = config.site.url
        if site:
            body["site"] = site
    body["features"] = features
    body["kinds"] = _kinds(config)
    if config.limits is not None:
        limits = {}
        if config.limits.markdown_bytes:
            limits["markdown_bytes"] = int(config.limits.markdown_bytes)
        if config.limits.media_bytes:
            limits["media_bytes"] = int(config.limits.media_bytes)
        if limits:
            body["limits"] = limits
    return body


@_handle_errors
async def handle_discovery(
    *, auth_header: str | None, keys: list, config: InkwireConfig | None = None
) -> Response:
    """Discovery: what this receiver can do (same bearer auth as everything else)."""
    authorize(auth_header, keys)
    return _ok(discovery_body(config))


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
    "handle_patch",
    "handle_upsert",
    "public_url",
]
