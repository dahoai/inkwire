import type { SeoMetadata, SeoOverrides, StoredContent } from "./store.js";

/** SEO Profile 1: the overrides applied over the derived defaults. */
export function effectiveSeo(
  e: Pick<StoredContent, "title" | "excerpt" | "cover_image_url" | "seo">,
): SeoMetadata {
  const image = e.seo?.image_url ?? e.cover_image_url;
  const title = e.seo?.title ?? e.title;
  const description = e.seo?.description ?? (e.excerpt || e.title);
  return {
    title,
    description,
    ...(image ? { image_url: image } : {}),
    noindex: e.seo?.noindex ?? false,
    og_title: e.seo?.og_title ?? title,
    og_description: e.seo?.og_description ?? description,
    ...(e.seo?.json_ld !== undefined ? { json_ld: e.seo.json_ld } : {}),
  };
}

const KEYS = ["title", "description", "image_url", "noindex", "og_title", "og_description", "json_ld"] as const;

/** Overrides as sent: only the keys present, or null when nothing is overridden. */
export function cleanOverrides(seo: SeoOverrides | null | undefined): SeoOverrides | null {
  if (!seo) return null;
  const out: Record<string, unknown> = {};
  for (const k of KEYS) if (seo[k] !== undefined && seo[k] !== null) out[k] = seo[k];
  return Object.keys(out).length ? (out as SeoOverrides) : null;
}

/** PATCH semantics for `seo`: null clears; an object merges per key (a null drops that key). */
export function mergeOverrides(
  current: SeoOverrides | null,
  patch: Partial<Record<(typeof KEYS)[number], unknown>> | null,
): SeoOverrides | null {
  if (patch === null) return null;
  const merged: Record<string, unknown> = { ...(current ?? {}) };
  for (const k of KEYS) {
    if (patch[k] === null) delete merged[k];
    else if (patch[k] !== undefined) merged[k] = patch[k];
  }
  return cleanOverrides(merged as SeoOverrides);
}
