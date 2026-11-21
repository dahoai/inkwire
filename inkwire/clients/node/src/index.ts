// Inkwire client (protocol v1): publish, read, edit, delete, terms, media library, discovery.

/** SEO overrides on publish (SPEC "SEO Profile 1"). Only what differs from the derived defaults. */
export interface SeoPayload {
  title?: string; description?: string; image_url?: string; noindex?: boolean;
  /** Social card title (Open Graph); defaults to the effective title. */
  og_title?: string;
  /** Social card description (Open Graph); defaults to the effective description. */
  og_description?: string;
  /** One JSON object (or array of objects) serialized as a string, at most 20000 characters. */
  json_ld?: string;
}
export interface Author { name?: string; email?: string }

/** The body of `publish` (POST /api/content). `kind` defaults to "post" on the receiver. */
export interface PostPayload {
  external_id: string; title: string; markdown: string;
  kind?: string;
  slug?: string; excerpt?: string; tags?: string[];
  /** A second, coarser grouping next to `tags`. */
  categories?: string[];
  cover_image_url?: string;
  /** Alt text for the cover image. */
  cover_image_alt?: string;
  canonical_url?: string; seo?: SeoPayload; author?: Author;
  status?: "draft" | "published"; published_at?: string;
}
export type ContentPayload = PostPayload;

export interface PublishResult {
  id: string; external_id: string; url: string; slug: string; kind: string;
  status: "draft" | "published"; created: boolean;
}

/** A subset of the publish fields (`inkwire-patch.schema.json`). `null` clears an optional field; `external_id` cannot change. */
export interface PatchPayload {
  title?: string; kind?: string; markdown?: string; slug?: string;
  excerpt?: string | null; tags?: string[] | null; categories?: string[] | null;
  cover_image_url?: string | null; cover_image_alt?: string | null; canonical_url?: string | null;
  /**
   * An object merges per key (an `image_url: null` or `json_ld: null` drops that override);
   * `null` clears them all.
   */
  seo?: {
    title?: string; description?: string; image_url?: string | null; noindex?: boolean;
    og_title?: string; og_description?: string; json_ld?: string | null;
  } | null;
  author?: Author | null;
  status?: "draft" | "published";
  published_at?: string | null;
}

export interface ContentSummary {
  id: string; external_id: string | null; kind: string; title: string; slug: string; url: string;
  status: "draft" | "published"; excerpt?: string; tags?: string[]; categories?: string[];
  published_at: string; updated_at: string;
}
/** The effective SEO values (overrides applied over the derived defaults). */
export interface EffectiveSeo {
  title: string; description: string; image_url?: string; noindex: boolean;
  /** `seo.og_title ?? title`. */
  og_title: string;
  /** `seo.og_description ?? description`. */
  og_description: string;
  /** The serialized JSON-LD override; absent when not set. */
  json_ld?: string;
}
export interface Content extends ContentSummary {
  markdown: string; cover_image_url?: string; cover_image_alt?: string; canonical_url?: string; author?: Author; seo: EffectiveSeo;
}

export interface Capabilities {
  /**
   * What the receiver implements. `upsert` is always present. Known: `upsert`, `list`, `get`, `update`,
   * `delete`, `terms`, `schedule`, `media`, `media_url`, `media_list`, `media_update`, `revisions` (an open set).
   */
  features: string[];
  /** The kinds the receiver holds; never send others. */
  kinds: string[];
  /** Ceilings in bytes; a request over one answers `too_large`. */
  /** `revisions` is how many past versions each entry keeps (feature `revisions`). */
  limits: { markdown_bytes?: number; media_bytes?: number; revisions?: number };
  /** The protocol version; absent when the receiver has no discovery endpoint. */
  inkwire?: number;
  /** About the site; absent when the receiver has no discovery endpoint. `language` is a BCP 47 tag. */
  site?: { name?: string; url?: string; description?: string; language?: string };
}

export interface ListQuery {
  status?: "draft" | "published"; kind?: string; tag?: string;
  /** Entries carrying this one category. */
  category?: string; search?: string;
  external_id?: string; slug?: string; limit?: number; cursor?: string;
}
export interface ListResult { items: ContentSummary[]; next_cursor: string | null }

