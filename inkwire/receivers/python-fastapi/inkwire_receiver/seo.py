"""SEO Profile 1: overrides applied over the derived defaults (SPEC.md "SEO Profile 1")."""

from __future__ import annotations

from typing import Mapping

from .store import SeoMetadata, SeoOverrides

OVERRIDE_KEYS = ("title", "description", "image_url", "noindex", "og_title", "og_description", "json_ld")


def effective_seo(entry: Mapping) -> SeoMetadata:
    """title = seo.title ?? title; description = seo.description ?? first of (excerpt, title)…

    ``og_title`` / ``og_description`` default to the effective title / description; ``json_ld``
    is absent unless the entry set it.
    """
    overrides = entry.get("seo") or {}
    image = overrides.get("image_url") or entry.get("cover_image_url")
    title = overrides.get("title") or entry.get("title") or ""
    description = overrides.get("description") or entry.get("excerpt") or entry.get("title") or ""
    effective: SeoMetadata = {
        "title": title,
        "description": description,
        "noindex": bool(overrides.get("noindex", False)),
        "og_title": overrides.get("og_title") or title,
        "og_description": overrides.get("og_description") or description,
    }
    if image:
        effective["image_url"] = image
    if overrides.get("json_ld"):
        effective["json_ld"] = overrides["json_ld"]
    return effective


def overrides_from_input(seo) -> SeoOverrides | None:
    """Only the keys the caller actually sent, or ``None`` when nothing was overridden."""
    if seo is None:
        return None
    sent = getattr(seo, "model_fields_set", set())
    out: dict = {}
    for name in OVERRIDE_KEYS:
        value = getattr(seo, name, None)
        if name in sent and value is not None:
            out[name] = bool(value) if name == "noindex" else value
    return out or None  # type: ignore[return-value]


def clean_overrides(overrides: Mapping | None) -> SeoOverrides | None:
    if not overrides:
        return None
    out: dict = {}
    for key in OVERRIDE_KEYS:
        value = overrides.get(key)
        if value is not None:
            out[key] = value
    return out or None  # type: ignore[return-value]


def merge_overrides(current: SeoOverrides | None, patch) -> SeoOverrides | None:
    """``PATCH`` semantics: ``null`` clears everything; an object merges per key.

    Inside a patch object, ``image_url: null`` and ``json_ld: null`` drop that one override
    (the schema allows it); the other keys cannot be null.
    """
    if patch is None:
        return None
    merged: dict = dict(current or {})
    sent = getattr(patch, "model_fields_set", set())
    for name in OVERRIDE_KEYS:
        if name not in sent:
            continue
        value = getattr(patch, name)
        if value is None:
            merged.pop(name, None)
        else:
            merged[name] = bool(value) if name == "noindex" else value
    return clean_overrides(merged)


__all__ = ["clean_overrides", "effective_seo", "merge_overrides", "overrides_from_input"]
