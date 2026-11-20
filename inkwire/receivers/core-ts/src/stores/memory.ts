import { randomBytes } from "node:crypto";
import { matches, pageMedia, pageOf, recencyKey } from "../list.js";
import { patchMeta, toMedia } from "../media-meta.js";
import type { ContentStore, ListFilter, ListResult, MediaInput, MediaListFilter, MediaListResult, SaveEntry, StoredContent, StoredMedia } from "../store.js";

export interface MemoryStoreOptions {
  /** Public address of an entry. Default `https://example.test/<kind>/<slug>`. */
  urlFor?: (e: { kind: string; slug: string }) => string;
  mediaUrlBase?: string;
}

/** In-process store for tests and demos. Nothing survives a restart. Ids are opaque and survive a slug or kind change. */
export class MemoryStore implements ContentStore {
  private entries = new Map<string, Map<string, StoredContent>>();
  private media = new Map<string, Map<string, StoredMedia & { bytes: Buffer; contentType: string }>>();
  constructor(private opts: MemoryStoreOptions = {}) {}

  private scope(key: string) {
    let m = this.entries.get(key);
    if (!m) this.entries.set(key, (m = new Map()));
    return m;
  }

  async get(key: string, id: string) {
    const e = this.scope(key).get(id);
    return e ? structuredClone(e) : null;
  }

  async list(key: string, filter: ListFilter): Promise<ListResult> {
    const all = [...this.scope(key).values()].filter((e) => matches(e, filter));
    all.sort((a, b) => (recencyKey(a) < recencyKey(b) ? -1 : 1));
    const page = pageOf(all, recencyKey, filter.limit, filter.cursor);
    return { items: page.items.map((e) => structuredClone(e)), next_cursor: page.next_cursor };
  }

  async save(key: string, entry: SaveEntry): Promise<StoredContent> {
    const scope = this.scope(key);
    const id = entry.id ?? randomBytes(8).toString("hex");
    const { id: _ignored, ...rest } = entry;
    const url = this.opts.urlFor ? this.opts.urlFor(entry) : `https://example.test/${entry.kind}/${entry.slug}`;
    const saved: StoredContent = { ...rest, id, key, url, etag: `${id}-${entry.version}` };
    scope.set(id, structuredClone(saved));
    return structuredClone(saved);
  }

  async remove(key: string, id: string) {
    return this.scope(key).delete(id);
  }

  async saveMedia(key: string, m: MediaInput): Promise<StoredMedia> {
    const id = randomBytes(8).toString("hex");
    const url = `${this.opts.mediaUrlBase ?? "https://example.test/media"}/${id}-${m.filename}`;
    const saved = toMedia(id, url, { ...(m.alt !== undefined ? { alt: m.alt } : {}), content_type: m.contentType, created_at: new Date().toISOString() });
    let bucket = this.media.get(key);
    if (!bucket) this.media.set(key, (bucket = new Map()));
    bucket.set(id, { ...saved, bytes: m.bytes, contentType: m.contentType });
    return saved;
  }

  async listMedia(key: string, filter: MediaListFilter): Promise<MediaListResult> {
    const all = [...(this.media.get(key)?.values() ?? [])].map(({ bytes: _b, contentType: _c, ...m }) => m);
    return pageMedia(all, filter);
  }

  async updateMedia(key: string, id: string, patch: { alt?: string | null; title?: string | null }): Promise<StoredMedia | null> {
    const cur = this.media.get(key)?.get(id);
    if (!cur) return null;
    const meta = patchMeta({ ...(cur.alt !== undefined ? { alt: cur.alt } : {}), ...(cur.title !== undefined ? { title: cur.title } : {}), content_type: cur.mime_type, created_at: cur.created_at }, patch);
    const { bytes, contentType } = cur;
    const next = { ...toMedia(id, cur.url, meta), bytes, contentType };
    this.media.get(key)!.set(id, next);
    const { bytes: _b, contentType: _c, ...out } = next;
    return out;
  }
}
