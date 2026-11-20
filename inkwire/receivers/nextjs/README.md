# Inkwire receiver for Next.js (App Router)

The reference receiver for Next.js: the Inkwire API as route handlers over [`inkwire-receiver-core`](../core-ts), with entries stored as markdown files (or committed to GitHub). To add it to your own site, run `npx create-inkwire` in your project; it copies these files. See [INSTALL.md](../../../INSTALL.md).

## Routes

```
app/api/content/route.ts          POST (create/upsert), GET (list)
app/api/content/[id]/route.ts     GET (with ETag), PATCH (If-Match), DELETE
app/api/media/route.ts            POST (multipart file, or JSON {url} fetched with an SSRF guard)
app/api/inkwire/route.ts          GET discovery
app/api/_inkwire/config.ts        keys, config and store, built from the environment on first use
app/inkwire-media/[...path]/route.ts   serves uploaded images (file store)
```

Everything is `runtime = "nodejs"` and `force-dynamic`. There is no build-time work: a missing variable fails the request that needs it, not `next build`.

## Configuration (environment variables only)

| Variable | Default | |
| --- | --- | --- |
| `INKWIRE_API_KEYS` | none: every request is `401` | `full-key,audit-key:ro` |
| `INKWIRE_SITE_URL` | `http://localhost:3000` | public address of the site |
| `INKWIRE_SITE_NAME` | `This site` | |
| `INKWIRE_KINDS` | `post,page` | |
| `INKWIRE_URL_TEMPLATE` | `{site}/{kind}/{slug}` | public address of an entry |
| `INKWIRE_MARKDOWN_LIMIT_BYTES` / `INKWIRE_MEDIA_LIMIT_BYTES` | 1,000,000 / 10,000,000 | `413` above |
| `INKWIRE_STORE` | `file` (`github` when the repo and token are set) | `file`, `memory` or `github` |
| `INKWIRE_ROOT` | `./content` | file store: `<root>/<kind>/<slug>.md`, uploads in `<root>/media` |
| `INKWIRE_MEDIA_URL_BASE` | `/inkwire-media` | public base of uploads; keep `/inkwire-media` with the file store (that is where `app/inkwire-media` serves them) |
| `INKWIRE_GITHUB_REPO`, `INKWIRE_GITHUB_TOKEN`, `INKWIRE_GITHUB_BRANCH`, `INKWIRE_GITHUB_DIR` | | switch to the GitHub store |

## The two stores

**File store (default).** One markdown file per entry with YAML frontmatter. Files that are already in `content/<kind>/` are listed and editable as they are (no frontmatter needed: the title comes from the first `# ` heading, `external_id` is `null`, status `published`). Needs a writable, persistent disk.

**GitHub store.** Entries are committed to a repo through the contents API; the ETag is the file's blob sha. Use it wherever the filesystem is read-only. **On Vercel you must use it.** The exact block:

```bash
INKWIRE_API_KEYS=<full key>,<read-only key>:ro
INKWIRE_SITE_URL=https://www.example.com
INKWIRE_GITHUB_REPO=your-org/your-site
INKWIRE_GITHUB_TOKEN=github_pat_...      # contents: read and write on that repo only
INKWIRE_GITHUB_BRANCH=main               # default
INKWIRE_GITHUB_DIR=content               # default
INKWIRE_URL_TEMPLATE={site}/blog/{slug}
INKWIRE_MEDIA_URL_BASE=https://www.example.com/content-media   # only if <dir>/media is served there; otherwise media is off
```

Setting the repo without the token (or the reverse) throws at the first request instead of falling back to disk. The GitHub store has only been exercised against a mocked GitHub API.

## Rendering the entries

The API does not render pages. `examples/blog/[slug]/page.tsx` is a page that passes SEO rendering conformance (`generateMetadata` plus BlogPosting JSON-LD); copy it to `app/blog/[slug]/page.tsx`. It is outside `app/` so it does not become a route here.

## Run and test

```bash
cd ../core-ts && npm install && npm run build   # once: this package depends on it
cd ../nextjs && npm install
npm run conformance      # next build, next start on a free port, the shared runner: 56 passed
```

`npm run dev` / `npm start` serve on port 4001. The conformance script preloads a small stub (`../node-express/test/media-stub.cjs`) that answers the one fake host the runner's fetch-by-URL case asks for; the receiver code itself is untouched.
