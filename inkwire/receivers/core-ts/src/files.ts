import { isDeepStrictEqual } from "node:util";
import { isMap, parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { renderMarkdown } from "./render.js";
import type { SeoOverrides, StoredContent } from "./store.js";

/** The on-disk shape shared by FileStore and GitHubStore: `<kind>/<slug>.md`, YAML frontmatter + markdown. */

export const KIND_RE = /^[a-z][a-z0-9_-]{0,63}$/;
/** Filenames are slugs. Anything outside this never touches a path. */
export const SLUG_FILE_RE = /^[a-z0-9-]+$/;
/** `media` is the media folder, not a kind. */
export const RESERVED_KINDS = new Set(["media"]);

/** An entry's id is its path: `<kind>.<slug>` (kinds hold no dot, slugs hold none either). */
export const idFor = (kind: string, slug: string) => `${kind}.${slug}`;

export function parseId(id: string): { kind: string; slug: string } | null {
  const dot = id.indexOf(".");
  if (dot < 1 || id.length > 400) return null;
  const kind = id.slice(0, dot);
  const slug = id.slice(dot + 1);
  if (!KIND_RE.test(kind) || RESERVED_KINDS.has(kind) || !SLUG_FILE_RE.test(slug)) return null;
  return { kind, slug };
}

export type Draft = Omit<StoredContent, "id" | "key" | "etag" | "url">;

/** A date as a full ISO-8601 timestamp with an offset: date-only and zone-less values are read as UTC. */
const iso = (v: unknown): string | undefined => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  let full = t;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) full = `${t}T00:00:00.000Z`;
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) full = `${t.replace(" ", "T")}Z`;
  return Number.isNaN(Date.parse(full)) ? undefined : full;
};
const str = (v: unknown): string | undefined =>
  typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" && v.trim() ? v : undefined;
const httpOnly = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^https?:\/\//.test(s) ? s : undefined;
};

export function serializeEntry(e: Draft): string {
  const fm: Record<string, unknown> = {
    title: e.title,
    kind: e.kind,
    slug: e.slug,
    external_id: e.external_id,
    status: e.status,
    excerpt: e.excerpt,
    tags: e.tags,
    categories: e.categories,
    cover_image_url: e.cover_image_url,
    cover_image_alt: e.cover_image_alt,
    canonical_url: e.canonical_url,
    seo: e.seo && Object.keys(e.seo).length ? e.seo : undefined,
    author: e.author,
    lang: e.lang,
    translation_key: e.translation_key,
    published_at: e.published_at,
    updated_at: e.updated_at,
    version: e.version,
  };
  for (const k of Object.keys(fm)) if (fm[k] === undefined) delete fm[k];
  return `---\n${stringifyYaml(fm, { lineWidth: 0 })}---\n\n${e.markdown}\n`;
}

const FM = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Reads a file the API wrote or a person did. Missing frontmatter fields default: title from the
 * first `# ` heading, external_id null, status published, kind from the folder, dates from the file.
 * Returns null when the frontmatter is not valid YAML (the entry stays hidden rather than guessed at).
 */