/** An entry with the `ETag` it was read at; pass `etag` back as `opts.ifMatch` to edit safely. */
export interface ContentWithEtag { content: Content; etag: string | null }
export interface DeleteResult { id: string; deleted: boolean }

/** A past version of an entry: what an update, a restore or a delete replaced. */
export interface RevisionSummary {
  revision: string;
  /** When this version was replaced. */
  created_at: string;
  replaced_by: "update" | "restore" | "delete";
  kind: string; slug: string; title: string; status: "draft" | "published";
}
export interface RevisionsResult { items: RevisionSummary[] }
export interface Revision extends RevisionSummary { entry: Content }

export interface TermsQuery {
  kind?: "tag" | "category";
  /** Case-insensitive substring of the term name. */
  search?: string;
  /** Default 100, at most 500. */
  limit?: number;
}
/** A tag or category some entry carries. `count` is the number of entries carrying it, drafts included. */
export interface Term { kind: "tag" | "category"; name: string; slug: string; count: number }
export interface TermsResult { items: Term[] }

/** An image in the receiver's media library. */
export interface MediaItem {
  id: string; url: string; alt?: string; title?: string; mime_type: string;
  /** ISO-8601 timestamp. */
  created_at: string;
}
/** The answer to `uploadMedia`: the library item that was created. */
export type MediaResult = MediaItem;

export interface MediaListQuery {
  /** Matches the alt text, title and filename. */
  search?: string;
  /** Default 20, at most 100. */
  limit?: number;
  /** Pass the previous page's `next_cursor`. */
  cursor?: string;
}
export interface MediaListResult { items: MediaItem[]; next_cursor: string | null }
/** A subset of the media fields; `null` clears one. At least one key. */
export interface MediaPatch { alt?: string | null; title?: string | null }

export type MediaInput =
  | { url: string; alt?: string }
  | { filename: string; data: Uint8Array; contentType: string; alt?: string };

export class InkwireClientError extends Error {
  constructor(public code: string, message: string, public httpStatus: number) { super(message); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions {
  /** Attempts per call, at least 1 (default 3). Only 429 and 5xx are retried. */
  retries?: number;
  /**
   * The fetch to send with (default: global fetch). A server that talks to user-supplied
   * site URLs should pass an SSRF-guarded fetch that refuses internal hosts on every redirect hop.
   */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}
export type PublishOptions = RequestOptions;
export interface WriteOptions extends RequestOptions {
  /** Sent as `If-Match` (use the `etag` from `get`): a changed entry answers 412, surfaced as code `stale`. */
  ifMatch?: string;
}

const CODE_BY_STATUS: Record<number, string> = {
  400: "invalid_payload", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict",
  412: "stale", 413: "too_large", 429: "rate_limited",
};

interface Call { method: string; path: string; headers?: Record<string, string>; body?: BodyInit; allow404?: boolean }

async function call(baseUrl: string, apiKey: string, c: Call, opts: RequestOptions) {
  const retries = Math.max(1, opts.retries ?? 3);
  const send = opts.fetch ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, "")}${c.path}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await send(url, {
      method: c.method,
      headers: { authorization: `Bearer ${apiKey}`, ...c.headers },
      body: c.body,
    });
    if (res.ok || (c.allow404 && res.status === 404)) return res;
    const retriable = res.status === 429 || res.status >= 500;
    let code = CODE_BY_STATUS[res.status] ?? "internal", message = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) { code = j.error.code ?? code; message = j.error.message ?? message; } } catch {}
    const err = new InkwireClientError(code, message, res.status);
    if (!retriable || attempt === retries) throw err;
    lastErr = err;
    await sleep(2 ** (attempt - 1) * 200);
  }
  throw lastErr;
}

async function json<T>(res: Response): Promise<T> {
  try { return (await res.json()) as T; }
  catch { throw new InkwireClientError("internal", "the receiver answered with a body that is not JSON", res.status); }
}

const idPath = (id: string) => `/api/content/${encodeURIComponent(id)}`;
const mediaPath = (id: string) => `/api/media/${encodeURIComponent(id)}`;
/** `?a=b&...` from the defined, non-empty values (or an empty string). */
function queryString(query: object): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const q = qs.toString();
  return q ? `?${q}` : "";
}
const JSON_HEADERS = { "content-type": "application/json" };

