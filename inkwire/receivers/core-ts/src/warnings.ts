import { effectiveSeo } from "./seo.js";
import type { StoredContent } from "./store.js";

/** Advice on an entry as it will be after a write (feature `warnings`). Never blocks the write. */
export interface Warning {
  code: string;
  /** The field to change to fix it: `title`, `seo.title`, `seo.description`, `markdown`, `cover_image_alt`, `lang`. */
  field: string;
  message: string;
}

export const TITLE_MAX = 65;

/** Anchor texts that say nothing about where the link goes (English and French). */
const GENERIC_ANCHORS = new Set([
  "click here", "here", "read more", "more", "learn more", "this", "this link", "link", "continue", "details", "see more",
  "ici", "cliquez ici", "lire la suite", "en savoir plus", "plus", "voir plus", "ce lien",
]);

type Entry = Pick<
  StoredContent,
  "kind" | "slug" | "title" | "excerpt" | "cover_image_url" | "cover_image_alt" | "seo" | "html" | "lang" | "translation_key"
> & { id?: string; url?: string };

export interface WarningContext {
  /** The site's address (discovery `site.url`): links elsewhere are not checked. */
  siteUrl: string;
  /** Every other entry of the site, drafts included (not the one being written). */
  others: StoredContent[];
  /** Whether an old address of an entry redirects (feature `redirects`). */
  redirects?: (kind: string, slug: string) => Promise<boolean>;
  /** Whether the site serves a page at `path` that is not one of its entries (`ContentStore.pageExists`). */
  pageExists?: (path: string) => Promise<boolean>;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const text = (html: string) =>
  html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const pathOf = (u: URL) => u.pathname.replace(/\/+$/, "") || "/";

/** Where an entry of each kind lives: its URL path with the slug cut out, from one entry of that kind. */
function addressPatterns(entries: { kind: string; slug: string; url?: string }[], site: URL) {
  const out = new Map<string, { before: string; after: string }>();
  for (const e of entries) {
    if (out.has(e.kind) || !e.url) continue;
    let u: URL;
    try {
      u = new URL(e.url);
    } catch {
      continue;
    }
    if (u.origin !== site.origin) continue;
    const p = pathOf(u);
    const at = p.lastIndexOf(e.slug);
    if (at >= 0) out.set(e.kind, { before: p.slice(0, at), after: p.slice(at + e.slug.length) });
  }
  return out;
}

export async function seoWarnings(entry: Entry, ctx: WarningContext): Promise<Warning[]> {
  const out: Warning[] = [];
  const add = (code: string, field: string, message: string) => out.push({ code, field, message });
  const seo = effectiveSeo(entry);
  const published = ctx.others.filter((o) => o.status === "published");
  const sameGroup = (o: StoredContent) => !!entry.translation_key && o.translation_key === entry.translation_key;
  const titleField = entry.seo?.title !== undefined ? "seo.title" : "title";

  if (!seo.noindex) {
    if (seo.title.length > TITLE_MAX) {
      add("title_long", titleField, `the search title is ${seo.title.length} characters; over ${TITLE_MAX}, results cut it off`);
    }
    const twinTitle = published.find((o) => !sameGroup(o) && !effectiveSeo(o).noindex && norm(effectiveSeo(o).title) === norm(seo.title));
    if (twinTitle) add("title_duplicate", titleField, `"${twinTitle.title}" (${twinTitle.id}) has the same search title; give each page its own`);
    if (entry.seo?.description === undefined && !entry.excerpt) {
      add("description_missing", "seo.description", "no description: search results show the title twice; write an excerpt or seo.description");
    } else {
      const twin = published.find((o) => !sameGroup(o) && !effectiveSeo(o).noindex && norm(effectiveSeo(o).description) === norm(seo.description));
      if (twin) add("description_duplicate", "seo.description", `"${twin.title}" (${twin.id}) has the same description; describe each page on its own`);
    }
  }

  // The page shows the title as its H1, so the body starts at H2.
  const levels = [...entry.html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  if (levels.includes(1)) add("h1_extra", "markdown", "the body has a level-1 heading (#); the title is already the page's H1, use ## instead");
  let prev = 1;
  for (const level of levels) {
    if (level > prev + 1) {
      add("heading_skipped", "markdown", `a level-${level} heading follows a level-${prev} one; do not skip levels`);
      break;
    }
    prev = level;
  }

  const imgs = [...entry.html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  const bare = imgs.filter((t) => !/\salt="[^"]+"/.test(t)).length;
  if (bare) add("image_alt_missing", "markdown", `${bare} image${bare > 1 ? "s have" : " has"} no alt text; describe each one (![what it shows](url))`);
  if (entry.cover_image_url && !entry.cover_image_alt) add("image_alt_missing", "cover_image_alt", "the cover image has no alt text");

  let site: URL | null = null;
  try {
    site = new URL(ctx.siteUrl);
  } catch {}
  const generic = new Set<string>();
  const broken = new Set<string>();
  const redirected = new Set<string>();
  const patterns = site ? addressPatterns([entry, ...ctx.others], site) : new Map();
  const byPath = new Map<string, StoredContent>();
  for (const o of ctx.others) {
    try {
      byPath.set(pathOf(new URL(o.url)), o);
    } catch {}
  }
  for (const m of entry.html.matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const label = norm(text(m[2]!)).replace(/[.!?:…»«"']+$/g, "").trim();
    if (GENERIC_ANCHORS.has(label)) generic.add(label);
    if (!site) continue;
    let u: URL;
    try {
      u = new URL(m[1]!.replace(/&amp;/g, "&"), site);
    } catch {
      continue;
    }
    if (u.origin !== site.origin || !/^https?:$/.test(u.protocol)) continue;
    const p = pathOf(u);
    const target = byPath.get(p);
    if (target) {
      if (target.status !== "published") broken.add(`${u.pathname} (a draft)`);
      continue;
    }
    for (const [kind, { before, after }] of patterns) {
      if (!p.startsWith(before) || !p.endsWith(after) || p.length <= before.length + after.length) continue;
      const slug = p.slice(before.length, p.length - after.length);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || (kind === entry.kind && slug === entry.slug)) continue;
      if (ctx.redirects && (await ctx.redirects(kind, slug))) redirected.add(u.pathname);
      else if (!(ctx.pageExists && (await ctx.pageExists(p)))) broken.add(u.pathname);
      break;
    }
  }
  if (broken.size) add("link_broken", "markdown", `links to pages that are not on the site: ${[...broken].join(", ")}`);
  if (redirected.size) add("link_redirect", "markdown", `links to old addresses that redirect: ${[...redirected].join(", ")}; link to the page's current URL`);
  if (generic.size) add("anchor_generic", "markdown", `link text that says nothing about the page it opens: "${[...generic].join('", "')}"`);

  if (entry.lang && entry.translation_key) {
    const twin = ctx.others.find((o) => o.translation_key === entry.translation_key && o.lang === entry.lang);
    if (twin) add("translation_lang_duplicate", "lang", `"${twin.title}" (${twin.id}) is already the ${entry.lang} version of this page`);
  }
  return out;
}
