"""SEO Profile 1: overrides applied over the derived defaults (SPEC.md "SEO Profile 1")."""

from __future__ import annotations

from typing import Mapping

from .store import SeoMetadata, SeoOverrides


def effective_seo(entry: Mapping) -> SeoMetadata:
    """title = seo.title ?? title; description = seo.description ?? first of (excerpt, title)…"""
    overrides = entry.get("seo") or {}
    image = overrides.get("image_url") or entry.get("cover_image_url")
    effective: SeoMetadata = {
        "title": overrides.get("title") or entry.get("title") or "",
        "description": overrides.get("description") or entry.get("excerpt") or entry.get("title") or "",
        "noindex": bool(overrides.get("noindex", False)),
    }
    if image:
        effective["image_url"] = image
    return effective


def overrides_from_input(seo) -> SeoOverrides | None:
    """Only the keys the caller actually sent, or ``None`` when nothing was overridden."""
    if seo is None:
        return None
    sent = getattr(seo, "model_fields_set", set())
    out: SeoOverrides = {}
    if "title" in sent and seo.title is not None:
        out["title"] = seo.title
    if "description" in sent and seo.description is not None:
        out["description"] = seo.description
    if "image_url" in sent and seo.image_url is not None:
        out["image_url"] = seo.image_url
    if "noindex" in sent and seo.noindex is not None:
        out["noindex"] = bool(seo.noindex)
    return out or None


def clean_overrides(overrides: Mapping | None) -> SeoOverrides | None:
    if not overrides:
        return None
    out: SeoOverrides = {}
    for key in ("title", "description", "image_url", "noindex"):
        value = overrides.get(key)
        if value is not None:
            out[key] = value  # type: ignore[literal-required]
    return out or None


def merge_overrides(current: SeoOverrides | None, patch) -> SeoOverrides | None:
    """``PATCH`` semantics: ``null`` clears everything; an object merges per key.

    Inside a patch object, ``image_url: null`` drops that one override (the schema allows it).
    """
    if patch is None:
        return None
    merged: dict = dict(current or {})
    sent = getattr(patch, "model_fields_set", set())
    if "title" in sent and patch.title is not None:
        merged["title"] = patch.title
    if "description" in sent and patch.description is not None:
        merged["description"] = patch.description
    if "image_url" in sent:
        if patch.image_url is None:
            merged.pop("image_url", None)
        else:
            merged["image_url"] = patch.image_url
    if "noindex" in sent and patch.noindex is not None:
        merged["noindex"] = bool(patch.noindex)
    return clean_overrides(merged)


__all__ = ["clean_overrides", "effective_seo", "merge_overrides", "overrides_from_input"]