export function parseEntryFile(
  raw: string,
  where: { kind: string; slug: string; mtimeIso: string },
): Draft | null {
  let fm: Record<string, unknown> = {};
  let body = raw.replace(/^\uFEFF/, "");
  const m = FM.exec(body);
  if (m) {
    try {
      const parsed = parseYaml(m[1]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
      else if (parsed != null) return null;
    } catch {
      return null;
    }
    body = body.slice(m[0].length);
  }
  body = body.replace(/^\r?\n/, "").replace(/\r?\n$/, "");

  const heading = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body)?.[1];
  const title = str(fm.title) ?? (heading ? heading.trim() : where.slug.replace(/-/g, " "));
  const terms = (raw: unknown): string[] | undefined =>
    Array.isArray(raw)
      ? raw.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.slice(0, 64))
      : typeof raw === "string"
        ? raw.split(",").map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 64))
        : undefined;
  const tags = terms(fm.tags);
  const categories = terms(fm.categories ?? fm.category);
  const seoRaw = fm.seo && typeof fm.seo === "object" && !Array.isArray(fm.seo) ? (fm.seo as Record<string, unknown>) : null;
  const seo: SeoOverrides = {};
  if (seoRaw) {
    if (str(seoRaw.title)) seo.title = str(seoRaw.title);
    if (str(seoRaw.description)) seo.description = str(seoRaw.description);
    if (httpOnly(seoRaw.image_url)) seo.image_url = httpOnly(seoRaw.image_url);
    if (typeof seoRaw.noindex === "boolean") seo.noindex = seoRaw.noindex;
    if (str(seoRaw.og_title)) seo.og_title = str(seoRaw.og_title);
    if (str(seoRaw.og_description)) seo.og_description = str(seoRaw.og_description);
    if (str(seoRaw.json_ld)) seo.json_ld = str(seoRaw.json_ld);
  }
  const authorRaw = fm.author;
  const author =
    typeof authorRaw === "string" && authorRaw.trim()
      ? { name: authorRaw.trim() }
      : authorRaw && typeof authorRaw === "object" && !Array.isArray(authorRaw)
        ? {
            ...(str((authorRaw as Record<string, unknown>).name) ? { name: str((authorRaw as Record<string, unknown>).name)! } : {}),
            ...(str((authorRaw as Record<string, unknown>).email) ? { email: str((authorRaw as Record<string, unknown>).email)! } : {}),
          }
        : undefined;
  const excerpt = str(fm.excerpt) ?? str(fm.description);
  const cover = httpOnly(fm.cover_image_url);
  const coverAlt = str(fm.cover_image_alt);
  const canonical = httpOnly(fm.canonical_url);
  const lang = str(fm.lang);
  // Hugo spells it translationKey.
  const translationKey = str(fm.translation_key) ?? str(fm.translationKey);

  return {
    external_id: str(fm.external_id) ?? null,
    kind: where.kind,
    title: title.slice(0, 512),
    slug: where.slug,
    markdown: body,
    html: renderMarkdown(body),
    ...(excerpt ? { excerpt: excerpt.slice(0, 1024) } : {}),
    ...(tags && tags.length ? { tags } : {}),
    ...(categories && categories.length ? { categories } : {}),
    ...(cover ? { cover_image_url: cover } : {}),
    ...(coverAlt ? { cover_image_alt: coverAlt.slice(0, 1024) } : {}),
    ...(canonical ? { canonical_url: canonical } : {}),
    seo: Object.keys(seo).length ? seo : null,
    ...(author && Object.keys(author).length ? { author } : {}),
    ...(lang && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(lang) ? { lang } : {}),
    ...(translationKey ? { translation_key: translationKey.slice(0, 255) } : {}),
    // Hugo, Astro and Jekyll mark drafts with `draft: true` or `published: false`.
    status: fm.status === "draft" || fm.draft === true || fm.published === false ? "draft" : "published",
    published_at: iso(fm.published_at) ?? iso(fm.date) ?? iso(fm.pubDate) ?? where.mtimeIso,
    updated_at: iso(fm.updated_at) ?? iso(fm.lastmod) ?? where.mtimeIso,
    version: typeof fm.version === "number" && Number.isInteger(fm.version) && fm.version >= 1 ? fm.version : 1,
  };
}

/** Key names a hand-written file may use for a field, canonical first (the order `parseEntryFile` reads them). */
const ALIASES = {
  excerpt: ["excerpt", "description"],
  categories: ["categories", "category"],
  published_at: ["published_at", "date", "pubDate"],
  updated_at: ["updated_at", "lastmod"],
  translation_key: ["translation_key", "translationKey"],
} as const;

/**
 * Saves an edit into an existing file without rewriting what it did not change: every frontmatter
 * key the receiver does not manage (`layout`, `heroImage`, `weight`...), comments and key order all
 * survive, and a field the file spells its own way (`date`, `lastmod`, `description`, `draft`) is
 * updated under that spelling. `before` is what the file parsed to, `after` what to store.
 * Returns null when the file has no usable frontmatter: the caller writes a fresh one.
 */
export function updateEntryFile(previousRaw: string, before: Draft, after: Draft): string | null {
  const m = FM.exec(previousRaw.replace(/^\uFEFF/, ""));
  if (!m) return null;
  const doc = parseDocument(m[1]!);
  if (doc.errors.length || !isMap(doc.contents)) return null;

  const changed = (k: keyof Draft) => !isDeepStrictEqual(before[k], after[k]);
  const put = (k: string, v: unknown, aliases: readonly string[] = [k]) => {
    if (v === undefined || v === null) for (const a of aliases) doc.delete(a);
    else doc.set(aliases.find((a) => doc.has(a)) ?? k, v);
  };

  if (changed("title")) doc.set("title", after.title);
  if (changed("external_id")) put("external_id", after.external_id);
  if (changed("status")) {
    const draft = after.status === "draft";
    const own = ["draft", "published", "status"].filter((k) => doc.has(k));
    if (own.length === 0) own.push("status");
    for (const k of own) doc.set(k, k === "draft" ? draft : k === "published" ? !draft : after.status);
  }
  for (const k of ["tags", "cover_image_url", "cover_image_alt", "canonical_url", "author", "lang", "version"] as const) {
    if (changed(k)) put(k, after[k]);
  }
  for (const k of ["excerpt", "categories", "published_at", "updated_at", "translation_key"] as const) {
    if (changed(k)) put(k, after[k], ALIASES[k]);
  }
  if (changed("seo")) put("seo", after.seo && Object.keys(after.seo).length ? after.seo : undefined);
  // kind and slug come from the path; a file that spells them out keeps them true.
  if (doc.has("slug") && changed("slug")) doc.set("slug", after.slug);
  if (doc.has("kind") && changed("kind")) doc.set("kind", after.kind);

  return `---\n${doc.toString({ lineWidth: 0 }).trimEnd()}\n---\n\n${after.markdown}\n`;
}
