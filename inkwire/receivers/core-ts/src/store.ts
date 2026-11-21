export type { UpsertInput, PatchInput } from "./schema.js";

/** Effective SEO values (SEO Profile 1): the overrides applied over the derived defaults. */
export interface SeoMetadata {
  title: string;
  description: string;
  image_url?: string;
  noindex: boolean;
  og_title: string;
  og_description: string;
  json_ld?: string;
}

/** What the caller overrode. Only keys the caller sent are present. */
export interface SeoOverrides {
  title?: string;
  description?: string;
  image_url?: string;
  noindex?: boolean;
  og_title?: string;
  og_description?: string;
  json_ld?: string;
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
  categories?: string[];
  cover_image_url?: string;
  cover_image_alt?: string;
  canonical_url?: string;
  seo: SeoOverrides | null;
  author?: { name?: string; email?: string };
  /** BCP 47 language of this entry (feature `translations`). */
  lang?: string;
  /** Entries sharing it are translations of each other (feature `translations`). */
  translation_key?: string;
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
  category?: string;
  /** Case-insensitive match over title, excerpt and markdown. */
  search?: string;
  external_id?: string;
  slug?: string;
  /** Feature `translations`: exact matches. */
  lang?: string;
  translation_key?: string;
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
  title?: string;
  /** One of image/jpeg, png, gif, webp, avif. */
  mime_type: string;
  /** Pixels, when the receiver could read them from the file. */
  width?: number;
  height?: number;
  created_at: string;
}

export interface MediaListFilter {
  /** Case-insensitive match over alt, title and filename. */
  search?: string;
  limit: number;
  cursor?: string;
}

export interface MediaListResult {
  items: StoredMedia[];
  next_cursor: string | null;
}

export interface MediaInput {
  bytes: Buffer;
  /** One of image/jpeg, png, gif, webp, avif, already sniffed by the core. */
  contentType: string;
  filename: string;
  alt?: string;
  /** Read from the bytes by the core when it can. */
  width?: number;
  height?: number;
}

/**
 * A past version of an entry: the state a write replaced (an update, a restore or a delete).
 * Restoring it makes the entry that again. `entry` is the whole entry as it was.
 */
export interface StoredRevision {
  /** Opaque, unique within the entry's history. */
  revision: string;
  /** When this version was replaced. */
  created_at: string;
  /** What replaced it. */
  replaced_by: "update" | "restore" | "delete";
  entry: Omit<StoredContent, "key">;
}

/** An old address of an entry (feature `redirects`): `kind`/`slug` now lead to the entry `id`. */
export interface StoredRedirect {
  kind: string;
  slug: string;
  id: string;
  created_at: string;
}

/**
 * The whole storage contract: four methods (plus optional media methods), every one scoped by `key` (the `ApiKey.scope`). Slug
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
  /** Newest first by `created_at`, ties by `id`; `recencyKey` and `pageOf` (list.ts) do the paging. A store without it omits `media_list`. */
  listMedia?(key: string, filter: MediaListFilter): Promise<MediaListResult>;
  /** `null` clears. Returns null for an unknown id. A store without it omits `media_update`. */
  updateMedia?(key: string, id: string, patch: { alt?: string | null; title?: string | null }): Promise<StoredMedia | null>;
  /**
   * Revisions (all three, or none: a store without them makes the receiver omit `revisions`). The
   * history belongs to an entry id and outlives a delete, so a deleted entry can be restored.
   * `saveRevision` adds one and keeps only the newest `keep`.
   */
  saveRevision?(key: string, id: string, revision: StoredRevision, keep: number): Promise<void>;
  /** Newest first. An id with no history is an empty list. */
  listRevisions?(key: string, id: string): Promise<StoredRevision[]>;
  /** The entry's id changed (a slug or kind change in a store whose ids follow them): its history follows it. */
  moveRevisions?(key: string, fromId: string, toId: string): Promise<void>;
  /**
   * Redirects (all three, or none: a store without them makes the receiver omit `redirects`).
   * `saveRedirect` replaces any redirect from the same kind and slug.
   */
  saveRedirect?(key: string, redirect: StoredRedirect): Promise<void>;
  findRedirect?(key: string, kind: string, slug: string): Promise<StoredRedirect | null>;
  /** The entry's id changed: redirects to `fromId` now lead to `toId`. */
  moveRedirects?(key: string, fromId: string, toId: string): Promise<void>;
  /**
   * A site that also serves pages this store does not hold at the same addresses (Markdown files,
   * static routes): true when `path` (like `/blog/a-post`) is one of them, so the `warnings` link
   * check does not call it broken. Without it, a path shaped like an entry's address that matches no
   * entry is broken.
   */
  pageExists?(key: string, path: string): Promise<boolean>;
  /** True when the store keeps `lang` and `translation_key` and filters `list` by them (feature `translations`). */
  readonly translations?: boolean;
}
