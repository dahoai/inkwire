"""Pydantic mirrors of the request schemas.

- ``schema/inkwire-content.schema.json``     -> :class:`ContentInput` (create / upsert)
- ``schema/inkwire-patch.schema.json``       -> :class:`PatchInput` (edit)
- ``schema/inkwire-media.schema.json``       -> :class:`MediaUrlInput` (fetch-by-url media)
- ``schema/inkwire-media-patch.schema.json`` -> :class:`MediaPatchInput` (media library edit)

Bounds, patterns and nullability follow the JSON schemas. ``seo`` is stored as the
overrides the caller sent; merging and SEO Profile 1 derivation live in the handler /
:mod:`inkwire_receiver.seo`, not here.
"""

from __future__ import annotations

import json
import re
from datetime import datetime

from email_validator import EmailNotValidError, validate_email
from pydantic import (
    AnyUrl,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    TypeAdapter,
    ValidationError,
    field_validator,
    model_validator,
)

KIND_PATTERN = r"^[a-z][a-z0-9_-]{0,63}$"
SLUG_PATTERN = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
KIND_RE = re.compile(KIND_PATTERN)
SLUG_RE = re.compile(SLUG_PATTERN)
HTTP_URL_RE = re.compile(r"^https?://")
LANG_PATTERN = r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$"
DATE_TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")

_URL = TypeAdapter(AnyUrl)


def _http_url(value: str) -> str:
    """http(s) inline URL field: restricted at the schema level, never sanitized as HTML."""
    if not HTTP_URL_RE.match(value):
        raise ValueError("must be an http(s) URL")
    try:
        _URL.validate_python(value)
    except ValidationError:  # pragma: no cover - pattern already rejects the common cases
        raise ValueError("must be a valid URL") from None
    return value


def _json_ld(value: str) -> str:
    """One JSON object, or a non-empty array of objects, serialized (``seo.json_ld``)."""
    try:
        parsed = json.loads(value)
    except ValueError:
        raise ValueError("must be one JSON object, or an array of objects, as a string") from None
    objects = parsed if isinstance(parsed, list) and parsed else [parsed]
    if not all(isinstance(item, dict) for item in objects):
        raise ValueError("must be one JSON object, or an array of objects, as a string")
    return value


def _term(value: str) -> str:
    if not 1 <= len(value) <= 64:
        raise ValueError("terms must be 1 to 64 characters each")
    return value


def _email(value: str) -> str:
    """A plain mailbox address.

    ``format: email`` in the JSON schema is syntax only: a reserved domain such as
    ``example.test`` is a valid address for a publisher's staging site, so the
    deliverability / special-use-domain checks are off.
    """
    try:
        validate_email(value, check_deliverability=False, test_environment=True)
    except EmailNotValidError as exc:
        raise ValueError(f"must be a valid email address: {exc}") from None
    return value


def _date_time(value: str) -> str:
    """RFC 3339 date-time with a time component and an offset (date-only is invalid)."""
    if not DATE_TIME_RE.match(value):
        raise ValueError("must be an RFC 3339 date-time (a time component and Z/offset are required)")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00").replace("z", "+00:00"))
    except ValueError:
        raise ValueError("must be an RFC 3339 date-time") from None
    return value


class Author(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = None
    email: str | None = None

    @field_validator("email")
    @classmethod
    def _email(cls, value: str | None) -> str | None:
        return value if value is None else _email(value)


class SeoInput(BaseModel):
    """Create-time ``seo`` object: overrides only, nothing nullable."""

    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, min_length=1, max_length=512)
    description: str | None = Field(default=None, min_length=1, max_length=1024)
    image_url: str | None = None
    noindex: StrictBool = False
    og_title: str | None = Field(default=None, min_length=1, max_length=512)
    og_description: str | None = Field(default=None, min_length=1, max_length=1024)
    json_ld: str | None = Field(default=None, min_length=2, max_length=20000)

    @field_validator("title", "description", "image_url", "og_title", "og_description", "json_ld", mode="before")
    @classmethod
    def _not_null(cls, value):
        if value is None:
            raise ValueError("SEO overrides cannot be null")
        return value

    @field_validator("image_url")
    @classmethod
    def _image_url(cls, value: str) -> str:
        return _http_url(value)

    @field_validator("json_ld")
    @classmethod
    def _json_ld_value(cls, value: str) -> str:
        return _json_ld(value)


class ContentInput(BaseModel):
    """``POST /api/content`` body."""

    model_config = ConfigDict(extra="forbid")

    external_id: str = Field(min_length=1, max_length=255)
    title: str = Field(min_length=1, max_length=512)
    markdown: str = Field(min_length=1)
    kind: str = Field(default="post", pattern=KIND_PATTERN)
    slug: str | None = Field(default=None, max_length=255, pattern=SLUG_PATTERN)
    excerpt: str | None = Field(default=None, max_length=1024)
    tags: list[str] | None = Field(default=None, max_length=50)
    categories: list[str] | None = Field(default=None, max_length=50)
    cover_image_url: str | None = None
    cover_image_alt: str | None = Field(default=None, max_length=1024)
    canonical_url: str | None = None
    seo: SeoInput | None = None
    author: Author | None = None
    lang: str | None = Field(default=None, max_length=35, pattern=LANG_PATTERN)
    translation_key: str | None = Field(default=None, min_length=1, max_length=255)
    status: str = Field(default="draft", pattern="^(draft|published)$")
    published_at: str | None = None

    @field_validator(
        "slug",
        "lang",
        "translation_key",
        "excerpt",
        "tags",
        "categories",
        "cover_image_url",
        "cover_image_alt",
        "canonical_url",
        "seo",
        "author",
        "published_at",
        mode="before",
    )
    @classmethod
    def _not_null(cls, value):
        """Create has nothing to clear: an optional field is absent or has a value."""
        if value is None:
            raise ValueError("must not be null")
        return value

    @field_validator("tags")
    @classmethod
    def _tag_length(cls, value):
        if value is not None:
            for tag in value:
                if len(tag) > 64:
                    raise ValueError("tags must be at most 64 characters each")
        return value

    @field_validator("categories")
    @classmethod
    def _category_length(cls, value):
        return value if value is None else [_term(category) for category in value]

    @field_validator("cover_image_url", "canonical_url")
    @classmethod
    def _url_fields(cls, value: str | None) -> str | None:
        return value if value is None else _http_url(value)

    @field_validator("published_at")
    @classmethod
    def _published_at(cls, value: str | None) -> str | None:
        return value if value is None else _date_time(value)


