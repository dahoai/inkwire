# Add Inkwire to a site

Inkwire is a small API a site exposes so an agent (or any publisher) can **publish, read, edit, delete and upload images** for its content. This file is for a human or for the coding agent working in the site's repo. Do the steps in order; each ends with a check.

## The one prompt

Paste this into Cursor, Claude Code or any coding agent opened on your site's repo:

```text
Add an Inkwire receiver to this site so my agent can publish and edit its content.
1. Run `npx create-inkwire --yes` in the project root. Keep the two keys it prints and tell me them once.
2. Follow the matching section of INSTALL.md (https://github.com/dahoai/inkwire/blob/master/INSTALL.md) to make the site render
   published entries with SEO tags: Next.js App Router, Express, Astro or FastAPI. Set INKWIRE_URL_TEMPLATE so the URLs
   the API returns are the pages you built.
3. Start the site and check `curl -H "Authorization: Bearer <full key>" <site>/api/inkwire` answers with features and kinds.
4. If the site deploys to Vercel, Netlify or any read-only filesystem, use the GitHub store (section "Deploying") instead of files.
Do not commit the keys. Show me the diff when you are done.
```

## What you get

| Endpoint | What it does |
| --- | --- |
| `POST /api/content` | Create or update an entry (upsert on `external_id` + `kind`) |
| `GET /api/content` | List, with `status`, `kind`, `tag`, `search`, `external_id`, `slug`, `limit`, `cursor` |
| `GET` / `PATCH` / `DELETE /api/content/{id}` | Read (with an `ETag`), edit any fields (`If-Match` to avoid overwriting a newer edit), delete |
| `POST /api/media` | Upload an image (multipart) or have the site fetch one from a public URL |
| `GET /api/inkwire` | What this site supports: features, kinds, limits |

Two keys: a **full** key (read and write) and a **read-only** key (`:ro`, for audits; every write is `403`). Content is markdown files in `content/<kind>/<slug>.md` with YAML frontmatter, so files you already have there are listed and editable as they are. The wire contract is [`inkwire/SPEC.md`](inkwire/SPEC.md).

## 1. Create the receiver

Run in the project root:

```bash
npx create-inkwire            # detects Next.js, Express or FastAPI from package.json / pyproject / requirements
npx create-inkwire --framework next --root ./content --site-url https://www.example.com --yes
```

It writes the routes (Next.js: `app/api/{content,media,inkwire}` and `app/inkwire-media`; Express: one `inkwire-router.(mjs|ts)` file), adds `inkwire-receiver-core` to `package.json` and installs it, creates `content/`, and appends `INKWIRE_API_KEYS`, `INKWIRE_SITE_URL` and `INKWIRE_ROOT` to `.env.local` (Next.js) or `.env` (Express), which it adds to `.gitignore`. It never overwrites a file or a key that exists. The keys are printed once.

Express only: mount the router **before** `express.json()` (it reads its own bodies, and its errors then keep the Inkwire shape), and load `.env` (`node --env-file=.env`, or dotenv):

```js
import { createInkwireRouter } from "./inkwire-router.mjs";
app.use(createInkwireRouter());
```

Check:

```bash
curl -H "Authorization: Bearer <full key>" http://localhost:3000/api/inkwire
# {"inkwire":1,"site":{...},"features":["upsert","list","get","update","delete","media"],"kinds":["post","page"],"limits":{...}}
```

## 2. Render what gets published

The API stores entries; **your site** shows them. An entry's public address is `INKWIRE_SITE_URL` + `/<kind>/<slug>` unless you set `INKWIRE_URL_TEMPLATE` (placeholders `{site}`, `{kind}`, `{slug}`), for example `{site}/blog/{slug}`. Build a page at that address and give it SEO Profile 1: one `<title>`, `description`, canonical, `og:*` and `twitter:*` tags, `robots` `noindex,follow` when the entry says `noindex`, and `BlogPosting` JSON-LD, all HTML-escaped. The two snippets below pass `inkwire/conformance/seo-runner.mjs` (the rendering gate); they are copied from the reference receivers, which keep them in sync.

### Next.js (App Router)

Save as `app/blog/[slug]/page.tsx` (or `src/app/...`) and set `INKWIRE_URL_TEMPLATE={site}/blog/{slug}` in `.env.local`.

