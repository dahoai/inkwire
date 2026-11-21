"""Inkwire client (protocol v1): publish, read, edit, delete, terms, media library, discovery.

Every call returns what the receiver sent as plain dicts; the ``TypedDict`` classes below describe
those shapes for type checkers.
"""

from __future__ import annotations

import time
import urllib.parse
from typing import Any, Iterable, List, Literal, Mapping, Optional, TypedDict
import httpx

_transport = None  # tests may inject an httpx.MockTransport


class _Unset:
    """Marks an argument that was not given, so ``None`` can mean "clear it"."""

    def __repr__(self) -> str:
        return "UNSET"

    def __bool__(self) -> bool:
        return False


UNSET: Any = _Unset()


class SeoOverrides(TypedDict, total=False):
    """SEO overrides on publish; ``json_ld`` is one JSON object (or array of objects) as a string."""

    title: str
    description: str
    image_url: str
    noindex: bool
    og_title: str
    og_description: str
    json_ld: str


class EffectiveSeo(TypedDict, total=False):
    """The ``seo`` of a read entry: overrides applied over the derived defaults. ``json_ld`` only when set."""

    title: str
    description: str
    image_url: str
    noindex: bool
    og_title: str
    og_description: str
    json_ld: str


class ContentSummary(TypedDict, total=False):
    id: str
    external_id: Optional[str]
    kind: str
    title: str
    slug: str
    url: str
    status: Literal["draft", "published"]
    excerpt: Optional[str]
    tags: List[str]
    categories: List[str]
    lang: str
    translation_key: str
    published_at: str
    updated_at: str


class Content(ContentSummary, total=False):
    markdown: str
    cover_image_url: Optional[str]
    cover_image_alt: Optional[str]
    canonical_url: Optional[str]
    author: Optional[dict]
    seo: EffectiveSeo
    warnings: List["Warning"]
    dry_run: bool


class Warning(TypedDict):
    """SEO advice on an entry as written (feature ``warnings``); never blocks the write. Unknown codes may appear."""

    code: str
    field: str
    message: str


class Redirect(TypedDict):
    """Where an old address leads (feature ``redirects``)."""

    kind: str
    slug: str
    id: str
    url: str
    status: Literal["draft", "published"]


class Term(TypedDict):
    """A tag or category some entry carries; ``count`` includes drafts."""

    kind: Literal["tag", "category"]
    name: str
    slug: str
    count: int


class TermsResult(TypedDict):
    items: List[Term]


class _MediaRequired(TypedDict):
    id: str
    url: str
    mime_type: str
    created_at: str


class MediaItem(_MediaRequired, total=False):
    """An image in the media library (also what an upload answers with)."""

    alt: str
    title: str
    width: int
    height: int


class MediaListResult(TypedDict):
    items: List[MediaItem]
    next_cursor: Optional[str]

DEFAULT_STATUS_CODES = {
    400: "invalid_payload",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    412: "stale",
    413: "too_large",
    429: "rate_limited",
    500: "internal",
}


class InkwireClientError(Exception):
    def __init__(self, code: str, message: str, http_status: int):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


def _call(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    json: Any = None,
    data: dict[str, Any] | None = None,
    files: Any = None,
    params: dict[str, Any] | None = None,
    retries: int = 3,
) -> httpx.Response:
    retries = max(1, retries)
    client = httpx.Client(transport=_transport) if _transport else httpx.Client()
    try:
        last: Exception | None = None
        for attempt in range(1, retries + 1):
            res = client.request(
                method,
                url,
                headers=headers,
                json=json,
                data=data,
                files=files,
                params=params,
            )
            if 200 <= res.status_code < 300:
                return res
            retriable = res.status_code == 429 or res.status_code >= 500
            code = DEFAULT_STATUS_CODES.get(res.status_code, "internal")
            message = f"HTTP {res.status_code}"
            try:
                err = res.json().get("error")
                if err and isinstance(err, dict):
                    code = err.get("code", code)
                    message = err.get("message", message)
            except Exception:
                pass
            last = InkwireClientError(code, message, res.status_code)
            if not retriable or attempt == retries:
                raise last
            time.sleep(2 ** (attempt - 1) * 0.2)
        assert last is not None
        raise last
    finally:
        client.close()


