# Inkwire v1 — Specification

The machine-readable request schemas are `schema/inkwire-content.schema.json` (create),
`schema/inkwire-patch.schema.json` (edit) and `schema/inkwire-discovery.schema.json`
(discovery); they are authoritative where prose and schema disagree.

## The wire contract

### Endpoint

`POST /api/content` — create or update one **content entry**: a markdown document with
metadata (a blog post, a page, a changelog entry…). Every endpoint below shares the `/api`
prefix and the bearer auth. A receiver that only wants the publish flow implements the one
endpoint; everything else is an optional feature (see Discovery).

### Request

```http
POST /api/content
Authorization: Bearer <site_api_key>
Content-Type: application/json
Idempotency-Key: gen-2026-07-22-abc        # optional; defaults to external_id
```

```jsonc
{
  "external_id": "gen-2026-07-22-abc",   // REQUIRED. Stable caller id. Upsert key.
  "title": "How we cut audit time 40%",  // REQUIRED.
  "markdown": "# Body...\n\nText.",       // REQUIRED. Canonical content.
  "kind": "post",                         // optional. "post" (default), "page", ... — what the receiver holds.
  "slug": "cut-audit-time",               // optional. Receiver finalizes/dedupes.
  "excerpt": "Short summary",             // optional.
  "tags": ["seo", "ai"],                  // optional. string[].
  "categories": ["Guides"],               // optional. string[]. A second, coarser grouping.
  "cover_image_url": "https://.../c.jpg", // optional. URL only.
  "cover_image_alt": "A red bicycle",     // optional. Alt text for the cover image.
  "canonical_url": "https://origin/post", // optional. Cross-post SEO.
  "seo": {                                // optional SEO Profile 1 overrides.
    "title": "Search result title",
    "description": "Search result description",
    "image_url": "https://.../og.jpg",
    "noindex": false,
    "og_title": "Social card title",
    "og_description": "Social card description",
    "json_ld": "{\"@context\":\"https://schema.org\",\"@type\":\"FAQPage\"}"
  },
  "author": { "name": "Isaac", "email": "i@x.com" }, // optional.
  "status": "published",                  // "published" | "draft". Default "draft".
  "published_at": "2026-07-22T04:00:00Z"  // optional ISO-8601. Default now(). In the future = scheduled.
}
```

### Response `200`

```json
{
  "id": "142",
  "external_id": "gen-2026-07-22-abc",
  "url": "https://site/blog/cut-audit-time",
  "slug": "cut-audit-time",
  "kind": "post",
  "status": "published",
  "created": true
}
```

`created: false` means an existing entry (same `external_id`, same `kind`) was updated.

Response header: `Inkwire-Version: 1`.

### Semantics

- **Upsert on `external_id`, scoped to the site/key and kind.** Re-POST the same
  `external_id` (and `kind`) → update in place (never duplicate). This is both idempotency and
  the "update" operation for callers that hold the whole entry. To change part of an existing
  entry, or one the receiver already had, use `PATCH` (see Reading and editing).
- **Slug:** if `slug` is **omitted**, the receiver generates one (slugify title)
  and silently de-duplicates collisions (e.g. `-2` suffix) — never a 409. If the
  caller **explicitly provides** a `slug` that a *different* entry (same kind)
  already owns, the receiver returns `409 conflict` rather than silently changing
  it. Final slug is always returned in the response.
- **Status:** `draft` entries are stored but not publicly listed/rendered.
- **Scheduling:** a `published` entry whose `published_at` is in the future is **scheduled**: it is
  stored now and goes live when that time arrives. A receiver that really holds such entries back
  advertises the `schedule` feature; one that does not would publish it at once, so a publisher
  only schedules against a receiver that advertises it. Reads report `status: "published"` with the
  future `published_at`; clients derive "scheduled" from the two.
- **Kind:** entries of different kinds never collide on `external_id` or `slug`. A `kind` the
  receiver does not hold is a `400 invalid_payload`.

### SEO Profile 1

