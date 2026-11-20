# inkwire-receiver-core

The shared TypeScript core for an [Inkwire](../../SPEC.md) receiver (protocol v1, revised: `/api/content` with `kind`, read/edit/delete, media, discovery, read-only keys). It owns everything the protocol decides (auth, validation, slugs, SEO Profile 1, sanitizing, ETag/If-Match, errors); an adapter owns only HTTP routing and where entries live.

One handler per endpoint. Each takes plain values and returns `{ status, headers, body }`; every response carries `Inkwire-Version: 1`, every error is `{ error: { code, message } }`.

```ts
import { FileStore, handleUpsert, handleList, handleGet, handlePatch, handleDelete, handleMedia, handleDiscovery, parseApiKeys } from "inkwire-receiver-core";

const keys = parseApiKeys(process.env.INKWIRE_API_KEYS); // "dev-key,audit-key:ro"
const store = new FileStore({ root: "./content", mediaUrlBase: "https://acme.com/media" });
const config = {
  site: { name: "Acme", url: "https://acme.com" },
  kinds: ["post", "page"],
  limits: { markdown_bytes: 1_000_000, media_bytes: 10_000_000 },
  fetchMedia, // optional: your SSRF-guarded fetch, enables `POST /api/media {url}`
};

// POST /api/content
const r = await handleUpsert({ authHeader: req.headers.authorization, rawBody, keys, store, config });
res.writeHead(r.status, r.headers).end(JSON.stringify(r.body));
```

| Endpoint | Handler | Arguments (besides `authHeader`, `keys`) |
| --- | --- | --- |
| `POST /api/content` | `handleUpsert` | `rawBody`, `store`, `config` |
| `GET /api/content` | `handleList` | `query: URLSearchParams`, `store` |
| `GET /api/content/{id}` | `handleGet` | `id`, `store` |
| `PATCH /api/content/{id}` | `handlePatch` | `id`, `rawBody`, `ifMatchHeader`, `store`, `config` |
| `DELETE /api/content/{id}` | `handleDelete` | `id`, `ifMatchHeader`, `store` |
| `POST /api/media` | `handleMedia` | `contentType`, `rawBody` (Buffer), `store`, `config` |
| `GET /api/inkwire` | `handleDiscovery` (or `discoveryBody(config)`) | `config` |

The adapter sets `ETag`/`If-Match` itself only by passing the `If-Match` header through; the core puts a quoted `ETag` on every single-entry response. Mount only what you support and list it in `config.features` (default: all but `media`, which appears when `config.fetchMedia` is set; `upsert` is always advertised).

## Keys

`parseApiKeys("dev-key,audit-key:ro")` -> `[{ key, ro, scope }]`. A `:ro` key may call every `GET` and gets `403 forbidden` on anything that writes (checked before the entry is looked up). All keys parsed together share one `scope`, which is what stores partition by; a multi-tenant adapter builds its own `ApiKey` objects with a scope per site.

## Stores

A store is four methods, each scoped by `key` (the `ApiKey.scope`), plus an optional `saveMedia`:

```ts
interface ContentStore {
  get(key, id): Promise<StoredContent | null>;
  list(key, filter: ListFilter): Promise<{ items: StoredContent[]; next_cursor: string | null }>;
  save(key, entry: SaveEntry): Promise<StoredContent>; // entry.id set = replace (even if kind/slug moved the address); finalizes `url` and `etag`
  remove(key, id): Promise<boolean>;
  saveMedia?(key, media): Promise<{ id; url; alt? }>;  // absent = the receiver has no media feature
}
```

The core finds an entry by `external_id`, and checks slug conflicts, with `list(key, { kind, external_id | slug, limit: 1 })`: make those filters cheap. `etag` is any opaque string that changes whenever the entry does. Handlers serialise writes per scope inside one process (`withLock`); a store shared by several processes needs its own conditional write.

Included:

- `MemoryStore`: tests and demos.
- `FileStore({ root, mediaUrlBase })`: `<root>/<kind>/<slug>.md`, YAML frontmatter + markdown, atomic writes. **Reads hand-written files too**: no/partial frontmatter is fine (title from the first `# ` heading, `external_id: null`, status `published`, kind from the folder, dates from frontmatter or the file). ETag = mtime + size + content hash, so an edit outside the API is noticed. Ids are `<kind>.<slug>`; file names must match `^[a-z0-9-]+$` (anything else is invisible and never opens a path). One FileStore is one site.
- `GitHubStore({ owner, repo, branch, dir, token, mediaUrlBase })`: the same files in a repo through the contents/trees REST API (raw `fetch`; the token is only ever sent as a bearer header). ETag = blob sha. Listing is ordered by path, not recency, and file bodies are read (and cached by sha) only for content filters and page items.

## Also exported

`renderMarkdown` (the SPEC's canonical allowlist), `slugify` (fallback `entry`), `edits(markdown, [{ find, replace }])` (each `find` must occur exactly once, else `invalid_payload` `edit_not_found:`/`edit_ambiguous:`), `InkwireError`, `effectiveSeo`, the zod schemas, and the types `StoredContent`, `UpsertInput`, `PatchInput`, `ListFilter`, `SeoMetadata`, `InkwireConfig`.

## Develop

```bash
npm install
npm test               # node --test
npm run typecheck
npm run conformance    # builds, serves the handlers on node:http over a FileStore, runs ../../conformance/runner.mjs
```
