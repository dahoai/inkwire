import { InkwireError } from "./errors.js";
import type { ListFilter, MediaListFilter, MediaListResult, StoredContent, StoredMedia } from "./store.js";

/** The filter semantics every store implements (status, kind, tag, search, external_id, slug). */
export function matches(e: StoredContent, f: ListFilter): boolean {
  if (f.status && e.status !== f.status) return false;
  if (f.kind && e.kind !== f.kind) return false;
  if (f.slug && e.slug !== f.slug) return false;
  if (f.external_id !== undefined && e.external_id !== f.external_id) return false;
  if (f.tag && !(e.tags ?? []).includes(f.tag)) return false;
  if (f.category && !(e.categories ?? []).includes(f.category)) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const hay = `${e.title}\n${e.excerpt ?? ""}\n${e.markdown}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** The media filter semantics: alt, title and filename, case-insensitive. */
export function mediaMatches(m: StoredMedia, search: string | undefined): boolean {
  if (!search) return true;
  const q = search.toLowerCase();
  const filename = decodeURIComponent(m.url.split("/").pop() ?? "");
  return `${m.alt ?? ""}\n${m.title ?? ""}\n${filename}`.toLowerCase().includes(q);
}

export function encodeCursor(k: string): string {
  return Buffer.from(JSON.stringify({ k })).toString("base64url");
}

export function decodeCursor(cursor: string): string {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof v?.k === "string") return v.k;
  } catch {}
  throw new InkwireError("invalid_payload", "cursor: not a cursor this receiver issued");
}

/**
 * Keyset page over `items` already sorted ascending by `keyOf`: the page starts after the cursor's
 * key, so an entry added or removed between pages never repeats or skips its neighbours.
 */
export function pageOf<T>(
  items: T[],
  keyOf: (t: T) => string,
  limit: number,
  cursor?: string,
): { items: T[]; next_cursor: string | null } {
  const after = cursor ? decodeCursor(cursor) : null;
  const rest = after === null ? items : items.filter((t) => keyOf(t) > after);
  const page = rest.slice(0, limit);
  const more = rest.length > page.length;
  return { items: page, next_cursor: more && page.length ? encodeCursor(keyOf(page[page.length - 1]!)) : null };
}

/** Newest first, then id: a sort key that works as a plain ascending string. */
export function recencyKey(e: Pick<StoredContent, "updated_at" | "id"> | Pick<StoredMedia, "created_at" | "id">): string {
  const t = Date.parse("updated_at" in e ? e.updated_at : e.created_at);
  const inverted = (8.64e15 - (Number.isNaN(t) ? 0 : t)).toString().padStart(17, "0");
  return `${inverted}|${e.id}`;
}

/** Filter, order (newest first) and page an in-memory set of media: what stores without a query language use. */
export function pageMedia(all: StoredMedia[], f: MediaListFilter): MediaListResult {
  const found = all.filter((m) => mediaMatches(m, f.search));
  found.sort((a, b) => (recencyKey(a) < recencyKey(b) ? -1 : 1));
  return pageOf(found, recencyKey, f.limit, f.cursor);
}
