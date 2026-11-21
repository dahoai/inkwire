# inkwire-client

Node client for an [Inkwire](https://github.com/dahoai/inkwire) receiver: publish, read, edit, delete, browse tags and categories, and manage the media library. Zero dependencies (Node 18+: global `fetch`, `FormData`, `Blob`).

```js
import {
  publish, capabilities, list, get, update, remove, terms, uploadMedia, listMedia, updateMedia, edits, isScheduled,
} from "inkwire-client";

const site = "https://blog.example.com", key = "your-api-key";

await publish(site, key, {
  external_id: "my-post-1", title: "Hello", markdown: "# Hello", status: "published",
  tags: ["seo"], categories: ["Guides"], cover_image_url: "https://…/c.jpg", cover_image_alt: "A red bicycle",
  seo: { og_title: "Social card title", og_description: "Social card text", json_ld: JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage" }) },
});

const caps = await capabilities(site, key); // { features, kinds, limits, site? }; a receiver without discovery (404) reads as upsert-only
if (caps.features.includes("terms")) await terms(site, key, { kind: "category", search: "gui", limit: 20 }); // { items: [{ kind, name, slug, count }] }
const page = await list(site, key, { status: "published", category: "Guides", search: "hello", limit: 20 }); // { items, next_cursor }
const next = await list(site, key, { cursor: page.next_cursor });

// Safe edit: read, change the exact passage, write back only if nobody changed it meanwhile.
const { content, etag } = await get(site, key, page.items[0].id);
const markdown = edits(content.markdown, [{ find: "Hello", replace: "Hello, world" }]);
await update(site, key, content.id, { markdown }, { ifMatch: etag }); // 412 -> InkwireClientError code "stale"

await update(site, key, content.id, { excerpt: null, categories: null, cover_image_alt: null, seo: { noindex: true, json_ld: null } }); // null clears; seo merges per key
await remove(site, key, content.id);

isScheduled(content); // true when status is "published" and published_at is in the future (needs the receiver's `schedule` feature to be held back)

const m = await uploadMedia(site, key, { filename: "pic.png", data: bytes, contentType: "image/png", alt: "A picture" });
// or have the receiver fetch it: uploadMedia(site, key, { url: "https://…/pic.png", alt: "A picture" })
// m: { id, url, alt?, title?, mime_type, created_at }

const library = await listMedia(site, key, { search: "pic", limit: 20 }); // { items: MediaItem[], next_cursor }
await updateMedia(site, key, m.id, { alt: "A better description", title: null }); // null clears; returns the MediaItem
```

Features a receiver can advertise in `capabilities().features`: `upsert` (always), `list`, `get`, `update`, `delete`, `terms`, `schedule`, `media`, `media_list`, `media_update`. Call only what it lists.

| Function | Endpoint |
| --- | --- |
| `publish(baseUrl, apiKey, payload, opts?)` | `POST /api/content` (upsert on `external_id` + `kind`) |
| `capabilities(baseUrl, apiKey, opts?)` | `GET /api/inkwire` |
| `list(baseUrl, apiKey, query?, opts?)` | `GET /api/content` |
| `get(baseUrl, apiKey, id, opts?)` | `GET /api/content/{id}` -> `{ content, etag }` |
| `update(baseUrl, apiKey, id, patch, opts?)` | `PATCH /api/content/{id}` -> `{ content, etag }` |
| `remove(baseUrl, apiKey, id, opts?)` | `DELETE /api/content/{id}` |
| `revisions(baseUrl, apiKey, id, opts?)` | `GET /api/content/{id}/revisions` -> `{ items }`, newest first |
| `revision(baseUrl, apiKey, id, rev, opts?)` | `GET /api/content/{id}/revisions/{rev}` -> the summary + `entry` |
| `restore(baseUrl, apiKey, id, rev, opts?)` | `POST /api/content/{id}/restore` -> `{ content, etag }` (undo; also undeletes) |
| `terms(baseUrl, apiKey, query?, opts?)` | `GET /api/terms` -> `{ items: { kind, name, slug, count }[] }` |
| `uploadMedia(baseUrl, apiKey, media, opts?)` | `POST /api/media` -> `MediaItem` |
| `listMedia(baseUrl, apiKey, query?, opts?)` | `GET /api/media` -> `{ items, next_cursor }` |
| `updateMedia(baseUrl, apiKey, id, patch, opts?)` | `PATCH /api/media/{id}` -> `MediaItem` |
| `edits(markdown, changes)` | none: each `find` must match exactly once |
| `isScheduled(entry, now?)` | none: published with a future `published_at` |

Options: `opts.retries` (attempts, default 3; only `429` and `5xx` are retried, with backoff) and `opts.fetch` (send through your own fetch, for example an SSRF-guarded one when the site URL comes from your users). `update` and `remove` also take `opts.ifMatch`.

Failures throw `InkwireClientError` with `code` (the protocol's code: `invalid_payload`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `stale`, `too_large`, `rate_limited`, `internal`; `edit_not_found` / `edit_ambiguous` from `edits`), `message` and `httpStatus` (`0` for `edits`).

Ids (entries and media) are URL-encoded for you. Entry ids are the receiver's: keep the `id` you get back from `publish`/`list` (a kind or slug change can change it on file-backed receivers). See the [protocol spec](https://github.com/dahoai/inkwire/blob/master/inkwire/SPEC.md).