def publish(base_url: str, api_key: str, payload: dict, retries: int = 3, *, dry_run: bool = False) -> dict:
    """POST /api/content. ``dry_run`` (feature ``warnings``): the answer and warnings the write would give, nothing written."""
    url = base_url.rstrip("/") + "/api/content" + ("?dry_run=true" if dry_run else "")
    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {api_key}",
    }
    if "external_id" in payload and payload["external_id"] is not None:
        headers["idempotency-key"] = str(payload["external_id"])
    res = _call("POST", url, headers=headers, json=payload, retries=retries)
    return res.json()


def capabilities(base_url: str, api_key: str, retries: int = 3) -> dict:
    url = base_url.rstrip("/") + "/api/inkwire"
    headers = {"authorization": f"Bearer {api_key}"}
    try:
        res = _call("GET", url, headers=headers, retries=retries)
        data = res.json()
        if isinstance(data, dict):
            data.setdefault("features", ["upsert"])
            data.setdefault("kinds", ["post"])
            data.setdefault("limits", {})
            return data
        return {"features": ["upsert"], "kinds": ["post"], "limits": {}}
    except InkwireClientError as e:
        if e.http_status == 404:
            return {"features": ["upsert"], "kinds": ["post"], "limits": {}}
        raise


def list(
    base_url: str,
    api_key: str,
    retries: int = 3,
    *,
    status: str | None = None,
    kind: str | None = None,
    tag: str | None = None,
    category: str | None = None,
    search: str | None = None,
    external_id: str | None = None,
    slug: str | None = None,
    lang: str | None = None,
    translation_key: str | None = None,
    limit: int | None = None,
    cursor: str | None = None,
) -> dict:
    """GET /api/content: one page of summaries, newest first; pass ``next_cursor`` back as ``cursor``."""
    url = base_url.rstrip("/") + "/api/content"
    headers = {"authorization": f"Bearer {api_key}"}
    filters = {
        "status": status,
        "kind": kind,
        "tag": tag,
        "category": category,
        "search": search,
        "external_id": external_id,
        "slug": slug,
        "lang": lang,
        "translation_key": translation_key,
        "limit": limit,
        "cursor": cursor,
    }
    params = {k: v for k, v in filters.items() if v is not None}
    res = _call("GET", url, headers=headers, params=params, retries=retries)
    return res.json()


def get(base_url: str, api_key: str, id: str, retries: int = 3) -> tuple[dict, str | None]:
    quoted_id = urllib.parse.quote(id, safe="")
    url = f"{base_url.rstrip('/')}/api/content/{quoted_id}"
    headers = {"authorization": f"Bearer {api_key}"}
    res = _call("GET", url, headers=headers, retries=retries)
    return res.json(), res.headers.get("etag")


def update(
    base_url: str,
    api_key: str,
    id: str,
    patch: dict,
    if_match: str | None = None,
    retries: int = 3,
    *,
    dry_run: bool = False,
) -> tuple[dict, str | None]:
    """PATCH /api/content/{id}. ``dry_run`` (feature ``warnings``): the entry as it would be, nothing written (no ETag)."""
    quoted_id = urllib.parse.quote(id, safe="")
    url = f"{base_url.rstrip('/')}/api/content/{quoted_id}" + ("?dry_run=true" if dry_run else "")
    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {api_key}",
    }
    if if_match is not None:
        headers["if-match"] = if_match
    res = _call("PATCH", url, headers=headers, json=patch, retries=retries)
    return res.json(), res.headers.get("etag")


