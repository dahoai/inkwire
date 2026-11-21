"""SEO advice on an entry as it will be after a write (feature ``warnings``). Never blocks the write.

The same checks, codes and fields as the TypeScript core (``core-ts/src/warnings.ts``).
"""

from __future__ import annotations

import html as _html
import re
from typing import Awaitable, Callable, Mapping, Sequence
from urllib.parse import urljoin, urlsplit

from .seo import effective_seo

TITLE_MAX = 65

# Anchor texts that say nothing about where the link goes (English and French).
GENERIC_ANCHORS = {
    "click here", "here", "read more", "more", "learn more", "this", "this link", "link", "continue", "details",
    "see more", "ici", "cliquez ici", "lire la suite", "en savoir plus", "plus", "voir plus", "ce lien",
}
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_HEADING = re.compile(r"<h([1-6])\b")
_IMG = re.compile(r"<img\b[^>]*>")
_LINK = re.compile(r'<a\b[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)</a>')

Redirects = Callable[[str, str], Awaitable[bool]]


def _norm(text: str) -> str:
    return " ".join(text.split()).lower()


def _text(markup: str) -> str:
    return _html.unescape(re.sub(r"<[^>]*>", "", markup))


def _path(url: str) -> str:
    return urlsplit(url).path.rstrip("/") or "/"


def _origin(url: str) -> tuple[str, str]:
    parts = urlsplit(url)
    return parts.scheme.lower(), parts.netloc.lower()


def _address_patterns(entries: Sequence[Mapping], site: str) -> dict[str, tuple[str, str]]:
    """Where an entry of each kind lives: its URL path with the slug cut out, from one entry of that kind."""
    out: dict[str, tuple[str, str]] = {}
    for entry in entries:
        kind, url, slug = entry.get("kind"), entry.get("url"), entry.get("slug") or ""
        if kind in out or not url or not slug or _origin(url) != _origin(site):
            continue
        path = _path(url)
        at = path.rfind(slug)
        if at >= 0:
            out[kind] = (path[:at], path[at + len(slug):])
    return out


async def seo_warnings(
    entry: Mapping, *, site_url: str | None, others: Sequence[Mapping], redirects: Redirects | None = None
) -> list[dict]:
    """``others`` is every other entry of the site, drafts included, each with its public ``url``."""
    out: list[dict] = []

    def add(code: str, field: str, message: str) -> None:
        out.append({"code": code, "field": field, "message": message})

    seo = effective_seo(entry)
    overrides = entry.get("seo") or {}
    published = [o for o in others if o.get("status") == "published"]
    key = entry.get("translation_key")

    def same_group(other: Mapping) -> bool:
        return bool(key) and other.get("translation_key") == key

    title_field = "seo.title" if "title" in overrides else "title"

    if not seo["noindex"]:
        if len(seo["title"]) > TITLE_MAX:
            add("title_long", title_field, f"the search title is {len(seo['title'])} characters; over {TITLE_MAX}, results cut it off")
        twin = next(
            (o for o in published if not same_group(o) and not effective_seo(o)["noindex"]
             and _norm(effective_seo(o)["title"]) == _norm(seo["title"])),
            None,
        )
        if twin:
            add("title_duplicate", title_field, f'"{twin.get("title")}" ({twin.get("id")}) has the same search title; give each page its own')
        if "description" not in overrides and not entry.get("excerpt"):
            add("description_missing", "seo.description", "no description: search results show the title twice; write an excerpt or seo.description")
        else:
            twin = next(
                (o for o in published if not same_group(o) and not effective_seo(o)["noindex"]
                 and _norm(effective_seo(o)["description"]) == _norm(seo["description"])),
                None,
            )
            if twin:
                add("description_duplicate", "seo.description", f'"{twin.get("title")}" ({twin.get("id")}) has the same description; describe each page on its own')

    html = entry.get("html") or ""
    # The page shows the title as its H1, so the body starts at H2.
    levels = [int(level) for level in _HEADING.findall(html)]
    if 1 in levels:
        add("h1_extra", "markdown", "the body has a level-1 heading (#); the title is already the page's H1, use ## instead")
    previous = 1
    for level in levels:
        if level > previous + 1:
            add("heading_skipped", "markdown", f"a level-{level} heading follows a level-{previous} one; do not skip levels")
            break
        previous = level

    bare = sum(1 for tag in _IMG.findall(html) if not re.search(r'\salt="[^"]+"', tag))
    if bare:
        add("image_alt_missing", "markdown", f"{bare} image{'s have' if bare > 1 else ' has'} no alt text; describe each one (![what it shows](url))")
    if entry.get("cover_image_url") and not entry.get("cover_image_alt"):
        add("image_alt_missing", "cover_image_alt", "the cover image has no alt text")

    generic: list[str] = []
    broken: list[str] = []
    redirected: list[str] = []
    site = site_url if site_url and urlsplit(site_url).scheme in ("http", "https") else None
    patterns = _address_patterns([entry, *others], site) if site else {}
    by_path = {_path(o["url"]): o for o in others if o.get("url")}
    for href, label in _LINK.findall(html):
        name = re.sub(r"[.!?:…»«\"']+$", "", _norm(_text(label))).strip()
        if name in GENERIC_ANCHORS and name not in generic:
            generic.append(name)
        if not site:
            continue
        url = urljoin(site, href.replace("&amp;", "&"))
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or _origin(url) != _origin(site):
            continue
        path = _path(url)
        target = by_path.get(path)
        if target is not None:
            if target.get("status") != "published":
                _once(broken, f"{parts.path} (a draft)")
            continue
        for kind, (before, after) in patterns.items():
            if not path.startswith(before) or not path.endswith(after) or len(path) <= len(before) + len(after):
                continue
            slug = path[len(before): len(path) - len(after)]
            if not _SLUG_RE.match(slug) or (kind == entry.get("kind") and slug == entry.get("slug")):
                continue
            if redirects is not None and await redirects(kind, slug):
                _once(redirected, parts.path)
            else:
                _once(broken, parts.path)
            break
    if broken:
        add("link_broken", "markdown", f"links to pages that are not on the site: {', '.join(broken)}")
    if redirected:
        add("link_redirect", "markdown", f"links to old addresses that redirect: {', '.join(redirected)}; link to the page's current URL")
    if generic:
        quoted = '", "'.join(generic)
        add("anchor_generic", "markdown", f'link text that says nothing about the page it opens: "{quoted}"')

    lang = entry.get("lang")
    if lang and key:
        twin = next((o for o in others if o.get("translation_key") == key and o.get("lang") == lang), None)
        if twin:
            add("translation_lang_duplicate", "lang", f'"{twin.get("title")}" ({twin.get("id")}) is already the {lang} version of this page')
    return out


def _once(items: list[str], value: str) -> None:
    if value not in items:
        items.append(value)


__all__ = ["GENERIC_ANCHORS", "TITLE_MAX", "seo_warnings"]
