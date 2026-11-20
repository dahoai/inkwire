# inkwire-receiver-core

The shared TypeScript core for an [Inkwire](../../SPEC.md) receiver (protocol v1: content with kinds, tags and categories, scheduling, media library, richer SEO, discovery, read-only keys). It owns everything the protocol decides (auth, validation, slugs, SEO Profile 1, sanitizing, ETag/If-Match, errors); an adapter owns only HTTP routing and where entries live.

One handler per endpoint. Each takes plain values and returns `{ status, headers, body }`; every response carries `Inkwire-Version: 1`, every error is `{ error: { code, message } }`.

```ts
import { FileStore, handleUpsert, handleList, handleGet, handlePatch, handleDelete, handleTerms, handleMedia, handleMediaList, handleMediaUpdate, handleDiscovery, parseApiKeys } from "inkwire-receiver-core";

const keys = parseApiKeys(process.env.INKWIRE_API_KEYS); // "dev-key,audit-key:ro"
const store = new FileStore({ root: "./content", mediaUrlBase: "https://acme.com/media" });
const config = {
  site: { name: "Acme", url: "https://acme.com", description: "Acme's blog", language: "en" },
  kinds: ["post", "page"],
  limits: { markdown_bytes: 1_000_000, media_bytes: 10_000_000 },
  fetchMedia, // optional: your SSRF-guarded fetch, enables `POST /api/media {url}` (feature `media_url`)
  schedule: true, // only if your site holds a future-dated published entry back (feature `schedule`)
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
| `GET /api/terms` | `handleTerms` | `query`, `store` |
| `POST /api/media` | `handleMedia` | `contentType`, `rawBody` (Buffer), `store`, `config` |
| `GET /api/media` | `handleMediaList` | `query`, `store` |
| `PATCH /api/media/{id}` | `handleMediaUpdate` | `id`, `rawBody`, `store` |
| `GET /api/inkwire` | `handleDiscovery` (or `discoveryBody(config, store)`) | `config`, `store` |

Pass the request's `If-Match` header through as `ifMatchHeader`; the core puts a quoted `ETag` on every single-entry response (and on the upsert response). Discovery advertises what is true: the media features follow the store (`media` needs `saveMedia`, `media_list` needs `listMedia`, `media_update` needs `updateMedia`, `media_url` also needs `config.fetchMedia`), `schedule` follows `config.schedule`, and `terms` is always there (terms are derived from the entries, by paging `list`).

## Keys

`parseApiKeys("dev-key,audit-key:ro")` -> `[{ key, ro, scope }]`. A `:ro` key may call every `GET` and gets `403 forbidden` on anything that writes (checked before the entry is looked up). All keys parsed together share one `scope`, which is what stores partition by; a multi-tenant adapter builds its own `ApiKey` objects with a scope per site.

## Stores

A store is four methods, each scoped by `key` (the `ApiKey.scope`), plus optional media methods:

```ts
interface ContentStore {
  get(key, id): Promise<StoredContent | null>;
  list(key, filter: ListFilter): Promise<{ items: StoredContent[]; next_cursor: string | null }>;
  save(key, entry: SaveEntry): Promise<StoredContent>; // entry.id set = replace (even if kind/slug moved the address); finalizes `url` and `etag`
  remove(key, id): Promise<boolean>;
  saveMedia?(key, media): Promise<StoredMedia>;          // absent = no `media` feature
  listMedia?(key, filter): Promise<{ items: StoredMedia[]; next_cursor: string | null }>; // absent = no `media_list`
  updateMedia?(key, id, { alt?, title? }): Promise<StoredMedia | null>;                   // `null` value clears; absent = no `media_update`
}
```

The core finds an entry by `external_id`, and checks slug conflicts, with `list(key, { kind, external_id | slug, limit: 1 })`: make those filters cheap. `etag` is any opaque string that changes whenever the entry does. Handlers serialise writes per scope inside one process (`withLock`); a store shared by several processes needs its own conditional write.

Included:

- `MemoryStore`: tests and demos.
- `FileStore({ root, mediaUrlBase })`: `<root>/<kind>/<slug>.md`, YAML frontmatter + markdown, atomic writes. **Reads hand-written files too**: no/partial frontmatter is fine (title from the first `# ` heading, `external_id: null`, status `published`, kind from the folder, dates from frontmatter or the file). ETag = mtime + size + content hash, so an edit outside the API is noticed. Ids are `<kind>.<slug>`; file names must match `^[a-z0-9-]+$` (anything else is invisible and never opens a path). One FileStore is one site.
- `GitHubStore({ owner, repo, branch, dir, token, mediaUrlBase })`: the same files in a repo through the contents/trees REST API (raw `fetch`; the token is only ever sent as a bearer header). ETag = blob sha. Listing is ordered by path, not recency, and file bodies are read (and cached by sha) only for content filters and page items.