def remove(
    base_url: str,
    api_key: str,
    id: str,
    if_match: str | None = None,
    retries: int = 3,
) -> dict:
    quoted_id = urllib.parse.quote(id, safe="")
    url = f"{base_url.rstrip('/')}/api/content/{quoted_id}"
    headers = {"authorization": f"Bearer {api_key}"}
    if if_match is not None:
        headers["if-match"] = if_match
    res = _call("DELETE", url, headers=headers, retries=retries)
    return res.json()


def redirect(base_url: str, api_key: str, kind: str, slug: str, retries: int = 3) -> Redirect | None:
    """GET /api/redirects (feature ``redirects``): where an old address leads now, or ``None``."""
    url = base_url.rstrip("/") + "/api/redirects"
    try:
        res = _call("GET", url, headers={"authorization": f"Bearer {api_key}"}, params={"kind": kind, "slug": slug}, retries=retries)
    except InkwireClientError as e:
        if e.http_status == 404:
            return None
        raise
    return res.json()


def revisions(base_url: str, api_key: str, id: str, retries: int = 3) -> dict:
    """GET /api/content/{id}/revisions (feature ``revisions``): past versions, newest first; works after a delete."""
    quoted_id = urllib.parse.quote(id, safe="")
    url = f"{base_url.rstrip('/')}/api/content/{quoted_id}/revisions"
    res = _call("GET", url, headers={"authorization": f"Bearer {api_key}"}, retries=retries)
    return res.json()


def revision(base_url: str, api_key: str, id: str, rev: str, retries: int = 3) -> dict:
    """GET /api/content/{id}/revisions/{rev} (feature ``revisions``): one past version, with ``entry`` in full."""
    quoted_id = urllib.parse.quote(id, safe="")
    quoted_rev = urllib.parse.quote(rev, safe="")
    url = f"{base_url.rstrip('/')}/api/content/{quoted_id}/revisions/{quoted_rev}"
    res = _call("GET", url, headers={"authorization": f"Bearer {api_key}"}, retries=retries)
    return res.json()


def restore(
    base_url: str,
    api_key: str,
    id: str,
    rev: str,
    if_match: str | None = None,
    retries: int = 3,
) -> tuple[dict, str | None]:
    """POST /api/content/{id}/restore (feature ``revisions``): put the entry back as it was at ``rev`` (also undeletes)."""
    quoted_id = urllib.parse.quote(id, safe="")
    url = f"{base_url.rstrip('/')}/api/content/{quoted_id}/restore"
    headers = {"content-type": "application/json", "authorization": f"Bearer {api_key}"}
    if if_match is not None:
        headers["if-match"] = if_match
    res = _call("POST", url, headers=headers, json={"revision": rev}, retries=retries)
    return res.json(), res.headers.get("etag")


def terms(
    base_url: str,
    api_key: str,
    kind: Literal["tag", "category"] | None = None,
    search: str | None = None,
    limit: int | None = None,
    retries: int = 3,
) -> TermsResult:
    """GET /api/terms (feature ``terms``): the tags and categories entries use, most used first."""
    url = base_url.rstrip("/") + "/api/terms"
    headers = {"authorization": f"Bearer {api_key}"}
    filters = {"kind": kind, "search": search, "limit": limit}
    params = {k: v for k, v in filters.items() if v is not None}
    res = _call("GET", url, headers=headers, params=params, retries=retries)
    return res.json()


def list_media(
    base_url: str,
    api_key: str,
    search: str | None = None,
    limit: int | None = None,
    cursor: str | None = None,
    retries: int = 3,
) -> MediaListResult:
    """GET /api/media (feature ``media_list``): one page of the media library, newest first."""
    url = base_url.rstrip("/") + "/api/media"
    headers = {"authorization": f"Bearer {api_key}"}
    filters = {"search": search, "limit": limit, "cursor": cursor}
    params = {k: v for k, v in filters.items() if v is not None}
    res = _call("GET", url, headers=headers, params=params, retries=retries)
    return res.json()


