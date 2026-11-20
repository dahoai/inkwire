# Inkwire: read, edit and drop-in receivers (additive, still v1)

**Status:** Draft for review. **Date:** 2026-11-20. **Normative text:** `inkwire/SPEC.md`,
section "Reading and editing" (already drafted there).

## Why

Nobody uses Inkwire yet, so it changes in place: no `v2`, no `Inkwire-Version` bump. Today it can
only publish. After the CMS work in Anaella (WordPress and Ghost clients, 14 `cms.*` tools, the
find a weak page → read → propose → approve → apply loop) the gap is clear: a custom site cannot
be audited or edited, and every site owner must write a store before anything works. Two barriers:

1. **Capability:** no read, list, edit, delete or media.
2. **Effort:** a receiver means writing a database-backed `PostStore` and routes.

## Decisions

### Protocol (all additive; `POST /api/posts` is unchanged)

- Discovery `GET /api/inkwire` returns `features`, `kinds`, `limits`. A receiver without it is
  treated as upsert-only, so every existing receiver still conforms.
- `GET` list and single, `PATCH`, `DELETE`, `POST /api/media`: each an optional feature.
- Posts are addressed by the receiver's `id`. Posts the site already had show up with
  `external_id: null` and can be edited: an existing site is auditable on day one.
- **No server-side text editing.** The client fetches `markdown`, replaces the exact passage
  (an SDK `edits` helper, each `find` must match exactly once), and `PATCH`es the whole
  `markdown` with `If-Match`. `ETag` + `412 stale` is the concurrency control. The receiver never
  merges text, which is what keeps receivers small.
- `seo` is returned as effective values and every field is writable: title, description, OG
  image, noindex, canonical. Better than WordPress, where Yoast exposes only two.
- `kind: "post" | "page"` is optional and advertised, so one receiver can hold both.
- Read-only keys (`403 forbidden` on writes) so an agent can audit before it may change.
- Media: multipart or `{url}` fetch (SSRF-guarded), images only, never SVG; optional feature.

### Removing the effort barrier

1. **The core does everything but storage.** Validation, auth, scopes, slugs, sanitising, ETags,
   cursors, discovery, SEO derivation, error mapping. A store implements four methods:
   `get(key, id)`, `list(key, filter)` (filters include exact `slug` and `external_id`),
   `save(key, post)`, `remove(key, id)`. Today it is three, with slug and external-id lookups.
2. **Ready-made stores, so most sites write no store at all:**
   - `FileStore`: a directory of `.md` files with YAML frontmatter. Fits Next.js, Astro, Hugo,
     Eleventy and Docusaurus sites that already render from `content/`, and it reads the posts
     already there.
   - `GitHubStore`: commits to a repo through the contents API, for hosts with a read-only
     filesystem (Vercel, Netlify, Cloudflare Pages). The commit triggers the site's own deploy.
   - A documented SQL table plus a ~40 line example, for sites with a database.
3. **`npx inkwire init`** detects the framework (Next.js, Astro, Express, FastAPI), writes the
   route files, generates an API key, picks `FileStore` or `GitHubStore`, and prints the one line
   to paste into Anaella. A Python equivalent for FastAPI.
4. **A prompt for coding agents:** `INSTALL.md` and `llms.txt` written so Cursor, Claude Code or
   Lovable can set the receiver up from one instruction. Sites built by agents are the likeliest
   first adopters, and the agent does the install.
5. **Rendering helpers:** `seoMetadata(post)` (Next.js `generateMetadata`), an Astro head helper
   and a plain `renderSeoHead(post)` string, so SEO rendering conformance is one import, not a
   page of markup.

### Conformance

The runner reads `/api/inkwire` and runs only the cases for advertised features. Upsert cases are
untouched. New cases: list paging and filters, get by id and `external_id`, hand-written post
readable, `PATCH` merge and `null` clearing, `If-Match` → `412`, slug collision on `PATCH`, delete
makes it non-public, read-only key → `403`, media upload and SVG refusal, `search` and `cursor`.

### Anaella

`InkwireCmsClient` becomes the third `CmsClient` (after WordPress and Ghost). The same 14 `cms.*`
tools and the `site-editing` skill then work on any site with an Inkwire receiver, with every SEO
field writable. The existing `InkwireChannelPublisher` keeps working and reuses the client. The
Inkwire connect form already exists (site address and API key); discovery decides which tools
apply.

## Out of scope

Comments, taxonomy beyond tags, a hosted dashboard, redirects on slug change (the response
returns the new `url`; a receiver may add its own redirect). "Connect a GitHub repo directly to
Anaella with no receiver at all" is a possible follow-up outside Inkwire.

## Plan (lanes, disjoint files)

| Task | Owns | Notes |
| --- | --- | --- |
| 1. Contract | `SPEC.md`, `schema/*.json` (patch, list, discovery, media), `conformance/cases.json` + runner | Done first by the planner; the lanes consume it |
| 2. core-ts | `receivers/core-ts/src/*` incl. `FileStore`, `GitHubStore`, ETag, discovery, scopes | Security-sensitive: FS path confinement, SSRF on media fetch |
| 3. Adapters + init | `receivers/node-express`, `receivers/nextjs`, `packages/create-inkwire` (`npx inkwire init`), `INSTALL.md`, `llms.txt` | After 2 |
| 4. Python | `receivers/python-fastapi` (core mirror + `FileStore`), `clients/python` | Mirrors 2 field for field |
| 5. Clients | `clients/node` | `list/get/update/delete/uploadMedia/capabilities`, `edits` helper |
| 6. Anaella | `InkwireCmsClient`, `cms-utils.ts`, tests, skill text | In the Anaella repo, after 5 |

**Review focus:** `FileStore` path confinement (slug and id must never leave the content dir),
frontmatter parsing of hand-written files, `GitHubStore` token handling, media fetch SSRF and
SVG, `If-Match` races, scope enforcement on every writing route, parity between the TS and
Python cores.

**After merge:** run the conformance runner against all three receivers; run it against a real
Next.js site with `FileStore` (a throwaway app); publish `inkwire-client` and
`inkwire-receiver-core` minor versions; then the Anaella client and a live test.
