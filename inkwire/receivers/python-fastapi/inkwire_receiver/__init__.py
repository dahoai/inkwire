"""Inkwire receiver core (Python): auth, validation, render, stores and one handler per endpoint."""

from __future__ import annotations

from .auth import DEFAULT_SCOPE, ApiKey, authorize, parse_api_keys, require_write
from .errors import HTTP_STATUS, InkwireError
from .file_store import FileStore, split_frontmatter
from .fetch import assert_public_url, guarded_fetcher
from .handle import (
    DEFAULT_KINDS,
    KNOWN_FEATURES,
    InkwireConfig,
    Limits,
    Site,
    discovery_body,
    handle_delete,
    handle_discovery,
    handle_get,
    handle_list,
    handle_media,
    handle_patch,
    handle_upsert,
    public_url,
)
from .media import IMAGE_TYPES, sniff_image, validate_image
from .render import ALLOWED_ATTRIBUTES, ALLOWED_TAGS, edits, render_markdown, slugify
from .schema import Author, ContentInput, MediaUrlInput, PatchInput, PatchSeo, SeoInput
from .seo import effective_seo, merge_overrides
from .store import (
    ContentStore,
    ListFilter,
    MediaResult,
    MediaUpload,
    MemoryStore,
    SeoMetadata,
    SeoOverrides,
    StoredContent,
)

__all__ = [
    "ALLOWED_ATTRIBUTES",
    "ALLOWED_TAGS",
    "ApiKey",
    "Author",
    "ContentInput",
    "ContentStore",
    "DEFAULT_SCOPE",
    "DEFAULT_KINDS",
    "FileStore",
    "HTTP_STATUS",
    "IMAGE_TYPES",
    "InkwireConfig",
    "InkwireError",
    "KNOWN_FEATURES",
    "Limits",
    "ListFilter",
    "MediaResult",
    "MediaUpload",
    "MediaUrlInput",
    "MemoryStore",
    "PatchInput",
    "PatchSeo",
    "SeoInput",
    "SeoMetadata",
    "SeoOverrides",
    "Site",
    "StoredContent",
    "assert_public_url",
    "authorize",
    "discovery_body",
    "edits",
    "effective_seo",
    "guarded_fetcher",
    "handle_delete",
    "handle_discovery",
    "handle_get",
    "handle_list",
    "handle_media",
    "handle_patch",
    "handle_upsert",
    "merge_overrides",
    "parse_api_keys",
    "public_url",
    "render_markdown",
    "require_write",
    "slugify",
    "sniff_image",
    "split_frontmatter",
    "validate_image",
]