/** POST /api/content: create or update one entry, upserting on `external_id` (and `kind`). */
export async function publish(
  baseUrl: string, apiKey: string, payload: PostPayload, opts: PublishOptions = {},
): Promise<PublishResult> {
  const res = await call(baseUrl, apiKey, {
    method: "POST", path: "/api/content",
    headers: { ...JSON_HEADERS, "idempotency-key": payload.external_id },
    body: JSON.stringify(payload),
  }, opts);
  return json<PublishResult>(res);
}

/** GET /api/inkwire. A receiver without discovery (404) reads as upsert-only, `post` only, no limits (SPEC "Discovery"). */
export async function capabilities(baseUrl: string, apiKey: string, opts: RequestOptions = {}): Promise<Capabilities> {
  const res = await call(baseUrl, apiKey, { method: "GET", path: "/api/inkwire", allow404: true }, opts);
  if (res.status === 404) return { features: ["upsert"], kinds: ["post"], limits: {} };
  const d = await json<Omit<Capabilities, "limits"> & { limits?: Capabilities["limits"] }>(res);
  return { ...d, limits: d.limits ?? {} };
}

/** GET /api/content: one page of summaries. Pass `next_cursor` back as `cursor` for the next page. */
export async function list(baseUrl: string, apiKey: string, query: ListQuery = {}, opts: RequestOptions = {}): Promise<ListResult> {
  const res = await call(baseUrl, apiKey, { method: "GET", path: `/api/content${queryString(query)}` }, opts);
  return json<ListResult>(res);
}

/** GET /api/content/{id}: the full entry and its ETag. */
export async function get(baseUrl: string, apiKey: string, id: string, opts: RequestOptions = {}): Promise<ContentWithEtag> {
  const res = await call(baseUrl, apiKey, { method: "GET", path: idPath(id) }, opts);
  return { content: await json<Content>(res), etag: res.headers.get("etag") };
}

/** PATCH /api/content/{id}: change any subset of fields. Returns the full updated entry and its new ETag. */
export async function update(
  baseUrl: string, apiKey: string, id: string, patch: PatchPayload, opts: WriteOptions = {},
): Promise<ContentWithEtag> {
  const res = await call(baseUrl, apiKey, {
    method: "PATCH", path: idPath(id),
    headers: { ...JSON_HEADERS, ...(opts.ifMatch ? { "if-match": opts.ifMatch } : {}) },
    body: JSON.stringify(patch),
  }, opts);
  return { content: await json<Content>(res), etag: res.headers.get("etag") };
}

/** DELETE /api/content/{id}. */
export async function remove(baseUrl: string, apiKey: string, id: string, opts: WriteOptions = {}): Promise<DeleteResult> {
  const res = await call(baseUrl, apiKey, {
    method: "DELETE", path: idPath(id),
    headers: opts.ifMatch ? { "if-match": opts.ifMatch } : undefined,
  }, opts);
  return json<DeleteResult>(res);
}

/** GET /api/content/{id}/revisions (feature `revisions`): its past versions, newest first. Works after a delete. */
export async function revisions(baseUrl: string, apiKey: string, id: string, opts: RequestOptions = {}): Promise<RevisionsResult> {
  const res = await call(baseUrl, apiKey, { method: "GET", path: `${idPath(id)}/revisions` }, opts);
  return json<RevisionsResult>(res);
}

/** GET /api/content/{id}/revisions/{revision} (feature `revisions`): one past version in full. */
export async function revision(baseUrl: string, apiKey: string, id: string, rev: string, opts: RequestOptions = {}): Promise<Revision> {
  const res = await call(baseUrl, apiKey, { method: "GET", path: `${idPath(id)}/revisions/${encodeURIComponent(rev)}` }, opts);
  return json<Revision>(res);
}

/**
 * POST /api/content/{id}/restore (feature `revisions`): make the entry what it was at `rev` (also brings back a
 * deleted one). The version it replaces is kept, so a restore is undoable too. Returns the entry and its new ETag.
 */
export async function restore(
  baseUrl: string, apiKey: string, id: string, rev: string, opts: WriteOptions = {},
): Promise<ContentWithEtag> {
  const res = await call(baseUrl, apiKey, {
    method: "POST", path: `${idPath(id)}/restore`,
    headers: { ...JSON_HEADERS, ...(opts.ifMatch ? { "if-match": opts.ifMatch } : {}) },
    body: JSON.stringify({ revision: rev }),
  }, opts);
  return { content: await json<Content>(res), etag: res.headers.get("etag") };
}

