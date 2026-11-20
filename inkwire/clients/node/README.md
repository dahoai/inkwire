# inkwire-client

Node client for an [Inkwire](https://github.com/etugrand/inkwire) receiver: publish, read, edit, delete and upload media. Zero dependencies (Node 18+: global `fetch`, `FormData`, `Blob`).

```js
import { publish, capabilities, list, get, update, remove, uploadMedia, edits } from "inkwire-client";

const site = "https://blog.example.com", key = "your-api-key";

await publish(site, key, { external_id: "my-post-1", title: "Hello", markdown: "# Hello", status: "published" });

const caps = await capabilities(site, key); // { features, kinds, limits }; a receiver without discovery reads as upsert-only
const page = await list(site, key, { status: "published", search: "hello", limit: 20 }); // { items, next_cursor }
const next = await list(site, key, { cursor: page.next_cursor });

// Safe edit: read, change the exact passage, write back only if nobody changed it meanwhile.
const { content, etag } = await get(site, key, page.items[0].id);
const markdown = edits(content.markdown, [{ find: "Hello", replace: "Hello, world" }]);
await update(site, key, content.id, { markdown }, { ifMatch: etag }); // 412 -> InkwireClientError code "stale"

await update(site, key, content.id, { excerpt: null, seo: { noindex: true } }); // null clears; seo merges per key
await remove(site, key, content.id);

const m = await uploadMedia(site, key, { filename: "pic.png", data: bytes, contentType: "image/png", alt: "A picture" });
// or have the receiver fetch it: uploadMedia(site, key, { url: "https://…/pic.png", alt: "A picture" })
```

| Function | Endpoint |
| --- | --- |
| `publish(baseUrl, apiKey, payload, opts?)` | `POST /api/content` (upsert on `external_id` + `kind`) |
| `capabilities(baseUrl, apiKey, opts?)` | `GET /api/inkwire` |
| `list(baseUrl, apiKey, query?, opts?)` | `GET /api/content` |
| `get(baseUrl, apiKey, id, opts?)` | `GET /api/content/{id}` -> `{ content, etag }` |
| `update(baseUrl, apiKey, id, patch, opts?)` | `PATCH /api/content/{id}` -> `{ content, etag }` |
| `remove(baseUrl, apiKey, id, opts?)` | `DELETE /api/content/{id}` |
| `uploadMedia(baseUrl, apiKey, media, opts?)` | `POST /api/media` |
| `edits(markdown, changes)` | none: each `find` must match exactly once |

Options: `opts.retries` (attempts, default 3; only `429` and `5xx` are retried, with backoff) and `opts.fetch` (send through your own fetch, for example an SSRF-guarded one when the site URL comes from your users). `update` and `remove` also take `opts.ifMatch`.

Failures throw `InkwireClientError` with `code` (the protocol's code: `invalid_payload`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `stale`, `too_large`, `rate_limited`, `internal`; `edit_not_found` / `edit_ambiguous` from `edits`), `message` and `httpStatus` (`0` for `edits`).

Entry ids are the receiver's: keep the `id` you get back from `publish`/`list` (a kind or slug change can change it on file-backed receivers). See the [protocol spec](https://github.com/etugrand/inkwire/blob/master/inkwire/SPEC.md).
