// Inkwire client (protocol v1, revised: /api/content with `kind`, read/edit/delete, media, discovery).

export interface SeoPayload {
  title?: string; description?: string; image_url?: string; noindex?: boolean;
}
export interface Author { name?: string; email?: string }

/** The body of `publish` (POST /api/content). `kind` defaults to "post" on the receiver. */
export interface PostPayload {
  external_id: string; title: string; markdown: string;
  kind?: string;
  slug?: string; excerpt?: string; tags?: string[]; cover_image_url?: string;
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
  excerpt?: string | null; tags?: string[] | null;
  cover_image_url?: string | null; canonical_url?: string | null;
  /** An object merges per key (an `image_url: null` drops that override); `null` clears them all. */
  seo?: { title?: string; description?: string; image_url?: string | null; noindex?: boolean } | null;
  author?: Author | null;
  status?: "draft" | "published";
  published_at?: string | null;
}

export interface ContentSummary {
  id: string; external_id: string | null; kind: string; title: string; slug: string; url: string;
  status: "draft" | "published"; excerpt?: string; tags?: string[];
  published_at: string; updated_at: string;
}
/** The effective SEO values (overrides applied over the derived defaults). */
export interface EffectiveSeo { title: string; description: string; image_url?: string; noindex: boolean }
export interface Content extends ContentSummary {
  markdown: string; cover_image_url?: string; canonical_url?: string; author?: Author; seo: EffectiveSeo;
}

export interface Capabilities {
  features: string[]; kinds: string[]; limits: { markdown_bytes?: number; media_bytes?: number };
  /** Only on receivers that answer discovery. */
  inkwire?: number; site?: { name?: string; url?: string };
}

export interface ListQuery {
  status?: "draft" | "published"; kind?: string; tag?: string; search?: string;
  external_id?: string; slug?: string; limit?: number; cursor?: string;
}
export interface ListResult { items: ContentSummary[]; next_cursor: string | null }

/** An entry with the `ETag` it was read at; pass `etag` back as `opts.ifMatch` to edit safely. */
export interface ContentWithEtag { content: Content; etag: string | null }
export interface DeleteResult { id: string; deleted: boolean }
export interface MediaResult { id: string; url: string; alt?: string }

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

/** GET /api/inkwire. A receiver without discovery (404) is upsert-only, `post` only, no limits. */
export async function capabilities(baseUrl: string, apiKey: string, opts: RequestOptions = {}): Promise<Capabilities> {
  const res = await call(baseUrl, apiKey, { method: "GET", path: "/api/inkwire", allow404: true }, opts);
  if (res.status === 404) return { features: ["upsert"], kinds: ["post"], limits: {} };
  const d = await json<Partial<Capabilities>>(res);
  return { ...d, features: d.features ?? ["upsert"], kinds: d.kinds ?? ["post"], limits: d.limits ?? {} };
}

/** GET /api/content: one page of summaries. Pass `next_cursor` back as `cursor` for the next page. */
export async function list(baseUrl: string, apiKey: string, query: ListQuery = {}, opts: RequestOptions = {}): Promise<ListResult> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const q = qs.toString();
  const res = await call(baseUrl, apiKey, { method: "GET", path: `/api/content${q ? `?${q}` : ""}` }, opts);
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