/** GET /api/terms (feature `terms`): the tags and categories entries use, most used first. */
export async function terms(baseUrl: string, apiKey: string, query: TermsQuery = {}, opts: RequestOptions = {}): Promise<TermsResult> {
  const res = await call(baseUrl, apiKey, { method: "GET", path: `/api/terms${queryString(query)}` }, opts);
  return json<TermsResult>(res);
}

/** POST /api/media: have the receiver fetch `{url}`, or upload `{filename, data, contentType}`. Images only. */
export async function uploadMedia(
  baseUrl: string, apiKey: string, media: MediaInput, opts: RequestOptions = {},
): Promise<MediaResult> {
  let headers: Record<string, string> | undefined;
  let body: BodyInit;
  if ("url" in media) {
    headers = JSON_HEADERS;
    body = JSON.stringify({ url: media.url, ...(media.alt !== undefined ? { alt: media.alt } : {}) });
  } else {
    const form = new FormData(); // the runtime sets the multipart boundary header
    form.append("file", new Blob([media.data as BlobPart], { type: media.contentType }), media.filename);
    if (media.alt !== undefined) form.append("alt", media.alt);
    body = form;
  }
  const res = await call(baseUrl, apiKey, { method: "POST", path: "/api/media", headers, body }, opts);
  return json<MediaResult>(res);
}

/** GET /api/media (feature `media_list`): one page of the media library, newest first. */
export async function listMedia(
  baseUrl: string, apiKey: string, query: MediaListQuery = {}, opts: RequestOptions = {},
): Promise<MediaListResult> {
  const res = await call(baseUrl, apiKey, { method: "GET", path: `/api/media${queryString(query)}` }, opts);
  return json<MediaListResult>(res);
}

/** PATCH /api/media/{id} (feature `media_update`): set or clear (`null`) the alt text and title. Returns the item. */
export async function updateMedia(
  baseUrl: string, apiKey: string, id: string, patch: MediaPatch, opts: RequestOptions = {},
): Promise<MediaItem> {
  const res = await call(baseUrl, apiKey, {
    method: "PATCH", path: mediaPath(id), headers: JSON_HEADERS, body: JSON.stringify(patch),
  }, opts);
  return json<MediaItem>(res);
}

/**
 * Pure: is this entry scheduled, that is `published` with a `published_at` still in the future?
 * (Reads report scheduled entries as `published`; SPEC "Scheduling".)
 */
export function isScheduled(entry: Pick<ContentSummary, "status" | "published_at">, now: Date = new Date()): boolean {
  return entry.status === "published" && new Date(entry.published_at).getTime() > now.getTime();
}

const preview = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);

/**
 * Pure text edits (no network). Each `find` must occur exactly once in the current text, else this
 * throws `InkwireClientError` `edit_not_found` / `edit_ambiguous` and returns nothing. Edits apply in
 * order, so a later `find` sees the result of an earlier `replace`. Typical flow:
 * `const { content, etag } = await get(...); await update(..., id, { markdown: edits(content.markdown, [...]) }, { ifMatch: etag })`.
 */
export function edits(markdown: string, changes: { find: string; replace: string }[]): string {
  let out = markdown;
  changes.forEach((c, i) => {
    const n = i + 1;
    if (typeof c.find !== "string" || c.find === "") {
      throw new InkwireClientError("edit_not_found", `edit ${n} has an empty "find"`, 0);
    }
    let hits = 0;
    for (let at = out.indexOf(c.find); at !== -1; at = out.indexOf(c.find, at + c.find.length)) hits++;
    if (hits === 0) throw new InkwireClientError("edit_not_found", `edit ${n}: "${preview(c.find)}" does not occur in the markdown`, 0);
    if (hits > 1) {
      throw new InkwireClientError("edit_ambiguous",
        `edit ${n}: "${preview(c.find)}" occurs ${hits} times; include more surrounding text so it matches once`, 0);
    }
    const at = out.indexOf(c.find);
    out = out.slice(0, at) + c.replace + out.slice(at + c.find.length);
  });
  return out;
}