<!-- inkwire:example inkwire/receivers/nextjs/examples/blog/[slug]/page.tsx -->
```tsx
// Renders a published Inkwire "post" at /blog/<slug> with everything SEO Profile 1 asks of a page:
// title, description, canonical, Open Graph, Twitter, robots, and BlogPosting JSON-LD.
// Copy it to app/blog/[slug]/page.tsx (src/app/... if you use src/) and set
//   INKWIRE_URL_TEMPLATE={site}/blog/{slug}
// so the addresses the API returns are the ones this page answers on.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { effectiveSeo } from "inkwire-receiver-core";
import { getInkwire } from "../../api/_inkwire/config";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  const { store, keys } = getInkwire();
  const { items } = await store.list(keys[0]?.scope ?? "default", { kind: "post", slug, status: "published", limit: 1 });
  return items[0] ?? null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const entry = await load((await params).slug);
  if (!entry) return {};
  const seo = effectiveSeo(entry);
  const url = entry.canonical_url ?? entry.url;
  const images = seo.image_url ? [seo.image_url] : undefined;
  return {
    title: seo.title,
    description: seo.description,
    alternates: { canonical: url },
    robots: seo.noindex ? "noindex,follow" : undefined,
    openGraph: { type: "article", title: seo.title, description: seo.description, url, images, publishedTime: entry.published_at },
    twitter: { card: images ? "summary_large_image" : "summary", title: seo.title, description: seo.description, images },
  };
}

export default async function Post({ params }: Props) {
  const entry = await load((await params).slug);
  if (!entry) notFound();
  const seo = effectiveSeo(entry);
  const url = entry.canonical_url ?? entry.url;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: seo.title,
    description: seo.description,
    url,
    mainEntityOfPage: url,
    datePublished: entry.published_at,
    ...(seo.image_url ? { image: seo.image_url } : {}),
    ...(entry.author?.name ? { author: { "@type": "Person", name: entry.author.name } } : {}),
    ...(entry.tags?.length ? { keywords: entry.tags } : {}),
  };
  return (
    <article>
      <h1>{entry.title}</h1>
      {/* entry.html is rendered and sanitized by the receiver core */}
      <div dangerouslySetInnerHTML={{ __html: entry.html }} />
      {/* "<" is escaped so caller-controlled text can never close the script element */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
    </article>
  );
}
```
<!-- /inkwire:example -->

### Express

Save as `blog.mjs` next to `inkwire-router.mjs`, call `mountBlog(app)` after the router, and set `INKWIRE_URL_TEMPLATE={site}/blog/{slug}` in `.env`.

<!-- inkwire:example inkwire/receivers/node-express/examples/blog.mjs -->
```js
// Renders a published Inkwire "post" at /blog/<slug> with everything SEO Profile 1 asks of a page:
// title, description, canonical, Open Graph, Twitter, robots, and BlogPosting JSON-LD.
// Copy it next to inkwire-router.mjs, call mountBlog(app) in your app, and set
//   INKWIRE_URL_TEMPLATE={site}/blog/{slug}
// so the addresses the API returns are the ones this route answers on.
import { effectiveSeo } from "inkwire-receiver-core";
import { buildReceiver } from "./inkwire-router.mjs";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function mountBlog(app, env = process.env) {
  const { store, keys } = buildReceiver(env); // a second FileStore over the same folder is fine: it only caches
  app.get("/blog/:slug", async (req, res, next) => {
    try {
      const { items } = await store.list(keys[0]?.scope ?? "default", { kind: "post", slug: req.params.slug, status: "published", limit: 1 });
      const entry = items[0];
      if (!entry) return next();
      const seo = effectiveSeo(entry);
      const url = entry.canonical_url ?? entry.url;
      const jsonLd = {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: seo.title,
        description: seo.description,
        url,
        mainEntityOfPage: url,
        datePublished: entry.published_at,
        ...(seo.image_url ? { image: seo.image_url } : {}),
        ...(entry.author?.name ? { author: { "@type": "Person", name: entry.author.name } } : {}),
        ...(entry.tags?.length ? { keywords: entry.tags } : {}),
      };
      const meta = (attr, key, value) => `<meta ${attr}="${key}" content="${esc(value)}">`;
      res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(seo.title)}</title>
${meta("name", "description", seo.description)}
<link rel="canonical" href="${esc(url)}">
${seo.noindex ? meta("name", "robots", "noindex,follow") : ""}
${meta("property", "og:type", "article")}
${meta("property", "og:title", seo.title)}
${meta("property", "og:description", seo.description)}
${meta("property", "og:url", url)}
${seo.image_url ? meta("property", "og:image", seo.image_url) : ""}
${meta("name", "twitter:card", seo.image_url ? "summary_large_image" : "summary")}
${meta("name", "twitter:title", seo.title)}
${meta("name", "twitter:description", seo.description)}
${seo.image_url ? meta("name", "twitter:image", seo.image_url) : ""}
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>
</head><body><article><h1>${esc(entry.title)}</h1>${entry.html}</article></body></html>`);
    } catch (e) {
      next(e);
    }
  });
}
```
<!-- /inkwire:example -->

### Astro

Astro has no server code here: run the Express receiver (or `inkwire/receivers/node-express`) beside it, pointing `INKWIRE_ROOT` at the folder Astro reads, and let Astro render the markdown files. Each file has this frontmatter (all keys optional when you write a file by hand; a missing title comes from the first `# ` heading):

