# Inkwire receiver for Express

The reference receiver for Express: the whole Inkwire API as **one router** (`src/inkwire-router.ts`) over [`inkwire-receiver-core`](../core-ts). To add it to your own app run `npx create-inkwire`, which copies that file; see [INSTALL.md](../../../INSTALL.md). Express 4 or 5.

```ts
import { createInkwireRouter } from "./inkwire-router.js";
app.use(createInkwireRouter());      // mount it BEFORE express.json()
```

Routes: `POST/GET /api/content`, `GET/PATCH/DELETE /api/content/:id`, `POST /api/media`, `GET /api/inkwire`, and the uploaded images under `INKWIRE_MEDIA_URL_BASE`. Unknown `/api/*` paths, oversize bodies, bad JSON and failures all answer in the Inkwire error shape (`{error:{code,message}}` with `Inkwire-Version: 1`). The router reads its own bodies (raw bytes, sized from the limits); if an app-level `express.json()` already parsed one, it is re-serialised, but that parser's own errors then escape the router, hence "mount it first".

## Configuration (environment variables only)

| Variable | Default | |
| --- | --- | --- |
| `INKWIRE_API_KEYS` | none: every request is `401` | `full-key,audit-key:ro` |
| `INKWIRE_SITE_URL` | `http://localhost:$PORT` | public address of the site |
| `INKWIRE_SITE_NAME` | `This site` | |
| `INKWIRE_KINDS` | `post,page` | |
| `INKWIRE_URL_TEMPLATE` | `{site}/{kind}/{slug}` | public address of an entry |
| `INKWIRE_MARKDOWN_LIMIT_BYTES` / `INKWIRE_MEDIA_LIMIT_BYTES` | 1,000,000 / 10,000,000 | `413` above |
| `INKWIRE_STORE` | `file` (`github` when the repo and token are set) | `file`, `memory` or `github` |
| `INKWIRE_ROOT` | `./content` | file store: `<root>/<kind>/<slug>.md`, uploads in `<root>/media` |
| `INKWIRE_MEDIA_URL_BASE` | `/inkwire-media` | public base of uploads (relative values are joined to `INKWIRE_SITE_URL`); served with `express.static` when the store is files |
| `INKWIRE_GITHUB_REPO` (`owner/name`), `INKWIRE_GITHUB_TOKEN`, `INKWIRE_GITHUB_BRANCH` (`main`), `INKWIRE_GITHUB_DIR` (`content`) | | commit entries through the GitHub API instead of files |

`INKWIRE_STORE=file|memory|github` picks the store; unset, it is `github` when the repo and token are set, else `file`. `memory` keeps nothing across restarts and turns media off.

With the GitHub store, `media` is advertised only when `INKWIRE_MEDIA_URL_BASE` is an absolute public address, since the receiver cannot serve files that live in a repo. Setting only one of the repo and the token throws at startup.

## Fetch-by-URL for media

`POST /api/media {"url": ...}` fetches the image itself, with an SSRF guard in the router file: http(s) only, ports 80/443, no credentials in the URL, every address the name resolves to must be public (loopback, private, link-local, carrier-grade NAT, multicast, IPv4-mapped/NAT64/6to4 IPv6 are refused), the connection is pinned to the address that was checked, up to three redirects each re-checked, a 10 s timeout, and the size is capped while streaming.

## Run and test

```bash
cd ../core-ts && npm install && npm run build      # once: this package depends on it
cd ../node-express && npm install
INKWIRE_API_KEYS=dev-key,audit-key:ro npm start    # tsx, port 4000 (reads ./.env too)
npm test                                           # unit tests (routes, env wiring, the guard)
npm run conformance                                # build, start dist/ on a free port, run the shared runner: 56 passed
```

`test/media-stub.cjs` is preloaded only by the conformance harness: the runner's fetch-by-URL case asks for `https://example.test/imgs/ok.png`, which does not exist, so the stub answers that host at the `dns`/`https` layer and the real guard code still runs end to end.

The same file is the canonical source of the shared block (fetch guard and environment wiring) that the Next.js receiver embeds; `packages/create-inkwire` (`npm run sync`) keeps the copies and its templates identical, and `npm test` there fails when they drift.
