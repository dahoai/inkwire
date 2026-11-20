import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
    cover_image_url: e.cover_image_url,
    canonical_url: e.canonical_url,
    seo: e.seo && Object.keys(e.seo).length ? e.seo : undefined,
    author: e.author,
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
  const tagsRaw = fm.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.filter((t): t is string => typeof t === "string").map((t) => t.slice(0, 64))
    : typeof tagsRaw === "string"
      ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;
  const seoRaw = fm.seo && typeof fm.seo === "object" && !Array.isArray(fm.seo) ? (fm.seo as Record<string, unknown>) : null;
  const seo: SeoOverrides = {};
  if (seoRaw) {
    if (str(seoRaw.title)) seo.title = str(seoRaw.title);
    if (str(seoRaw.description)) seo.description = str(seoRaw.description);
    if (httpOnly(seoRaw.image_url)) seo.image_url = httpOnly(seoRaw.image_url);
    if (typeof seoRaw.noindex === "boolean") seo.noindex = seoRaw.noindex;
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
  const canonical = httpOnly(fm.canonical_url);

  return {
    external_id: str(fm.external_id) ?? null,
    kind: where.kind,
    title: title.slice(0, 512),
    slug: where.slug,
    markdown: body,
    html: renderMarkdown(body),
    ...(excerpt ? { excerpt: excerpt.slice(0, 1024) } : {}),
    ...(tags && tags.length ? { tags } : {}),
    ...(cover ? { cover_image_url: cover } : {}),
    ...(canonical ? { canonical_url: canonical } : {}),
    seo: Object.keys(seo).length ? seo : null,
    ...(author && Object.keys(author).length ? { author } : {}),
    status: fm.status === "draft" ? "draft" : "published",
    published_at: iso(fm.published_at) ?? iso(fm.date) ?? where.mtimeIso,
    updated_at: iso(fm.updated_at) ?? where.mtimeIso,
    version: typeof fm.version === "number" && Number.isInteger(fm.version) && fm.version >= 1 ? fm.version : 1,
  };
}
