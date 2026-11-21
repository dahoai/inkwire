# Inkwire

[![create-inkwire](https://img.shields.io/npm/v/create-inkwire.svg?label=create-inkwire)](https://www.npmjs.com/package/create-inkwire)
[![receiver core](https://img.shields.io/npm/v/inkwire-receiver-core.svg?label=inkwire-receiver-core)](https://www.npmjs.com/package/inkwire-receiver-core)
[![conformance](https://img.shields.io/npm/v/inkwire-conformance.svg?label=inkwire-conformance)](https://www.npmjs.com/package/inkwire-conformance)
[![inkwire-mcp](https://img.shields.io/npm/v/inkwire-mcp.svg?label=inkwire-mcp)](https://www.npmjs.com/package/inkwire-mcp)
[![client npm](https://img.shields.io/npm/v/inkwire-client.svg?label=inkwire-client)](https://www.npmjs.com/package/inkwire-client)
[![client PyPI](https://img.shields.io/pypi/v/inkwire-client.svg?label=inkwire-client%20(PyPI))](https://pypi.org/project/inkwire-client/)
[![receiver PyPI](https://img.shields.io/pypi/v/inkwire-receiver-core.svg?label=inkwire-receiver-core%20(PyPI))](https://pypi.org/project/inkwire-receiver-core/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Let your agent run your site's content.** Inkwire is a small, open protocol (REST + JSON) for managing content (blog posts, pages, docs) on a receiving website: upsert by `external_id`, list/read/edit/delete with `ETag`/`If-Match`, tags and categories (with a terms listing), scheduling, a media library (upload, browse, alt text), full SEO control (title, description, Open Graph, JSON-LD, noindex, canonical), server-side sanitization, and read-only keys for audits. The receiver is a drop-in: one command adds it to your site.

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

## Then edit it from Claude Code, Cursor or any MCP agent

```bash
claude mcp add my-site --env INKWIRE_KEY=<key> -- npx -y inkwire-mcp https://my-site.com
```

Now ask in plain words: *"Our plans now start at $12: update the pricing page and its meta description. Show me the change first."* The agent finds the page, shows you the before and after of each change, and writes only after you say yes. [`inkwire-mcp`](packages/inkwire-mcp/README.md) reads the site's discovery and offers only the tools that site supports; any MCP client works (Claude Desktop, Cursor, ...).

**[INSTALL.md](INSTALL.md)** is the full walk-through for people and agents: per-framework notes (Next.js, Express, Astro, FastAPI), SEO page snippets that pass the rendering gate, the Vercel/GitHub-store setup, every environment variable, and how to verify. Already have a database? [Backing it with a database](inkwire/receivers/core-ts/README.md#backing-it-with-a-database) shows the store you write. [`llms.txt`](llms.txt) is the same map for an agent that just landed in this repo.

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
  inkwire-mcp/                   `npx inkwire-mcp <site>`: an MCP server, so Claude, Cursor or any agent edits the site
inkwire/
  SPEC.md                        protocol spec (source of truth alongside the schema)
  schema/                        JSON Schema + validation examples/tests
  conformance/                   `inkwire-conformance`: black-box suites, runner.mjs + cases.json (the API gate), seo-runner.mjs (rendered pages)
  receivers/
    core-ts/                     shared TS core (validate, render, sanitize, stores: file, GitHub, memory): the "real" implementation
    node-express/                the whole API as one Express router over core-ts
    nextjs/                      the whole API as Next.js App Router routes over core-ts (+ a conformant blog page example)
    python-fastapi/              independent Python core + FastAPI adapter, mirrors core-ts field-for-field
  clients/
    node/                        Node client: publish, read, edit, delete, terms, media library
    python/                      Python client, same surface
```

A **receiver** is anything that implements the Inkwire wire contract per the spec (the only required endpoint is `POST /api/content`); `core-ts` and the Python core are reference implementations, not the only way to build one. A **client** is a thin wrapper for calling a receiver from a publisher.

## Protocol semantics, in brief

- **Upsert on `external_id`** (per kind), scoped to the site/API key. Re-POST the same `external_id` to update in place; this is also how idempotency works.
- **Kinds, not just posts.** An entry has a `kind` (`post`, `page`, ...); discovery lists the kinds a site holds.
- **Discovery** (`GET /api/inkwire`) advertises `features`: `upsert`, `list`, `get`, `update`, `delete`, `terms`, `schedule`, `media`, `media_url`, `media_list`, `media_update`, `revisions`, `warnings`, `redirects`, `translations`; plus kinds, site name/description/language and byte limits. A client reads it once and shows only what the site can do.
- **Edit with concurrency:** `PATCH` takes any subset of fields with `ETag`/`If-Match` (`412 stale`); `seo` merges per key; `null` clears. Existing hand-written content shows up with `external_id: null` and is editable like anything else: an edit rewrites only the fields it changed, so a file's own frontmatter (`layout`, `heroImage`, `weight`...) and its spellings (`draft: true`, `date`, `description`) survive.
- **Tags and categories**, filterable in `GET /api/content`, with `GET /api/terms` listing every tag and category the entries use and how many carry it.
- **Scheduling:** `status: published` with a `published_at` in the future. A site that advertises `schedule` holds the entry back until then; clients show it as scheduled.
- **Media library:** `POST /api/media` (file or URL), `GET /api/media` (search, paging), `PATCH /api/media/{id}` (alt text, title). Images only, never SVG.
- **Undo:** every update, restore and delete first keeps the version it replaces (`GET /api/content/{id}/revisions`), and `POST /api/content/{id}/restore {revision}` puts any of them back, a deleted entry included. A restore is itself undoable.
- **SEO warnings and dry runs:** every write answers with `warnings` (a duplicate title, no description, a second H1, a skipped heading, an image without alt text, a link to a page that is not there or to an old address, "click here" link text), and `?dry_run=true` on `POST` or `PATCH` gives the same answer and warnings without writing anything. Warnings never block a write.
- **Redirects:** changing a slug keeps the old address, and the site answers it with one permanent redirect to the new one (`GET /api/redirects?kind=&slug=` says where an old address leads), so a rename keeps its rankings and links.
- **Translations:** `lang` and `translation_key` link the language versions of a page; the site renders `hreflang` for each, itself included.
- **Image sizes:** uploads report their `width` and `height`, and library images in the markdown get them in the HTML, so pages do not shift while they load. A sitemap helper lists the public, indexable entries with `lastmod`.
- **Read-only keys** (`key:ro` in `INKWIRE_API_KEYS`): can audit everything, get `403 forbidden` on any write.
- **Slug**: omit it and the receiver generates and de-dupes one silently (never 409). Provide one that collides with a *different* entry's and you get `409 conflict`.
- **Markdown is canonical.** Receivers render it to sanitized HTML server-side (`markdown-it`/`sanitize-html` in TS, `markdown`/`nh3` in Python): `<script>`, event handlers, and non-http(s) URI schemes are stripped or rejected everywhere, including `cover_image_url`/`canonical_url`.
- **SEO Profile 1:** receivers derive search/social metadata from the entry automatically. Callers may override `seo.title`, `seo.description`, `seo.image_url`, `seo.og_title`, `seo.og_description`, `seo.json_ld` and `seo.noindex`; canonical, author, dates, tags and the cover image (with `cover_image_alt`) reuse the entry's own fields.
- **Every response** carries `Inkwire-Version: 1`. Errors are typed: `invalid_payload` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `stale` (412), `too_large` (413), `rate_limited` (429), `internal` (500).

## Try it

Run a reference receiver and its conformance check. This is the actual gate every receiver must pass, not a smoke test:

```bash
# 1. Build the core, then run the Express receiver (file store in ./content):
cd inkwire/receivers/core-ts && npm install && npm run build
cd ../node-express && npm install
INKWIRE_API_KEYS=dev-key,audit-key:ro npm start &

# 2. Run the suite against it. It reads discovery and runs every case for the features the receiver advertises:
npx inkwire-conformance http://localhost:4000 --key dev-key --readonly-key audit-key
```

`inkwire-conformance` is [a package of its own](inkwire/conformance/README.md): point it at any site, in any language, to prove it speaks the protocol. It writes test entries and deletes them when it finishes (`--keep` leaves them); the one test image it uploads stays, since the protocol has no media delete, so prefer a staging site. In this repo, `npm run conformance` in `inkwire/receivers/node-express`, `inkwire/receivers/nextjs` or `inkwire/receivers/core-ts` starts the receiver on a free port, runs the suite and stops it, and [CI](.github/workflows/ci.yml) runs it against the TypeScript, Express, Next.js and Python receivers on every push.

The suite proves the API. A site that renders returned URLs publicly can additionally run `npx inkwire-conformance <url> --key <key> --seo` to verify SEO Profile 1 page output (title, description, canonical, Open Graph, Twitter, robots, BlogPosting JSON-LD). The receivers themselves only implement the API, so they claim input conformance; the page examples in INSTALL.md (`nextjs/examples`, `node-express/examples`) are what pass the rendering gate.

### Publish and edit from Node

```bash
npm install inkwire-client
```

```js
import { publish, get, update } from "inkwire-client";

const site = "http://localhost:4000"; // the Express receiver started above

const { id } = await publish(site, "dev-key", {
  external_id: "my-post-1",
  title: "Hello",
  markdown: "# Hello\n\nFirst post via Inkwire.",
  status: "published",
});

// Later: read it, then change only the title. The ETag makes a concurrent edit fail (412) instead of overwriting it.
const { etag } = await get(site, "dev-key", id);
await update(site, "dev-key", id, { title: "Hello, world" }, { ifMatch: etag });
```

### Publish and edit from Python

```bash
pip install inkwire-client
```

```python
from inkwire_client import get, publish, update

site = "http://localhost:4000"

entry = publish(site, "dev-key", {
    "external_id": "my-post-1",
    "title": "Hello",
    "markdown": "# Hello\n\nFirst post via Inkwire.",
    "status": "published",
})

_, etag = get(site, "dev-key", entry["id"])
update(site, "dev-key", entry["id"], {"title": "Hello, world"}, if_match=etag)
```

## Status

Inkwire is v1 (`Inkwire-Version: 1`): a frozen schema, a feature-gated conformance suite (`inkwire-conformance`), reference receivers (Express, Next.js, FastAPI) sharing one contract, a one-command installer (`create-inkwire`), an MCP server for agents (`inkwire-mcp`), and Node and Python clients. The badges above show each package's current version.

In production:

- [DadSEO](https://getdadseo.com) runs a receiver on its blog over Postgres (store contract and conformance suite both pass there).
- [Anaella](https://anaella.com) is a publisher and editor: connect any Inkwire site with its address and key, and Anaella's agent tools read, write and edit its posts, pages, SEO fields and media like a WordPress site's.

## License

[MIT](LICENSE)
