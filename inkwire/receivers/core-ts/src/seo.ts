import type { SeoMetadata, SeoOverrides, StoredContent } from "./store.js";

/** SEO Profile 1: the overrides applied over the derived defaults. */
export function effectiveSeo(
  e: Pick<StoredContent, "title" | "excerpt" | "cover_image_url" | "seo">,
): SeoMetadata {
  const image = e.seo?.image_url ?? e.cover_image_url;
  return {
    title: e.seo?.title ?? e.title,
    description: e.seo?.description ?? (e.excerpt || e.title),
    ...(image ? { image_url: image } : {}),
    noindex: e.seo?.noindex ?? false,
  };
}

/** Overrides as sent: only the keys present, or null when nothing is overridden. */
export function cleanOverrides(seo: SeoOverrides | null | undefined): SeoOverrides | null {
  if (!seo) return null;
  const out: SeoOverrides = {};
  if (seo.title !== undefined) out.title = seo.title;
  if (seo.description !== undefined) out.description = seo.description;
  if (seo.image_url !== undefined) out.image_url = seo.image_url;
  if (seo.noindex !== undefined) out.noindex = seo.noindex;
  return Object.keys(out).length ? out : null;
}

/** PATCH semantics for `seo`: null clears; an object merges per key (an `image_url: null` drops that key). */
export function mergeOverrides(
  current: SeoOverrides | null,
  patch: { title?: string; description?: string; image_url?: string | null; noindex?: boolean } | null,
): SeoOverrides | null {
  if (patch === null) return null;
  const merged: SeoOverrides = { ...(current ?? {}) };
  if (patch.title !== undefined) merged.title = patch.title;
  if (patch.description !== undefined) merged.description = patch.description;
  if (patch.image_url === null) delete merged.image_url;
  else if (patch.image_url !== undefined) merged.image_url = patch.image_url;
  if (patch.noindex !== undefined) merged.noindex = patch.noindex;
  return cleanOverrides(merged);
}