```yaml
title: Hello
kind: post
slug: hello
external_id: gen-2026-07-22-abc   # null for files written by hand
status: published                  # draft entries must not be rendered
excerpt: One line
tags: [seo, ai]
cover_image_url: https://example.com/cover.jpg
canonical_url: https://example.com/elsewhere
seo: { title: ..., description: ..., image_url: ..., noindex: true }   # overrides only
author: { name: Ada }
published_at: 2026-07-22T10:00:00.000Z
```

A collection over `content/post/*.md` (`glob` loader, `base: "./content/post"`) and a layout head that applies the SEO Profile 1 defaults (`title = seo.title ?? title`, `description = seo.description ?? excerpt ?? title`, `image = seo.image_url ?? cover_image_url`, canonical = `canonical_url ?? the page URL`) give the same output as the snippets above. This section was not run against a real Astro project here; run `seo-runner.mjs` against yours (below).

### FastAPI

`create-inkwire` prints the manual steps: `pip install "inkwire-receiver-core[fastapi]" uvicorn`, set `INKWIRE_API_KEYS`, `INKWIRE_KINDS`, `INKWIRE_ROOT`, `INKWIRE_SITE_URL` and `INKWIRE_URL_TEMPLATE` (`{site}`, `{kind}`, `{slug}`), then run `uvicorn inkwire_receiver.app:create_app --factory`. Render the entries from the same `content/` folder with your own templates, applying the SEO rules above. The Python receiver stores files (or memory); it has no GitHub store, so on a read-only host (Vercel, Netlify) use the Next.js or Express receiver instead, or a host with a persistent disk.

## 3. Deploying

The default store writes files, so the host needs a **writable, persistent** disk (a VM, Fly volume, Railway/Render disk). On **Vercel, Netlify and other read-only hosts**, use the GitHub store: entries are committed to a repo through the API and your site rebuilds from it. Set exactly these (a token with `contents: read and write` on that one repo):

```bash
INKWIRE_API_KEYS=<full key>,<read-only key>:ro
INKWIRE_SITE_URL=https://www.example.com
INKWIRE_GITHUB_REPO=your-org/your-site
INKWIRE_GITHUB_TOKEN=github_pat_...
INKWIRE_GITHUB_BRANCH=main            # default main
INKWIRE_GITHUB_DIR=content            # default content: <dir>/<kind>/<slug>.md
INKWIRE_URL_TEMPLATE={site}/blog/{slug}
# Image uploads are committed to <dir>/media; enable them by saying where that folder is served publicly:
INKWIRE_MEDIA_URL_BASE=https://www.example.com/content-media
```

Without `INKWIRE_MEDIA_URL_BASE` (an absolute address) the GitHub store turns the `media` feature off; `cover_image_url` and images in markdown still work with any public URL. Setting only one of `INKWIRE_GITHUB_REPO` / `INKWIRE_GITHUB_TOKEN` is refused at startup instead of silently writing to a disk that is not there.

## 4. Verify

From a checkout of this repo (Node 20+):

```bash
cd inkwire/conformance
BASE_URL=https://www.example.com API_KEY=<full key> READONLY_KEY=<read-only key> node runner.mjs   # the API: every case for the advertised features
BASE_URL=https://www.example.com API_KEY=<full key> node seo-runner.mjs                            # the page: SEO Profile 1 rendering
```

Both write test entries (`external_id`s that start with `r` and a timestamp, or `seo-profile-`) to the site you point them at; run them against staging, or delete those entries afterwards.

## 5. Connect your agent

In Anaella, add an Inkwire site with the site address and the **full key**. Give audit-only tools the read-only key. Environment variables are the whole configuration:

| Variable | Default | Meaning |
| --- | --- | --- |
| `INKWIRE_API_KEYS` | none (all requests refused) | `full,other,audit:ro`, comma separated; `:ro` marks read-only |
| `INKWIRE_SITE_URL` | `http://localhost:3000` | public address of the site |
| `INKWIRE_SITE_NAME` | `This site` | shown in discovery |
| `INKWIRE_KINDS` | `post,page` | kinds the site holds (a folder each) |
| `INKWIRE_ROOT` | `./content` | where the files live (file store) |
| `INKWIRE_URL_TEMPLATE` | `{site}/{kind}/{slug}` | public address of an entry |
| `INKWIRE_MEDIA_URL_BASE` | `/inkwire-media` | public base of uploaded images |
| `INKWIRE_MARKDOWN_LIMIT_BYTES` | `1000000` | largest markdown body (`413` above) |
| `INKWIRE_MEDIA_LIMIT_BYTES` | `10000000` | largest image (`413` above) |
| `INKWIRE_GITHUB_REPO`, `INKWIRE_GITHUB_TOKEN`, `INKWIRE_GITHUB_BRANCH`, `INKWIRE_GITHUB_DIR` | none | switch the store to GitHub (section 3) |