def update_media(
    base_url: str,
    api_key: str,
    id: str,
    *,
    alt: str | None = UNSET,
    title: str | None = UNSET,
    retries: int = 3,
) -> MediaItem:
    """PATCH /api/media/{id} (feature ``media_update``): set ``alt`` and/or ``title``.

    An argument left out is not sent; ``None`` is sent as ``null`` and clears the field.
    """
    patch = {name: value for name, value in (("alt", alt), ("title", title)) if value is not UNSET}
    if not patch:
        raise InkwireClientError("invalid_payload", "update_media requires 'alt' and/or 'title'", 0)
    quoted_id = urllib.parse.quote(id, safe="")
    url = f"{base_url.rstrip('/')}/api/media/{quoted_id}"
    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {api_key}",
    }
    res = _call("PATCH", url, headers=headers, json=patch, retries=retries)
    return res.json()


def upload_media(
    base_url: str,
    api_key: str,
    *,
    url: str | None = None,
    data: bytes | tuple[bytes, str, str] | None = None,
    alt: str | None = None,
    retries: int = 3,
) -> MediaItem:
    """POST /api/media (feature ``media``): have the receiver fetch ``url`` or upload ``data``. Images only."""
    endpoint = base_url.rstrip("/") + "/api/media"
    headers = {"authorization": f"Bearer {api_key}"}
    if url is not None:
        json_body: dict[str, Any] = {"url": url}
        if alt is not None:
            json_body["alt"] = alt
        headers["content-type"] = "application/json"
        res = _call("POST", endpoint, headers=headers, json=json_body, retries=retries)
        return res.json()
    elif data is not None:
        if isinstance(data, tuple):
            bytes_val = data[0]
            filename = data[1] if len(data) > 1 else "image.png"
            content_type = data[2] if len(data) > 2 else "image/png"
        else:
            bytes_val = data
            filename = "image.png"
            content_type = "image/png"
        files = {"file": (filename, bytes_val, content_type)}
        form_data = {"alt": alt} if alt is not None else None
        res = _call("POST", endpoint, headers=headers, data=form_data, files=files, retries=retries)
        return res.json()
    else:
        raise InkwireClientError("invalid_payload", "upload_media requires either 'url' or 'data'", 0)


def _preview(text: str, limit: int = 60) -> str:
    shown = text.replace("\n", "\\n")
    return shown if len(shown) <= limit else shown[: limit - 1] + "…"


def edits(markdown: str, changes: Iterable[Mapping[str, str]]) -> str:
    current = markdown
    for index, change in enumerate(changes):
        find = change.get("find") if isinstance(change, Mapping) else None
        replace = change.get("replace") if isinstance(change, Mapping) else None
        if not isinstance(find, str) or find == "":
            raise InkwireClientError(
                "edit_not_found", f"edit_not_found: edit {index + 1} has an empty 'find'", 0
            )
        if not isinstance(replace, str):
            raise InkwireClientError(
                "invalid_payload", f"edit {index + 1} has an invalid 'replace'", 0
            )
        count = current.count(find)
        if count == 0:
            raise InkwireClientError(
                "edit_not_found",
                f"edit_not_found: edit {index + 1}: '{_preview(find)}' does not occur in the markdown",
                0,
            )
        if count > 1:
            raise InkwireClientError(
                "edit_ambiguous",
                f"edit_ambiguous: edit {index + 1}: '{_preview(find)}' occurs {count} times; include more surrounding text so it matches once",
                0,
            )
        current = current.replace(find, replace, 1)
    return current


__all__ = [
    "InkwireClientError",
    "publish",
    "capabilities",
    "list",
    "get",
    "update",
    "remove",
    "redirect",
    "revisions",
    "revision",
    "restore",
    "terms",
    "list_media",
    "update_media",
    "upload_media",
    "edits",
    "UNSET",
    "SeoOverrides",
    "EffectiveSeo",
    "ContentSummary",
    "Content",
    "Term",
    "TermsResult",
    "MediaItem",
    "MediaListResult",
    "Warning",
    "Redirect",
]
