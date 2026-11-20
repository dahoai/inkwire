export type { UpsertInput, PatchInput } from "./schema.js";

/** Effective SEO values (SEO Profile 1): the overrides applied over the derived defaults. */
export interface SeoMetadata {
  title: string;
  description: string;
  image_url?: string;
  noindex: boolean;
}

/** What the caller overrode. Only keys the caller sent are present. */
export interface SeoOverrides {
  title?: string;
  description?: string;
  image_url?: string;
  noindex?: boolean;
}

/** An entry as a store holds it. `url` and `etag` are finalized by the store. */
export interface StoredContent {
  id: string;
  /** The scope the entry belongs to (`ApiKey.scope`). */
  key: string;
  external_id: string | null;
  kind: string;
  title: string;
  slug: string;
  markdown: string;
  html: string;
  excerpt?: string;
  tags?: string[];
  cover_image_url?: string;
  canonical_url?: string;
  seo: SeoOverrides | null;
  author?: { name?: string; email?: string };
  status: "draft" | "published";
  published_at: string;
  updated_at: string;
  version: number;
  etag: string;
  /** Public address, finalized by the store. */
  url: string;
}

/** What the handlers give `save`. `id` is absent on create; present (the old id) when updating, even if kind/slug moved it. */
export type SaveEntry = Omit<StoredContent, "id" | "url" | "etag"> & { id?: string };

export interface ListFilter {
  status?: "draft" | "published";
  kind?: string;
  tag?: string;
  /** Case-insensitive match over title, excerpt and markdown. */
  search?: string;
  external_id?: string;
  slug?: string;
  limit: number;
  cursor?: string;
}

export interface ListResult {
  items: StoredContent[];
  next_cursor: string | null;
}

export interface StoredMedia {
  id: string;
  url: string;
  alt?: string;
}

export interface MediaInput {
  bytes: Buffer;
  /** One of image/jpeg, png, gif, webp, avif, already sniffed by the core. */
  contentType: string;
  filename: string;
  alt?: string;
}

/**
 * The whole storage contract: four methods, every one scoped by `key` (the `ApiKey.scope`). Slug
 * conflicts and external_id lookups go through `list` with exact filters, so implement those
 * efficiently. `saveMedia` is optional: a store without it makes the receiver omit the `media`
 * feature.
 */
export interface ContentStore {
  get(key: string, id: string): Promise<StoredContent | null>;
  list(key: string, filter: ListFilter): Promise<ListResult>;
  save(key: string, entry: SaveEntry): Promise<StoredContent>;
  remove(key: string, id: string): Promise<boolean>;
  saveMedia?(key: string, media: MediaInput): Promise<StoredMedia>;
}