class PatchSeo(BaseModel):
    """Patch-time ``seo`` object: every key optional; ``image_url`` may be null to drop it."""

    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, min_length=1, max_length=512)
    description: str | None = Field(default=None, min_length=1, max_length=1024)
    image_url: str | None = None
    noindex: StrictBool | None = None
    og_title: str | None = Field(default=None, min_length=1, max_length=512)
    og_description: str | None = Field(default=None, min_length=1, max_length=1024)
    json_ld: str | None = Field(default=None, min_length=2, max_length=20000)

    @field_validator("title", "description", "og_title", "og_description", mode="before")
    @classmethod
    def _not_null(cls, value):
        if value is None:
            raise ValueError("this SEO override cannot be null")
        return value

    @field_validator("json_ld")
    @classmethod
    def _json_ld_value(cls, value: str | None) -> str | None:
        return value if value is None else _json_ld(value)

    @field_validator("noindex", mode="before")
    @classmethod
    def _noindex_not_null(cls, value):
        if value is None:
            raise ValueError("noindex cannot be null")
        return value

    @field_validator("image_url")
    @classmethod
    def _image_url(cls, value: str | None) -> str | None:
        return value if value is None else _http_url(value)


class PatchInput(BaseModel):
    """``PATCH /api/content/{id}`` body: any subset, at least one field, no ``external_id``."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=512)
    kind: str | None = Field(default=None, pattern=KIND_PATTERN)
    markdown: str | None = Field(default=None, min_length=1)
    slug: str | None = Field(default=None, max_length=255, pattern=SLUG_PATTERN)
    excerpt: str | None = Field(default=None, max_length=1024)
    tags: list[str] | None = Field(default=None, max_length=50)
    categories: list[str] | None = Field(default=None, max_length=50)
    cover_image_url: str | None = None
    cover_image_alt: str | None = Field(default=None, max_length=1024)
    canonical_url: str | None = None
    seo: PatchSeo | None = None
    author: Author | None = None
    lang: str | None = Field(default=None, max_length=35, pattern=LANG_PATTERN)
    translation_key: str | None = Field(default=None, min_length=1, max_length=255)
    status: str | None = Field(default=None, pattern="^(draft|published)$")
    published_at: str | None = None

    @field_validator("tags")
    @classmethod
    def _tag_length(cls, value):
        if value is not None:
            for tag in value:
                if len(tag) > 64:
                    raise ValueError("tags must be at most 64 characters each")
        return value

    @field_validator("categories")
    @classmethod
    def _category_length(cls, value):
        return value if value is None else [_term(category) for category in value]

    @field_validator("cover_image_url", "canonical_url")
    @classmethod
    def _url_fields(cls, value: str | None) -> str | None:
        return value if value is None else _http_url(value)

    @field_validator("published_at")
    @classmethod
    def _published_at(cls, value: str | None) -> str | None:
        return value if value is None else _date_time(value)

    @model_validator(mode="after")
    def _shape(self):
        if not self.model_fields_set:
            raise ValueError("the patch must carry at least one field")
        for name in ("title", "kind", "markdown", "slug", "status"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be null")
        return self


class MediaUrlInput(BaseModel):
    """``POST /api/media`` JSON variant: the receiver fetches and stores the file."""

    model_config = ConfigDict(extra="forbid")
    url: str
    alt: str | None = Field(default=None, max_length=1024)

    @field_validator("url")
    @classmethod
    def _url(cls, value: str) -> str:
        return _http_url(value)


class MediaPatchInput(BaseModel):
    """``PATCH /api/media/{id}`` body: ``alt`` and/or ``title``; ``null`` clears one."""

    model_config = ConfigDict(extra="forbid")
    alt: str | None = Field(default=None, max_length=1024)
    title: str | None = Field(default=None, max_length=512)

    @model_validator(mode="after")
    def _shape(self):
        if not self.model_fields_set:
            raise ValueError("the patch must carry at least one field")
        return self

    def changes(self) -> dict[str, str | None]:
        """Only the fields the caller sent (a ``None`` value clears)."""
        return {name: getattr(self, name) for name in ("alt", "title") if name in self.model_fields_set}


def validation_message(exc: ValidationError) -> str:
    """One readable line for the ``invalid_payload`` message, e.g. ``title: Field required``."""
    error = exc.errors()[0]
    location = ".".join(str(part) for part in error.get("loc", ())) or "body"
    return f"{location}: {error.get('msg', 'invalid value')}"


__all__ = [
    "Author",
    "ContentInput",
    "MediaPatchInput",
    "MediaUrlInput",
    "PatchInput",
    "PatchSeo",
    "SeoInput",
    "KIND_PATTERN",
    "SLUG_PATTERN",
    "validation_message",
]