SEO Profile 1 is part of the content contract, not a separate endpoint. The
optional `seo` object contains overrides only; receivers derive effective SEO
metadata for every entry and pass it to their storage/rendering integration:

```text
title       = seo.title       ?? title
description = seo.description ?? first non-empty value of (excerpt, title)
image_url   = seo.image_url   ?? cover_image_url (may be absent)
noindex     = seo.noindex     ?? false
og_title    = seo.og_title    ?? title        (the effective title above)
og_description = seo.og_description ?? description (the effective description above)
json_ld     = seo.json_ld     (absent when not set)
canonical   = canonical_url   ?? the entry's absolute public URL
```

`seo.json_ld` is one JSON object (or array of objects) serialized as a string, at most 20000
characters; a value that does not parse is `400 invalid_payload`. It is emitted as an additional
JSON-LD block next to the generated one.

`seo.title`, `seo.description`, `seo.og_title` and `seo.og_description` must be non-empty when provided. SEO URLs
must use `http://` or `https://`. Unknown properties are invalid. Existing
top-level fields remain authoritative for canonical URL, author, publication
date, and tags; the profile does not duplicate them inside `seo`.

A receiver core conforms to the **SEO input profile** when it validates these
overrides and supplies the effective `title`, `description`, `image_url`, `noindex`,
`og_title`, `og_description` and `json_ld` values to the application-owned store. The public URL is only known
after the store finalizes the entry, so the page renderer applies the canonical
fallback.

A site may additionally claim **SEO rendering conformance** for publicly
accessible `published` entries. Its returned HTML page must safely render:

- one document `<title>` using the effective title;
- `description`, canonical, `og:type=article`, `og:title` (the effective `og_title`),
  `og:description` (the effective `og_description`), and `og:url` tags;
- `twitter:card`, `twitter:title`, and `twitter:description` tags;
- `og:image` and `twitter:image` when an effective image exists;
- `<meta name="robots" content="noindex,follow">` when `noindex` is true; and
- JSON-LD with `@context: https://schema.org`, `@type: BlogPosting`, `headline`,
  `description`, `url`, `mainEntityOfPage`, and `datePublished`, plus `image`,
  `author`, and `keywords` when their source fields exist.

When present, JSON-LD `author` is a `Person` object with `name`, and `keywords`
is an array containing the entry tags. `mainEntityOfPage` may be the canonical URL
string or a `WebPage` object whose `@id` is that URL.

Metadata values must be HTML-escaped. JSON-LD must be serialized so
caller-controlled text cannot terminate its `<script>` element. Additional
site-wide metadata is allowed. Draft entries remain non-public under the base
protocol and cannot claim rendering conformance.

### Discovery: `GET /api/inkwire`

One unauthenticated-light request that tells a publisher what this receiver can do. Same bearer
auth as everything else.

```json
{
  "inkwire": 1,
  "site": { "name": "Acme", "url": "https://acme.com", "description": "Acme's blog", "language": "en" },
  "features": ["upsert", "list", "get", "update", "delete", "terms", "schedule", "media", "media_url", "media_list", "media_update"],
  "kinds": ["post", "page"],
  "limits": { "markdown_bytes": 1000000, "media_bytes": 10000000 }
}
```

`upsert` is always present. `site.description` and `site.language` (a BCP 47 tag) are optional. `kinds` lists what the receiver holds (publishers must not send
other kinds). `limits` are ceilings in bytes; a request over one answers `413 too_large`. A receiver without this endpoint answers
404 and clients treat it as `features: ["upsert"]`, `kinds: ["post"]`, no limits.

### Reading: `GET /api/content`, `GET /api/content/{id}`  (features `list`, `get`)

`GET /api/content?status=&kind=&tag=&category=&search=&external_id=&slug=&limit=&cursor=` returns

```json
{ "items": [ ContentSummary ], "next_cursor": "opaque-or-null" }
```

Entries come **newest first**: by `updated_at` descending, ties broken by `id`. `limit` defaults to 20, at most 100. `cursor` is opaque: pass back `next_cursor` to get the next
page. `search` matches title, excerpt and markdown, case-insensitively. `tag` matches one tag, `category` one category.
Drafts are listed to a caller who holds a key. `GET /api/content/{id}` returns the full entry.

