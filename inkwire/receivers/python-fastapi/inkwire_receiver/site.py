"""Helpers for the page renderer (the site's own code): what SEO Profile 1 asks a public page to do.

Same behaviour as ``core-ts/src/site.ts``. Each entry returned carries its public ``url``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import AsyncIterator

from .handle import InkwireConfig, public_url
from .seo import effective_seo
from .store import MAX_LIMIT, ContentStore, ListFilter, StoredContent


def _is_live(entry: StoredContent, now: datetime) -> bool:
    if entry.get("status") != "published":
        return False
    try:
        at = datetime.fromisoformat(str(entry.get("published_at")).replace("Z", "+00:00"))
    except ValueError:
        return True
    return (at if at.tzinfo else at.replace(tzinfo=timezone.utc)) <= now


async def _every(store: ContentStore, scope: str, **filters) -> AsyncIterator[StoredContent]:
    cursor: str | None = None
    while True:
        items, cursor = await store.list(scope, ListFilter(limit=MAX_LIMIT, cursor=cursor, **filters))
        for item in items:
            yield item
        if not cursor or not items:
            return


def _with_url(entry: StoredContent, config: InkwireConfig | None) -> StoredContent:
    return {**entry, "url": public_url(entry, config)}


async def resolve_redirect(
    store: ContentStore, scope: str, kind: str, slug: str, config: InkwireConfig | None = None
) -> StoredContent | None:
    """The entry an old address leads to now, for a page that found no entry at ``kind``/``slug``:
    answer with a permanent redirect to its ``url``. ``None`` when nothing redirects there, the
    entry is gone or not public, or another entry lives at that address."""
    find = getattr(store, "find_redirect", None)
    if find is None:
        return None
    items, _ = await store.list(scope, ListFilter(kind=kind, slug=slug, limit=1))
    if items:
        return None
    redirect = await find(scope, kind, slug)
    entry = await store.get(scope, redirect["id"]) if redirect else None
    return _with_url(entry, config) if entry and _is_live(entry, datetime.now(timezone.utc)) else None


async def sitemap_entries(store: ContentStore, scope: str, config: InkwireConfig | None = None) -> list[dict]:
    """``[{url, lastmod, kind}]``: public now, indexable, their own canonical; ``lastmod`` = ``updated_at``."""
    now = datetime.now(timezone.utc)
    out: list[dict] = []
    async for entry in _every(store, scope, status="published"):
        if not _is_live(entry, now) or effective_seo(entry)["noindex"]:
            continue
        url = public_url(entry, config)
        if entry.get("canonical_url") and entry["canonical_url"] != url:
            continue
        out.append({"url": url, "lastmod": entry.get("updated_at"), "kind": entry.get("kind")})
    return out


async def alternates(
    store: ContentStore, scope: str, entry: StoredContent, config: InkwireConfig | None = None
) -> list[dict]:
    """The ``hreflang`` alternates (feature ``translations``): every public translation with a ``lang``,
    the entry itself included, one per language (the newest), sorted by ``lang``. Empty without one."""
    key = entry.get("translation_key")
    if not key or not getattr(store, "translations", False):
        return []
    now = datetime.now(timezone.utc)
    by_lang: dict[str, str] = {}
    async for other in _every(store, scope, status="published", translation_key=key):
        lang = other.get("lang")
        if lang and _is_live(other, now) and lang not in by_lang:
            by_lang[lang] = other.get("canonical_url") or public_url(other, config)
    if entry.get("lang"):
        by_lang[entry["lang"]] = entry.get("canonical_url") or public_url(entry, config)
    return [{"lang": lang, "url": url} for lang, url in sorted(by_lang.items())] if len(by_lang) > 1 else []


__all__ = ["alternates", "resolve_redirect", "sitemap_entries"]
