"""Markdown rendering + sanitizing, slug generation and the client-side ``edits`` helper."""

from __future__ import annotations

import re
from typing import Iterable, Mapping

import markdown as _markdown
import nh3

from .errors import InkwireError

SLUG_FALLBACK = "entry"
MAX_SLUG_LENGTH = 255

# Canonical allowlist, normative in SPEC.md "Content safety": sanitize-html's default
# allowedTags unioned with `img` (h1/h2 are already in that default set). No more, no less.
ALLOWED_TAGS = {
    "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br",
    "caption", "cite", "code", "col", "colgroup", "data", "dd", "dfn", "div", "dl", "dt",
    "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "hgroup", "hr", "i", "img", "kbd", "li", "main", "mark", "menu", "nav", "ol", "p",
    "pre", "q", "rb", "rp", "rt", "rtc", "ruby", "s", "samp", "section", "small", "span",
    "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr",
    "u", "ul", "var", "wbr",
}

# Only `a` and `img` keep any attributes; every other tag is stripped of all of them.
ALLOWED_ATTRIBUTES = {
    "a": {"href", "name", "rel"},
    "img": {"src", "alt", "title"},
}

ALLOWED_SCHEMES = {"http", "https", "mailto"}

_MARKDOWN = _markdown.Markdown(extensions=["extra"], output_format="html")


def render_markdown(text: str) -> str:
    """Markdown -> HTML, then sanitized with exactly the canonical allowlist."""
    _MARKDOWN.reset()
    raw = _MARKDOWN.convert(text or "")
    return nh3.clean(
        raw,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        url_schemes=ALLOWED_SCHEMES,
        clean_content_tags={"script", "style"},
        link_rel=None,
    )


def slugify(value: str) -> str:
    """Lowercase ASCII slug; the fallback is ``entry`` (not ``post``) so it reads kind-neutral."""
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return slug[:MAX_SLUG_LENGTH] or SLUG_FALLBACK


def _preview(text: str, limit: int = 80) -> str:
    shown = text.replace("\n", "\\n")
    return shown if len(shown) <= limit else shown[: limit - 1] + "…"


def edits(markdown: str, changes: Iterable[Mapping[str, str]]) -> str:
    """Apply exact, exactly-once text replacements (the SDKs mirror this helper).

    Each ``find`` must occur exactly once in the *current* markdown; a missing match raises
    ``invalid_payload`` with ``edit_not_found: …`` and a repeated one ``edit_ambiguous: …``.
    The receiver never merges text: the client computes the new body and PATCHes it whole.
    """
    current = markdown
    for index, change in enumerate(changes):
        find = change.get("find") if isinstance(change, Mapping) else None
        replace = change.get("replace") if isinstance(change, Mapping) else None
        if not isinstance(find, str) or find == "":
            raise InkwireError("invalid_payload", f"edit_not_found: change {index} has an empty `find`")
        if not isinstance(replace, str):
            raise InkwireError("invalid_payload", f"edit_ambiguous: change {index} has no `replace`")
        count = current.count(find)
        if count == 0:
            raise InkwireError("invalid_payload", f"edit_not_found: '{_preview(find)}' is not in the markdown")
        if count > 1:
            raise InkwireError(
                "invalid_payload", f"edit_ambiguous: '{_preview(find)}' occurs {count} times"
            )
        current = current.replace(find, replace, 1)
    return current


__all__ = [
    "ALLOWED_ATTRIBUTES",
    "ALLOWED_SCHEMES",
    "ALLOWED_TAGS",
    "SLUG_FALLBACK",
    "edits",
    "render_markdown",
    "slugify",
]


_IMG = re.compile(r"<img\b([^>]*?)(\s*/?)>")
_SRC = re.compile(r'\ssrc="([^"]*)"')


def size_images(html: str, sizes: Mapping[str, tuple[int, int]]) -> str:
    """Adds ``width``/``height`` to each ``<img>`` whose ``src`` is a library image of known size.

    Runs after sanitizing, so the allowlist stays as it is; a tag that already has a width is left alone.
    """
    if not sizes:
        return html

    def put(match: re.Match) -> str:
        attrs, end = match.group(1), match.group(2)
        if re.search(r"\swidth=", attrs):
            return match.group(0)
        src = _SRC.search(attrs)
        size = sizes.get(src.group(1).replace("&amp;", "&")) if src else None
        return f'<img{attrs} width="{size[0]}" height="{size[1]}"{end}>' if size else match.group(0)

    return _IMG.sub(put, html)
