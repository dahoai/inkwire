// Helpers for the page renderer (the site's own code): what SEO Profile 1 asks a public page to do.
import { effectiveSeo } from "./seo.js";
import type { ContentStore, StoredContent } from "./store.js";

const PAGE = 100;
const isLive = (e: StoredContent, now: number) => e.status === "published" && Date.parse(e.published_at) <= now;

async function* every(store: ContentStore, scope: string, filter: { status?: "published"; translation_key?: string }) {
  let cursor: string | undefined;
  do {
    const page = await store.list(scope, { ...filter, limit: PAGE, ...(cursor ? { cursor } : {}) });
    yield* page.items;
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
}

/**
 * The entry an old address now leads to (feature `redirects`), for a page that found no entry at
 * `kind`/`slug`: answer with a permanent redirect to its `url`. Null when nothing redirects there, the
 * entry is gone or not public, or another entry lives at that address.
 */
export async function resolveRedirect(store: ContentStore, scope: string, kind: string, slug: string): Promise<StoredContent | null> {
  if (!store.findRedirect) return null;
  if ((await store.list(scope, { kind, slug, limit: 1 })).items.length) return null;
  const r = await store.findRedirect(scope, kind, slug);
  const e = r ? await store.get(scope, r.id) : null;
  return e && isLive(e, Date.now()) ? e : null;
}

/**
 * The entries a sitemap lists: public now, indexable, and their own canonical. `lastmod` is
 * `updated_at`. Merge them into the site's sitemap.
 */
export async function sitemapEntries(store: ContentStore, scope: string): Promise<{ url: string; lastmod: string; kind: string }[]> {
  const now = Date.now();
  const out: { url: string; lastmod: string; kind: string }[] = [];
  for await (const e of every(store, scope, { status: "published" })) {
    if (!isLive(e, now) || effectiveSeo(e).noindex) continue;
    if (e.canonical_url && e.canonical_url !== e.url) continue;
    out.push({ url: e.url, lastmod: e.updated_at, kind: e.kind });
  }
  return out;
}

/**
 * The `hreflang` alternates of an entry (feature `translations`): every public translation with a
 * `lang`, the entry itself included, one per language (the newest). Empty when it has none.
 */
export async function alternates(store: ContentStore, scope: string, entry: StoredContent): Promise<{ lang: string; url: string }[]> {
  if (!entry.translation_key || !store.translations) return [];
  const now = Date.now();
  const byLang = new Map<string, string>();
  for await (const e of every(store, scope, { status: "published", translation_key: entry.translation_key })) {
    if (e.lang && isLive(e, now) && !byLang.has(e.lang)) byLang.set(e.lang, e.canonical_url ?? e.url);
  }
  if (entry.lang) byLang.set(entry.lang, entry.canonical_url ?? entry.url);
  return byLang.size > 1 ? [...byLang].sort(([a], [b]) => (a < b ? -1 : 1)).map(([lang, url]) => ({ lang, url })) : [];
}
