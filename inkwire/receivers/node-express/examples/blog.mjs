// Renders a published Inkwire "post" at /blog/<slug> with everything SEO Profile 1 asks of a page:
// title, description, canonical, Open Graph, Twitter, robots, BlogPosting JSON-LD, hreflang for its
// translations, a permanent redirect from the address it had before a slug change, and /sitemap.xml
// (drop that route if your site has a sitemap: add `sitemapEntries` to yours instead).
// Copy it next to inkwire-router.mjs, call mountBlog(app) in your app, and set
//   INKWIRE_URL_TEMPLATE={site}/blog/{slug}
// so the addresses the API returns are the ones this route answers on.
import { alternates, effectiveSeo, resolveRedirect, sitemapEntries } from "inkwire-receiver-core";
import { buildReceiver } from "./inkwire-router.mjs";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function mountBlog(app, env = process.env) {
  const { store, keys, config } = buildReceiver(env); // a second FileStore over the same folder is fine: it only caches
  const scope = keys[0]?.scope ?? "default";
  app.get("/sitemap.xml", async (_req, res, next) => {
    try {
      const urls = (await sitemapEntries(store, scope)).map((e) => `<url><loc>${esc(e.url)}</loc><lastmod>${esc(e.lastmod)}</lastmod></url>`);
      res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`);
    } catch (e) {
      next(e);
    }
  });
  app.get("/blog/:slug", async (req, res, next) => {
    try {
      const { items } = await store.list(scope, { kind: "post", slug: req.params.slug, status: "published", limit: 1 });
      const entry = items[0];
      if (!entry) {
        // An address the entry had before a slug change: one permanent redirect to where it is now.
        const moved = await resolveRedirect(store, scope, "post", req.params.slug);
        return moved ? res.redirect(301, moved.url) : next();
      }
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
      const hreflang = (await alternates(store, scope, entry)).map((a) => `<link rel="alternate" hreflang="${esc(a.lang)}" href="${esc(a.url)}">`).join("\n");
      res.type("html").send(`<!doctype html>
<html lang="${esc(entry.lang ?? config.site.language ?? "en")}"><head><meta charset="utf-8">
<title>${esc(seo.title)}</title>
${meta("name", "description", seo.description)}
<link rel="canonical" href="${esc(url)}">
${hreflang}
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
