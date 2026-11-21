// Lists the published, indexable Inkwire entries in the site's sitemap, with lastmod. Copy it to
// app/sitemap.ts (src/app/... if you use src/), or add `inkwireSitemap()` to the sitemap you have.
import type { MetadataRoute } from "next";
import { sitemapEntries } from "inkwire-receiver-core";
import { getInkwire } from "./api/_inkwire/config";

export const dynamic = "force-dynamic";

export async function inkwireSitemap(): Promise<MetadataRoute.Sitemap> {
  const { store, keys } = getInkwire();
  return (await sitemapEntries(store, keys[0]?.scope ?? "default")).map((e) => ({ url: e.url, lastModified: e.lastmod }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return [...(await inkwireSitemap())];
}