## Backing it with a database

Most sites already have their posts in a database. You do not migrate them: you write a `ContentStore` over the table you have and mount the handlers on your own routes, behind your own authentication. [DadSEO](https://getdadseo.com) did exactly this for a Postgres + Drizzle blog (`DbStore`, about 200 lines, plus three small route files per endpoint family). The pattern, with the parts that matter:

```ts
import { decodeCursor, encodeCursor, recencyKey, InkwireError, renderMarkdown } from "inkwire-receiver-core";
import type { ContentStore, ListFilter, SaveEntry, StoredContent } from "inkwire-receiver-core";

export class DbStore implements ContentStore {
  constructor(private siteUrl: string, private db: Db) {}

  // 1. Map a row to StoredContent. Absent columns (NULL) become *absent keys*, never null or "":
  //    `if (row.excerpt != null) c.excerpt = row.excerpt`. `seo` is null when there are no overrides.
  //    `html` may be stored, or re-derived with renderMarkdown(row.markdown).
  //    etag: anything that changes on every write, e.g. `${row.id}-${row.version}`.
  private toContent(key: string, row: Row): StoredContent { /* ... */ }

  async get(key, id) { /* select ... where id = $1 */ }

  // 2. list: newest first by updated_at, ties by id. Support the filters in ListFilter (status, kind,
  //    tag, category, search over title/excerpt/markdown, exact external_id and slug). The cursor is
  //    keyset: recencyKey(lastItem) is "<inverted updated_at>|<id>", an ascending string, so
  //    "the next page" is "rows older than the cursor's instant, or the same instant with a greater id".
  //    Fetch limit + 1 rows to know whether there is a next page.
  async list(key, f: ListFilter) { /* ... */ }

  // 3. save: entry.id set means replace that row (even when the slug changed); otherwise insert with a
  //    fresh opaque id. Bump nothing yourself: the core hands you `version` and `updated_at`.
  async save(key, e: SaveEntry) { /* update ... returning / insert ... returning */ }

  async remove(key, id) { /* delete ... returning id; return rows > 0 */ }

  // 4. Optional: saveMedia / listMedia / updateMedia over a media table (DadSEO keeps the bytes in a
  //    bytea column and serves them from /blog-media/<id>/<name>; S3 or a CDN works as well).
}
```

Then the routes call the handlers with your own authentication (the handlers only check that a key you pass is valid and writable, so give them `keys` built from *your* auth result, scoped as you like):

```ts
// app/api/content/route.ts (Next.js)
export async function POST(req: Request) {
  const keys = await myAuth(req);                      // [] or [{ key, ro: false, scope: "blog" }]
  if (!keys) return refusal(401);
  return toResponse(await handleUpsert({ authHeader: req.headers.get("authorization"), rawBody: await req.text(), keys, store, config }));
}
```

Prove it with the store contract, then with the black-box suite against the running site:

```ts
import { runStoreContract } from "inkwire-receiver-core/testing";
runStoreContract({ name: "DbStore", describe, test, create: async () => ({ store: new DbStore(SITE, await freshDb()), cleanup }),
  scoped: false,       // the table is one site
  opaqueIds: true,     // a slug change keeps the id
  singleKind: true,    // the table only holds posts
});
```

```bash
npx inkwire-conformance https://staging.example.com --key <key> --seo
```

Things a database store has to get right, all checked by the contract: absent fields come back absent; dates come back as the same ISO string they went in (ms precision); `list` pages never repeat or skip an entry when rows are added between pages; an update keeps the id and moves the etag; `list` with an unknown `kind` returns nothing (a single-kind table answers `kind: "page"` with an empty list, not an error). Add unique indexes on `slug` (per kind) and `external_id`: the core serialises writes inside one process, the database is what protects you across several. If your site hides future-dated entries from its pages, set `config.schedule: true`; the scheduling rule is just "published with a future `published_at`", no job needed.

## Also exported

`renderMarkdown` (the SPEC's canonical allowlist), `slugify` (fallback `entry`), `edits(markdown, [{ find, replace }])` (each `find` must occur exactly once, else `invalid_payload` `edit_not_found:`/`edit_ambiguous:`), `InkwireError`, `effectiveSeo`, the zod schemas, and the types `StoredContent`, `UpsertInput`, `PatchInput`, `ListFilter`, `SeoMetadata`, `InkwireConfig`.

## Develop

```bash
npm install
npm test               # node --test
npm run typecheck
npm run conformance    # builds, serves the handlers on node:http over a FileStore, runs ../../conformance (the `inkwire-conformance` suite)
```