`ContentSummary`: `id`, `external_id` (or `null`), `kind`, `title`, `slug`, `url`, `status`,
`excerpt`, `tags`, `categories`, `published_at`, `updated_at`. The full entry adds `markdown`,
`cover_image_url`, `cover_image_alt`, `canonical_url`, `author`, and `seo`, which holds the
**effective** values (the overrides applied over the derived defaults from SEO Profile 1:
`title`, `description`, `image_url`, `noindex`, `og_title`, `og_description`, `json_ld`). Every single-entry response carries an `ETag` header — opaque, changes
on every accepted write.

Entries the site already had, or wrote by hand, are first-class: they appear in listings with
`external_id: null` and can be read and edited like any other. That is what makes an existing
site auditable on day one.

### Editing: `PATCH /api/content/{id}`  (feature `update`)

Body: any subset of the publish fields (`title`, `kind`, `markdown`, `slug`, `excerpt`, `tags`,
`categories`, `cover_image_url`, `cover_image_alt`, `canonical_url`, `seo`, `author`, `status`,
`published_at`). Given fields replace the stored value; omitted fields keep theirs; `null`
clears an optional field (`excerpt`, `tags`, `categories`, `cover_image_url`, `cover_image_alt`,
`canonical_url`, `seo`, `author`, `published_at`).
`seo` present as an object is merged per key. `external_id` cannot be changed (a body that
carries it is `400 invalid_payload`). A `kind` change is allowed when the receiver holds the
target kind; slug rules then apply in the target kind. A new `slug` follows the publish rules
(409 if a different entry of that kind owns it) and changes the entry's URL.

Send `If-Match: <etag>` from the read the edit is based on. If the entry changed since, the
answer is `412 stale` and nothing is written, so two editors never overwrite each other.
Receivers that advertise `update` MUST honour `If-Match` when it is sent.

Text edits are computed by the client: fetch the entry, replace the exact passage in `markdown`
(the SDKs have an `edits` helper that requires each `find` to match exactly once), `PATCH` the
whole `markdown` with `If-Match`. The receiver never has to merge text.

The response is the full updated entry with its new `ETag`.

### Deleting: `DELETE /api/content/{id}`  (feature `delete`)

Removes the entry from the public site. A receiver may keep it internally (trash, or a `draft`
flip) but it must stop being public. Honours `If-Match`. Response:
`{ "id": "...", "deleted": true }`.

### Terms: `GET /api/terms`  (feature `terms`)

The tags and categories the entries use. There is nothing to create: a term exists while an
entry carries it. `GET /api/terms?kind=&search=&limit=` (`kind` is `tag` or `category`, `search`
a case-insensitive substring of the name, `limit` defaults to 100, at most 500) returns

```json
{ "items": [ { "kind": "tag", "name": "SEO", "slug": "seo", "count": 12 } ] }
```

Most used first, then by name (compared case-insensitively). Names that differ only in case are one term (the most used
spelling is reported). `count` is the number of entries carrying it, drafts included.

### Media: `POST /api/media`  (feature `media`; `media_url` for the JSON form)

`multipart/form-data` with a `file` part and an optional `alt` field. A receiver that also advertises `media_url`
accepts JSON `{ "url": "https://...", "alt": "..." }` for it to fetch (SSRF-guarded: public `http(s)` hosts only);
without `media_url` that form answers `400 invalid_payload`. Response:

```json
{ "id": "...", "url": "https://site/uploads/x.jpg", "alt": "...", "mime_type": "image/jpeg", "created_at": "2026-07-22T04:00:00.000Z" }
```

Use `url` in markdown or as `cover_image_url`. Only images (`jpeg`, `png`, `gif`, `webp`,
`avif`; never SVG) up to `limits.media_bytes` (over it: `413 too_large`). A site with nowhere to store files omits the
feature: `cover_image_url` and markdown images keep working with any public URL.

