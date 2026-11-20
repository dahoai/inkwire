# Inkwire

[![npm](https://img.shields.io/npm/v/inkwire-client.svg)](https://www.npmjs.com/package/inkwire-client)
[![PyPI](https://img.shields.io/pypi/v/inkwire-client.svg)](https://pypi.org/project/inkwire-client/)
[![Receiver PyPI](https://img.shields.io/pypi/v/inkwire-receiver-core.svg)](https://pypi.org/project/inkwire-receiver-core/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A small, open protocol for publishing **and editing** content (blog posts, pages, docs) on any receiving website — REST + JSON, upsert semantics, server-side sanitization, portable SEO defaults, and a full read/edit/delete/media surface an agent can work with.

```
POST /api/content
Authorization: Bearer <site_api_key>
Content-Type: application/json

{ "external_id": "gen-2026-07-22-abc", "title": "...", "markdown": "..." }
```

The full wire contract is in [`inkwire/SPEC.md`](inkwire/SPEC.md); [`inkwire/schema/inkwire-post.schema.json`](inkwire/schema/inkwire-post.schema.json) is the authoritative machine-readable schema where prose and schema disagree.

## Why

Every CMS speaks a different API. Every site that wants to *receive* posts (a marketing site, a docs site, a landing page) has to write a bespoke integration for each one. Inkwire is the opposite: one small contract a receiver implements once, and any publisher can target.

## Repository layout

```
inkwire/
  SPEC.md                        protocol spec (source of truth alongside the schema)
  schema/                        JSON Schema + validation examples/tests
  conformance/                   black-box test suite (cases.json + runner.mjs) — the gate for any receiver
  receivers/
    core-ts/                     shared TS core (validate → render → sanitize → upsert) — the "real" implementation
    node-express/                thin Express adapter over core-ts
    nextjs/                      thin Next.js App Router adapter over core-ts
    python-fastapi/              independent Python core + FastAPI adapter, mirrors core-ts field-for-field
  clients/
    node/                        Node publish() client — idempotency, retry/backoff, typed errors
    python/                      Python publish() client — same behavior
```

A **receiver** is anything that implements the Inkwire wire contract per the spec (the only required endpoint is `POST /api/content`); `core-ts` and the Python core are reference implementations, not the only way to build one. A **client** is a thin wrapper for calling a receiver from a publisher.

## Protocol semantics, in brief

- **Upsert on `external_id`** (per kind), scoped to the site/API key. Re-POST the same `external_id` to update in place — this is also how idempotency works.
- **Full read/edit surface, per feature:** discovery (`GET /api/inkwire`) advertises `features` (`upsert`, `list`, `get`, `update`, `delete`, `media`), the content kinds it holds, and byte limits. `PATCH` takes any subset of fields with `ETag`/`If-Match` concurrency (`412 stale`); `seo` merges per key; `null` clears. Existing hand-written content shows up with `external_id: null` and is editable like anything else.
- **Read-only keys** (`key:ro` in `INKWIRE_API_KEYS`): can audit everything, get `403 forbidden` on any write.
- **Slug**: omit it and the receiver generates + de-dupes one silently (never 409). Provide one that collides with a *different* entry's and you get `409 conflict`.
- **Markdown is canonical.** Receivers render it to sanitized HTML server-side (`markdown-it`/`sanitize-html` in TS, `markdown`/`nh3` in Python) — `<script>`, event handlers, and non-http(s) URI schemes are stripped/rejected everywhere, including `cover_image_url`/`canonical_url`.
- **SEO Profile 1:** receivers derive search/social metadata from the post automatically. Callers may override `seo.title`, `seo.description`, `seo.image_url`, or `seo.noindex`; canonical, author, dates, and tags reuse the existing post fields.
- **Every response** carries `Inkwire-Version: 1`. Errors are typed: `invalid_payload` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `stale` (412), `too_large` (413), `rate_limited` (429), `internal` (500).

## Try it

Pick a receiver and run its conformance check — this is the actual gate every receiver must pass, not just a smoke test:

```bash
# 1. Start any receiver, e.g. the Express one:
cd inkwire/receivers/core-ts && npm install && npm run build
cd ../node-express && npm install
INKWIRE_API_KEYS=dev-key,audit-key:ro npm start &

# 2. Run the conformance suite against it. The runner reads discovery and runs every case for
#    the features the receiver advertises (upsert, list/get, patch + If-Match, delete, media,
#    read-only keys, limits):
cd ../../conformance && npm install
BASE_URL=http://localhost:4000 API_KEY=dev-key READONLY_KEY=audit-key node runner.mjs
```

Same runner works unmodified against `receivers/nextjs` or `receivers/python-fastapi` — that's the point of a black-box conformance suite.

The black-box runner proves SEO wire validation. Receiver-core unit tests must
also prove that effective SEO metadata reaches the application-owned store.

Sites that publicly render returned post URLs can separately run `seo-runner.mjs`
to verify SEO Profile 1 page output. The demo receivers only implement the
receiver API, so they claim input conformance but not rendered-page conformance.

```bash
BASE_URL=https://site.example API_KEY=site-key node seo-runner.mjs
```

### Publish from Node

```bash
npm install inkwire-client
```

```js
import { publish } from "inkwire-client";

await publish("http://localhost:3000", "dev-key", {
  external_id: "my-post-1",
  title: "Hello",
  markdown: "# Hello\n\nFirst post via Inkwire.",
  status: "published",
});
```

### Publish from Python

```bash
pip install inkwire-client
```

```python
from inkwire_client import publish

publish("http://localhost:3000", "dev-key", {
    "external_id": "my-post-1",
    "title": "Hello",
    "markdown": "# Hello\n\nFirst post via Inkwire.",
    "status": "published",
})
```

## Status

v1 (revised in place in November 2026 before adoption: the resource is `/api/content` with a `kind` field, and read/edit/delete/media/discovery were added): frozen schema, feature-gated conformance suite, reference receivers (Express, Next.js, FastAPI) sharing one contract, two client SDKs. Published: `inkwire-client` on [npm](https://www.npmjs.com/package/inkwire-client) and [PyPI](https://pypi.org/project/inkwire-client/), and `inkwire-receiver-core` on [npm](https://www.npmjs.com/package/inkwire-receiver-core) and [PyPI](https://pypi.org/project/inkwire-receiver-core/). The SDKs and reference receivers are being updated to the revised contract now.

## License

[MIT](LICENSE)
