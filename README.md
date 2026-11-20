# Inkwire

[![npm](https://img.shields.io/npm/v/inkwire-client.svg)](https://www.npmjs.com/package/inkwire-client)
[![PyPI](https://img.shields.io/pypi/v/inkwire-client.svg)](https://pypi.org/project/inkwire-client/)
[![Receiver PyPI](https://img.shields.io/pypi/v/inkwire-receiver-core.svg)](https://pypi.org/project/inkwire-receiver-core/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Let your agent publish and edit any site.** Inkwire is a small, open protocol (REST + JSON) for publishing **and editing** content (blog posts, pages, docs) on a receiving website: upsert by `external_id`, list/read/edit/delete with `ETag`/`If-Match`, image upload, server-side sanitization, portable SEO defaults, and read-only keys for audits. The receiver is a drop-in: one command adds it to your site.

## Add it to your site (about two minutes)

Paste this into Cursor, Claude Code or any coding agent opened on your site's repo:

```text
Add an Inkwire receiver to this site so my agent can publish and edit its content.
Run `npx create-inkwire --yes`, then follow https://github.com/dahoai/inkwire/blob/master/INSTALL.md
to render published entries with SEO tags, and check /api/inkwire answers.
```

or do it yourself:

```bash
cd my-site            # Next.js (App Router) or Express; FastAPI prints manual steps
npx create-inkwire    # writes the routes, adds the dependency, generates two keys (full + read-only), prints them once
```

**[INSTALL.md](INSTALL.md)** is the full walk-through for people and agents: per-framework notes (Next.js, Express, Astro, FastAPI), SEO page snippets that pass the rendering gate, the Vercel/GitHub-store setup, every environment variable, and how to verify. [`llms.txt`](llms.txt) is the same map for an agent that just landed in this repo.

```
POST /api/content
Authorization: Bearer <site_api_key>
Content-Type: application/json

{ "external_id": "gen-2026-07-22-abc", "title": "...", "markdown": "..." }
```

The full wire contract is in [`inkwire/SPEC.md`](inkwire/SPEC.md); the schemas in [`inkwire/schema/`](inkwire/schema/) (`inkwire-content.schema.json` for create, `inkwire-patch.schema.json`, `inkwire-media.schema.json`, `inkwire-discovery.schema.json`) are authoritative where prose and schema disagree.

## Why

Every CMS speaks a different API. Every site that wants to *receive* posts (a marketing site, a docs site, a landing page) has to write a bespoke integration for each one, and none of them let an agent come back later to fix a typo. Inkwire is the opposite: one small contract a receiver implements once, and any publisher or agent can target.

## Repository layout

```
INSTALL.md                       how to add Inkwire to a site (human + agent)
llms.txt                         the repo map for an agent that just landed here
packages/
  create-inkwire/                `npx create-inkwire`: detects the framework, writes the receiver, makes the keys
inkwire/
  SPEC.md                        protocol spec (source of truth alongside the schema)
  schema/                        JSON Schema + validation examples/tests
  conformance/                   black-box suites: runner.mjs + cases.json (the API gate), seo-runner.mjs (rendered pages)
  receivers/
    core-ts/                     shared TS core (validate, render, sanitize, stores: file, GitHub, memory): the "real" implementation
    node-express/                the whole API as one Express router over core-ts
    nextjs/                      the whole API as Next.js App Router routes over core-ts (+ a conformant blog page example)
    python-fastapi/              independent Python core + FastAPI adapter, mirrors core-ts field-for-field
  clients/
    node/                        Node client (publish, and the read/edit surface in newer versions)
    python/                      Python client, same behavior
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

Run a reference receiver and its conformance check. This is the actual gate every receiver must pass, not a smoke test:

```bash
# 1. Build the core, then run the Express receiver (file store in ./content):
cd inkwire/receivers/core-ts && npm install && npm run build
cd ../node-express && npm install
INKWIRE_API_KEYS=dev-key,audit-key:ro npm start &

# 2. Run the suite against it. The runner reads discovery and runs every case for the features the
#    receiver advertises (upsert, list/get, patch + If-Match, delete, media, read-only keys, limits):
cd ../../conformance && npm install
BASE_URL=http://localhost:4000 API_KEY=dev-key READONLY_KEY=audit-key node runner.mjs
```

Or in one step, `npm run conformance` in `inkwire/receivers/node-express`, `inkwire/receivers/nextjs` or `inkwire/receivers/core-ts` starts the receiver on a free port, runs the runner and stops it. The same runner works unmodified against `receivers/python-fastapi`: that is the point of a black-box suite.

The runner proves the API. Receiver-core unit tests must also prove that effective SEO metadata reaches the store. A site that renders returned URLs publicly can additionally run `seo-runner.mjs` to verify SEO Profile 1 page output (title, description, canonical, Open Graph, Twitter, robots, BlogPosting JSON-LD). The receivers themselves only implement the API, so they claim input conformance; the page examples in INSTALL.md (`nextjs/examples`, `node-express/examples`) are what pass the rendering gate.

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

v1 (revised in place in November 2026 before adoption: the resource is `/api/content` with a `kind` field, and read/edit/delete/media/discovery were added): frozen schema, feature-gated conformance suite, reference receivers (Express, Next.js, FastAPI) sharing one contract, a one-command installer (`create-inkwire`, unpublished), two client SDKs. Published: `inkwire-client` on [npm](https://www.npmjs.com/package/inkwire-client) and [PyPI](https://pypi.org/project/inkwire-client/), and `inkwire-receiver-core` on [npm](https://www.npmjs.com/package/inkwire-receiver-core) and [PyPI](https://pypi.org/project/inkwire-receiver-core/). The published versions predate the revised contract: the receivers (`inkwire-receiver-core` 0.3.0 on npm, 0.2.0 on PyPI) and the clients (Node 0.4.0, Python 0.2.0) in this repo implement it, pass the conformance suite, and are not released yet. `create-inkwire` needs `inkwire-receiver-core` 0.3.0 on npm first.

## License

[MIT](LICENSE)