### The media library: `GET /api/media`, `PATCH /api/media/{id}`  (features `media_list`, `media_update`)

`GET /api/media?search=&limit=&cursor=` lists what was uploaded, newest first (by `created_at`,
ties by `id`), with the same `limit` and `cursor` rules as content:

```json
{ "items": [ { "id": "...", "url": "...", "alt": "...", "title": "...", "mime_type": "image/png", "created_at": "..." } ], "next_cursor": null }
```

`search` matches the alt text, title and filename. `PATCH /api/media/{id}` takes `{ "alt"?: string | null, "title"?: string | null }`
(at least one; `null` clears) and answers with the media item. Unknown id: `404 not_found`.


### Errors

```json
{ "error": { "code": "invalid_payload", "message": "title is required" } }
```

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `invalid_payload` | Missing/invalid required fields, or a `kind` the receiver does not hold. |
| 401 | `unauthorized` | Missing/bad API key. |
| 403 | `forbidden` | The key is read-only and the call writes. |
| 404 | `not_found` | No entry (or media) with that `id`, or an unknown endpoint. |
| 409 | `conflict` | Requested `slug` already used by a *different* entry of that kind. |
| 412 | `stale` | `If-Match` no longer matches: the entry changed since the caller read it. |
| 413 | `too_large` | Body or upload over the receiver's `limits`. |
| 429 | `rate_limited` | Per-key rate limit exceeded. |
| 500 | `internal` | Receiver/storage failure. |

### Versioning

`Inkwire-Version: 1`. Only additive changes within v1 (new optional fields, new optional
endpoints advertised by discovery). Breaking changes bump the version (path or header
negotiated).

---

## Auth

**Per-site bearer API key over HTTPS.** Each site holds one or more revocable keys. Callers send
`Authorization: Bearer <key>`.

**Key modes.** A key is full (default) or read-only. A read-only key may call every `GET`
(discovery, list, single) and receives `403 forbidden` on any call that writes. Handy for
letting an agent audit a site before it may change it. Reference receivers read keys from
`INKWIRE_API_KEYS`, a comma-separated list where a `:ro` suffix marks a key read-only:
`INKWIRE_API_KEYS=dev-key,audit-key:ro`.

**Optional hardening (documented, not required):** `X-Signature:
sha256=<hmac(raw_body, key)>` for body integrity + replay resistance. Receivers
MAY verify it; the spec reserves the header.

---

## Content safety (required in every receiver)

Markdown is canonical; **the receiver renders and sanitizes**. Rendered HTML MUST
strip `<script>`, event handlers (`on*`), `javascript:` URIs, and disallowed
tags. Callers never ship executable HTML. This is baked into the reference
receivers so every app is safe by default.

**Canonical allowlist (normative).** Every receiver's sanitizer MUST allow
exactly this set — no more, no less. It is `sanitize-html`'s default
`allowedTags` unioned with `img` (`h1`/`h2` are already in that default set):

```
a, abbr, address, article, aside, b, bdi, bdo, blockquote, br, caption, cite,
code, col, colgroup, data, dd, dfn, div, dl, dt, em, figcaption, figure,
footer, h1, h2, h3, h4, h5, h6, header, hgroup, hr, i, img, kbd, li, main,
mark, menu, nav, ol, p, pre, q, rb, rp, rt, rtc, ruby, s, samp, section,
small, span, strong, sub, sup, table, tbody, td, tfoot, th, thead, time, tr,
u, ul, var, wbr
```

Only two tags keep any attributes; every other tag is stripped of all
attributes:

| Tag | Allowed attributes |
| --- | --- |
| `a` | `href`, `name`, `rel` |
| `img` | `src`, `alt`, `title` |

Allowed URL schemes (for `href`/`src`, and enforced separately on
`cover_image_url`/`canonical_url`, which are never rendered as markdown):
`http`, `https`, `mailto`.

`cover_image_url`, `canonical_url`, and `seo.image_url` are plain URL fields, not markdown —
they bypass the HTML sanitizer entirely and go straight to storage, so they
are independently restricted to `http://`/`https://` at the schema level.
