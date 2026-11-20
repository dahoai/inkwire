import { type ApiKey, authorize, requireWrite } from "./auth.js";
import { InkwireError } from "./errors.js";
import { withLock } from "./lock.js";
import { assertImage, parseMultipart, safeFilename } from "./media.js";
import { renderMarkdown, slugify } from "./render.js";
import { ContentInput, MediaPatchSchema, MediaUrlInput, PatchSchema } from "./schema.js";
import { cleanOverrides, effectiveSeo, mergeOverrides } from "./seo.js";
import { pageMedia } from "./list.js";
import type { ContentStore, SaveEntry, StoredContent, StoredMedia } from "./store.js";

export const INKWIRE_VERSION = "1";
export const MAX_PAGE = 100;
export const DEFAULT_PAGE = 20;
const DEFAULT_LIMITS = { markdown_bytes: 1_000_000, media_bytes: 10_000_000 };

export interface FetchedMedia {
  bytes: Buffer | Uint8Array;
  contentType?: string;
  filename?: string;
}

export interface InkwireConfig {
  site: { name: string; url: string; description?: string; language?: string };
  /** The kinds this receiver holds. */
  kinds: string[];
  limits?: { markdown_bytes?: number; media_bytes?: number };
  /** What discovery advertises; derived from the store and this config when omitted. `upsert` is always added. */
  features?: string[];
  /**
   * True when the site holds a `published` entry back until its `published_at` (it renders future-dated
   * entries as not yet public). Advertises `schedule`; leave it off if the site would show them at once.
   */
  schedule?: boolean;
  /**
   * Fetches a URL for `POST /api/media` `{url}`. MUST be SSRF-guarded by whoever supplies it (public
   * http(s) hosts only, redirects re-checked): the core only checks the URL is http(s).
   */
  fetchMedia?: (url: string) => Promise<FetchedMedia>;
}

export interface HandlerResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const base = (extra: Record<string, string> = {}): Record<string, string> => ({
  "Inkwire-Version": INKWIRE_VERSION,
  "Content-Type": "application/json",
  ...extra,
});

const ok = (body: unknown, extra: Record<string, string> = {}): HandlerResult => ({ status: 200, headers: base(extra), body });

function fail(e: unknown): HandlerResult {
  if (e instanceof InkwireError) {
    return { status: e.httpStatus, headers: base(), body: { error: { code: e.code, message: e.message || e.code } } };
  }
  // Anything else is a receiver/storage fault: say so without leaking what it was.
  console.error("[inkwire] internal error:", e instanceof Error ? e.message : "unknown");
  return { status: 500, headers: base(), body: { error: { code: "internal", message: "internal error" } } };
}

async function guarded(fn: () => Promise<HandlerResult>): Promise<HandlerResult> {
  try {
    return await fn();
  } catch (e) {
    return fail(e);
  }
}

const limitsOf = (config?: InkwireConfig) => ({ ...DEFAULT_LIMITS, ...(config?.limits ?? {}) });

function parseJson(rawBody: string | Buffer | undefined): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(typeof rawBody === "string" ? rawBody : (rawBody ?? Buffer.alloc(0)).toString("utf8"));
  } catch {
    throw new InkwireError("invalid_payload", "the body is not valid JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new InkwireError("invalid_payload", "the body must be a JSON object");
  }
  return v as Record<string, unknown>;
}

function zodMessage(e: { issues: { path: (string | number)[]; message: string; code: string; keys?: string[] }[] }): string {
  return e.issues
    .slice(0, 3)
    .map((i) => {
      const where = i.path.join(".");
      if (i.code === "unrecognized_keys") return `${where ? `${where}: ` : ""}unknown field ${(i.keys ?? []).join(", ")}`;
      return where ? `${where}: ${i.message}` : i.message;
    })
    .join("; ");
}

function validate<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: any } }, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new InkwireError("invalid_payload", zodMessage(r.error));
  return r.data;
}

const bytesOf = (s: string) => Buffer.byteLength(s, "utf8");
const quote = (etag: string) => `"${etag}"`;

function matchesIfMatch(header: string | null | undefined, etag: string): boolean {
  if (header === null || header === undefined) return true;
  const tokens = header.split(",").map((t) => t.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1"));
  return tokens.includes("*") || tokens.includes(etag);
}

function checkIfMatch(header: string | null | undefined, entry: StoredContent) {
  if (!matchesIfMatch(header, entry.etag)) {
    throw new InkwireError("stale", "the entry changed since you read it (If-Match no longer matches); read it again and retry");
  }
}

function summary(e: StoredContent) {
  return {
    id: e.id,
    external_id: e.external_id,
    kind: e.kind,
    title: e.title,
    slug: e.slug,
    url: e.url,
    status: e.status,
    ...(e.excerpt !== undefined ? { excerpt: e.excerpt } : {}),
    ...(e.tags !== undefined ? { tags: e.tags } : {}),
    ...(e.categories !== undefined ? { categories: e.categories } : {}),
    published_at: e.published_at,
    updated_at: e.updated_at,
  };
}

function full(e: StoredContent) {
  return {
    ...summary(e),
    markdown: e.markdown,
    ...(e.cover_image_url !== undefined ? { cover_image_url: e.cover_image_url } : {}),
    ...(e.cover_image_alt !== undefined ? { cover_image_alt: e.cover_image_alt } : {}),
    ...(e.canonical_url !== undefined ? { canonical_url: e.canonical_url } : {}),
    ...(e.author !== undefined ? { author: e.author } : {}),
    seo: effectiveSeo(e),
  };
}

const etagHeader = (e: StoredContent) => ({ ETag: quote(e.etag) });

function requireKind(config: InkwireConfig, kind: string) {
  if (!config.kinds.includes(kind)) {
    throw new InkwireError("invalid_payload", `kind "${kind}" is not held by this receiver (it holds: ${config.kinds.join(", ")})`);
  }
}

async function slugOwner(store: ContentStore, scope: string, kind: string, slug: string): Promise<StoredContent | undefined> {
  return (await store.list(scope, { kind, slug, limit: 1 })).items[0];
}

/** `base`, `base-2`, `base-3`… the first one no other entry of that kind owns. */
async function freeSlug(store: ContentStore, scope: string, kind: string, wanted: string, selfId?: string): Promise<string> {
  for (let n = 1; n <= 500; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const candidate = wanted.slice(0, 255 - suffix.length).replace(/-+$/g, "") + suffix;
    const owner = await slugOwner(store, scope, kind, candidate);
    if (!owner || owner.id === selfId) return candidate;
  }
  return `${wanted.slice(0, 240).replace(/-+$/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}

async function assertSlugFree(store: ContentStore, scope: string, kind: string, slug: string, selfId?: string) {
  const owner = await slugOwner(store, scope, kind, slug);
  if (owner && owner.id !== selfId) {
    throw new InkwireError("conflict", `slug "${slug}" is already used by another ${kind}`);
  }
}

function parseLimit(query: URLSearchParams, fallback: number, max: number): number {
  const raw = query.get("limit");
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new InkwireError("invalid_payload", "limit must be a positive integer");
  return Math.min(n, max);
}

const authedWrite = (authHeader: string | null | undefined, keys: ApiKey[]) => {
  const key = authorize(authHeader, keys);
  requireWrite(key);
  return key;
};

// ---------------------------------------------------------------------------------------------
// POST /api/content

export interface UpsertArgs {
  authHeader: string | null | undefined;
  rawBody: string | Buffer;
  keys: ApiKey[];
  store: ContentStore;
  config: InkwireConfig;
}

export function handleUpsert({ authHeader, rawBody, keys, store, config }: UpsertArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authedWrite(authHeader, keys);
    const limits = limitsOf(config);
    // JSON escapes can make a body up to ~6x its text: refuse the absurd before parsing it.
    if (rawBody.length > limits.markdown_bytes * 6 + 100_000) {
      throw new InkwireError("too_large", `the body is over the limit (markdown_bytes ${limits.markdown_bytes})`);
    }
    const input = validate(ContentInput, parseJson(rawBody));
    requireKind(config, input.kind);
    if (bytesOf(input.markdown) > limits.markdown_bytes) {
      throw new InkwireError("too_large", `markdown is over the limit (markdown_bytes ${limits.markdown_bytes})`);
    }
    const scope = key.scope;

    return withLock(scope, async () => {
      const existing = (await store.list(scope, { kind: input.kind, external_id: input.external_id, limit: 1 })).items[0];
      let slug: string;
      if (input.slug) {
        await assertSlugFree(store, scope, input.kind, input.slug, existing?.id);
        slug = input.slug;
      } else if (existing) {
        slug = existing.slug;
      } else {
        slug = await freeSlug(store, scope, input.kind, slugify(input.title));
      }
      const now = new Date().toISOString();
      const entry: SaveEntry = {
        ...(existing ? { id: existing.id } : {}),
        key: scope,
        external_id: input.external_id,
        kind: input.kind,
        title: input.title,
        slug,
        markdown: input.markdown,
        html: renderMarkdown(input.markdown),
        ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.categories !== undefined ? { categories: input.categories } : {}),
        ...(input.cover_image_url !== undefined ? { cover_image_url: input.cover_image_url } : {}),
        ...(input.cover_image_alt !== undefined ? { cover_image_alt: input.cover_image_alt } : {}),
        ...(input.canonical_url !== undefined ? { canonical_url: input.canonical_url } : {}),
        seo: cleanOverrides(input.seo),
        ...(input.author !== undefined ? { author: input.author } : {}),
        status: input.status,
        published_at: input.published_at ?? existing?.published_at ?? now,
        updated_at: now,
        version: (existing?.version ?? 0) + 1,
      };
      const saved = await store.save(scope, entry);
      return ok(
        {
          id: saved.id,
          external_id: saved.external_id,
          url: saved.url,
          slug: saved.slug,
          kind: saved.kind,
          status: saved.status,
          created: !existing,
        },
        etagHeader(saved),
      );
    });
  });
}

// ---------------------------------------------------------------------------------------------
// GET /api/content

export interface ListArgs {
  authHeader: string | null | undefined;
  query: URLSearchParams;
  keys: ApiKey[];
  store: ContentStore;
  config?: InkwireConfig;
}

export function handleList({ authHeader, query, keys, store }: ListArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authorize(authHeader, keys);
    const status = query.get("status") || undefined;
    if (status !== undefined && status !== "draft" && status !== "published") {
      throw new InkwireError("invalid_payload", 'status must be "draft" or "published"');
    }
    const limit = parseLimit(query, DEFAULT_PAGE, MAX_PAGE);
    const result = await store.list(key.scope, {
      ...(status ? { status } : {}),
      ...(query.get("kind") ? { kind: query.get("kind")! } : {}),
      ...(query.get("tag") ? { tag: query.get("tag")! } : {}),
      ...(query.get("category") ? { category: query.get("category")! } : {}),
      ...(query.get("search") ? { search: query.get("search")! } : {}),
      ...(query.get("external_id") ? { external_id: query.get("external_id")! } : {}),
      ...(query.get("slug") ? { slug: query.get("slug")! } : {}),
      limit,
      ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
    });
    return ok({ items: result.items.map(summary), next_cursor: result.next_cursor });
  });
}

// ---------------------------------------------------------------------------------------------
// GET /api/content/{id}

export interface GetArgs {
  authHeader: string | null | undefined;
  id: string;
  keys: ApiKey[];
  store: ContentStore;
}

export function handleGet({ authHeader, id, keys, store }: GetArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authorize(authHeader, keys);
    const entry = await store.get(key.scope, id);
    if (!entry) throw new InkwireError("not_found", `no entry with id "${id}"`);
    return ok(full(entry), etagHeader(entry));
  });
}

// ---------------------------------------------------------------------------------------------
// PATCH /api/content/{id}

export interface PatchArgs {
  authHeader: string | null | undefined;
  id: string;
  rawBody: string | Buffer;
  ifMatchHeader?: string | null;
  keys: ApiKey[];
  store: ContentStore;
  config: InkwireConfig;
}

export function handlePatch({ authHeader, id, rawBody, ifMatchHeader, keys, store, config }: PatchArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authedWrite(authHeader, keys);
    const limits = limitsOf(config);
    if (rawBody.length > limits.markdown_bytes * 6 + 100_000) {
      throw new InkwireError("too_large", `the body is over the limit (markdown_bytes ${limits.markdown_bytes})`);
    }
    const raw = parseJson(rawBody);
    if ("external_id" in raw) throw new InkwireError("invalid_payload", "external_id cannot be changed");
    const patch = validate(PatchSchema, raw);
    if (patch.kind !== undefined) requireKind(config, patch.kind);
    if (patch.markdown !== undefined && bytesOf(patch.markdown) > limits.markdown_bytes) {
      throw new InkwireError("too_large", `markdown is over the limit (markdown_bytes ${limits.markdown_bytes})`);
    }
    const scope = key.scope;

    return withLock(scope, async () => {
      const current = await store.get(scope, id);
      if (!current) throw new InkwireError("not_found", `no entry with id "${id}"`);
      checkIfMatch(ifMatchHeader, current);

      const now = new Date().toISOString();
      const kind = patch.kind ?? current.kind;
      let slug = patch.slug ?? current.slug;
      if (patch.slug !== undefined) {
        if (patch.slug !== current.slug || kind !== current.kind) await assertSlugFree(store, scope, kind, patch.slug, current.id);
      } else if (kind !== current.kind) {
        slug = await freeSlug(store, scope, kind, current.slug, current.id);
      }

      const next: SaveEntry = {
        id: current.id,
        key: scope,
        external_id: current.external_id,
        kind,
        title: patch.title ?? current.title,
        slug,
        markdown: patch.markdown ?? current.markdown,
        html: patch.markdown !== undefined ? renderMarkdown(patch.markdown) : current.html,
        seo: patch.seo !== undefined ? mergeOverrides(current.seo, patch.seo) : current.seo,
        status: patch.status ?? current.status,
        published_at: patch.published_at === null ? now : (patch.published_at ?? current.published_at),
        updated_at: now,
        version: current.version + 1,
      };
      const optional = ["excerpt", "tags", "categories", "cover_image_url", "cover_image_alt", "canonical_url", "author"] as const;
      for (const f of optional) {
        const v = f in patch ? (patch as Record<string, unknown>)[f] : (current as unknown as Record<string, unknown>)[f];
        if (v !== null && v !== undefined) (next as unknown as Record<string, unknown>)[f] = v;
      }
      const saved = await store.save(scope, next);
      return ok(full(saved), etagHeader(saved));
    });
  });
}

// ---------------------------------------------------------------------------------------------
// DELETE /api/content/{id}

export interface DeleteArgs {
  authHeader: string | null | undefined;
  id: string;
  ifMatchHeader?: string | null;
  keys: ApiKey[];
  store: ContentStore;
}

export function handleDelete({ authHeader, id, ifMatchHeader, keys, store }: DeleteArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authedWrite(authHeader, keys);
    return withLock(key.scope, async () => {
      const current = await store.get(key.scope, id);
      if (!current) throw new InkwireError("not_found", `no entry with id "${id}"`);
      checkIfMatch(ifMatchHeader, current);
      const removed = await store.remove(key.scope, current.id);
      if (!removed) throw new InkwireError("not_found", `no entry with id "${id}"`);
      return ok({ id: current.id, deleted: true });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// POST /api/media

export interface MediaArgs {
  authHeader: string | null | undefined;
  contentType: string | null | undefined;
  rawBody: string | Buffer | Uint8Array;
  keys: ApiKey[];
  config: InkwireConfig;
  store: ContentStore;
}

export function handleMedia({ authHeader, contentType, rawBody, keys, config, store }: MediaArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authedWrite(authHeader, keys);
    if (!store.saveMedia) throw new InkwireError("not_found", "this receiver does not accept media uploads");
    const limit = limitsOf(config).media_bytes;
    const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
    const type = (contentType ?? "").toLowerCase();
    const tooLarge = () => new InkwireError("too_large", `the file is over the limit (media_bytes ${limit})`);

    let bytes: Buffer;
    let declaredType: string | undefined;
    let filename: string | undefined;
    let alt: string | undefined;

    if (type.startsWith("multipart/form-data")) {
      if (body.length > limit + 65_536) throw tooLarge();
      const parts = parseMultipart(body, contentType!);
      const file = parts.find((p) => p.name === "file" && p.filename !== undefined);
      if (!file) throw new InkwireError("invalid_payload", 'the multipart body needs a "file" part');
      bytes = file.data;
      declaredType = file.contentType;
      filename = file.filename;
      const altPart = parts.find((p) => p.name === "alt" && p.filename === undefined);
      if (altPart) alt = altPart.data.toString("utf8");
    } else if (type.startsWith("application/json")) {
      const input = validate(MediaUrlInput, parseJson(body));
      if (!config.fetchMedia) {
        throw new InkwireError("invalid_payload", "fetching media from a URL is not enabled on this receiver; upload the file instead");
      }
      const got = await config.fetchMedia(input.url);
      bytes = Buffer.from(got.bytes);
      declaredType = got.contentType;
      filename = got.filename ?? decodeURIComponent(new URL(input.url).pathname.split("/").pop() ?? "");
      alt = input.alt;
    } else {
      throw new InkwireError("invalid_payload", "send multipart/form-data with a file part, or JSON {url, alt}");
    }

    if (bytes.length > limit) throw tooLarge();
    if (bytes.length === 0) throw new InkwireError("invalid_payload", "the file is empty");
    if (alt !== undefined && alt.length > 1024) throw new InkwireError("invalid_payload", "alt is over 1024 characters");
    const imageType = assertImage(bytes, declaredType, filename);
    const saved = await store.saveMedia(key.scope, {
      bytes,
      contentType: imageType,
      filename: safeFilename(filename, imageType),
      ...(alt !== undefined && alt !== "" ? { alt } : {}),
    });
    return ok(mediaItem(saved));
  });
}

const mediaItem = (m: StoredMedia) => ({
  id: m.id,
  url: m.url,
  ...(m.alt !== undefined ? { alt: m.alt } : {}),
  ...(m.title !== undefined ? { title: m.title } : {}),
  mime_type: m.mime_type,
  created_at: m.created_at,
});

// ---------------------------------------------------------------------------------------------
// GET /api/media

export interface MediaListArgs {
  authHeader: string | null | undefined;
  query: URLSearchParams;
  keys: ApiKey[];
  store: ContentStore;
}

export function handleMediaList({ authHeader, query, keys, store }: MediaListArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authorize(authHeader, keys);
    if (!store.listMedia) throw new InkwireError("not_found", "this receiver does not list its media library");
    const limit = parseLimit(query, DEFAULT_PAGE, MAX_PAGE);
    const result = await store.listMedia(key.scope, {
      ...(query.get("search") ? { search: query.get("search")! } : {}),
      limit,
      ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
    });
    return ok({ items: result.items.map(mediaItem), next_cursor: result.next_cursor });
  });
}

// ---------------------------------------------------------------------------------------------
// PATCH /api/media/{id}

export interface MediaUpdateArgs {
  authHeader: string | null | undefined;
  id: string;
  rawBody: string | Buffer;
  keys: ApiKey[];
  store: ContentStore;
}

export function handleMediaUpdate({ authHeader, id, rawBody, keys, store }: MediaUpdateArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authedWrite(authHeader, keys);
    if (!store.updateMedia) throw new InkwireError("not_found", "this receiver does not edit its media library");
    if (rawBody.length > 100_000) throw new InkwireError("too_large", "the body is over the limit");
    const patch = validate(MediaPatchSchema, parseJson(rawBody));
    const saved = await store.updateMedia(key.scope, id, patch);
    if (!saved) throw new InkwireError("not_found", `no media with id "${id}"`);
    return ok(mediaItem(saved));
  });
}

// ---------------------------------------------------------------------------------------------
// GET /api/terms

export interface TermsArgs {
  authHeader: string | null | undefined;
  query: URLSearchParams;
  keys: ApiKey[];
  store: ContentStore;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const MAX_TERMS = 500;
const DEFAULT_TERMS = 100;
/** Entries read to count terms; a site past this reports counts for its newest entries. */
const TERMS_SCAN_CAP = 10_000;

export function handleTerms({ authHeader, query, keys, store }: TermsArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authorize(authHeader, keys);
    const kind = query.get("kind") || undefined;
    if (kind !== undefined && kind !== "tag" && kind !== "category") {
      throw new InkwireError("invalid_payload", 'kind must be "tag" or "category"');
    }
    const limit = parseLimit(query, DEFAULT_TERMS, MAX_TERMS);
    const search = (query.get("search") ?? "").toLowerCase();

    // name (lowercased) -> total, and how often each spelling appears.
    const seen = new Map<string, { kind: "tag" | "category"; total: number; spellings: Map<string, number> }>();
    const add = (k: "tag" | "category", names: string[] | undefined) => {
      const byLower = new Map<string, string>();
      for (const n of names ?? []) if (!byLower.has(n.toLowerCase())) byLower.set(n.toLowerCase(), n);
      for (const name of byLower.values()) {
        const id = `${k}:${name.toLowerCase()}`;
        const t = seen.get(id) ?? { kind: k, total: 0, spellings: new Map() };
        t.total++;
        t.spellings.set(name, (t.spellings.get(name) ?? 0) + 1);
        seen.set(id, t);
      }
    };
    let cursor: string | undefined;
    let scanned = 0;
    do {
      const page = await store.list(key.scope, { limit: MAX_PAGE, ...(cursor ? { cursor } : {}) });
      for (const e of page.items) {
        if (kind !== "category") add("tag", e.tags);
        if (kind !== "tag") add("category", e.categories);
      }
      scanned += page.items.length;
      cursor = page.next_cursor ?? undefined;
    } while (cursor && scanned < TERMS_SCAN_CAP);

    const items = [...seen.values()]
      .map((t) => {
        const name = [...t.spellings.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
        return { kind: t.kind, name, slug: slugify(name), count: t.total };
      })
      .filter((t) => !search || t.name.toLowerCase().includes(search))
      .sort((a, b) => b.count - a.count || cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.name, b.name))
      .slice(0, limit);
    return ok({ items });
  });
}

// ---------------------------------------------------------------------------------------------
// GET /api/inkwire

export function discoveryBody(config: InkwireConfig, store?: ContentStore) {
  const derived = [
    "upsert",
    "list",
    "get",
    "update",
    "delete",
    "terms",
    ...(config.schedule ? ["schedule"] : []),
    ...(store?.saveMedia ? ["media"] : []),
    ...(store?.saveMedia && config.fetchMedia ? ["media_url"] : []),
    ...(store?.listMedia ? ["media_list"] : []),
    ...(store?.updateMedia ? ["media_update"] : []),
  ];
  const features = [...new Set(["upsert", ...(config.features ?? derived)])];
  return {
    inkwire: 1,
    site: config.site,
    features,
    kinds: config.kinds,
    limits: limitsOf(config),
  };
}

export interface DiscoveryArgs {
  authHeader: string | null | undefined;
  keys: ApiKey[];
  config: InkwireConfig;
  /** Lets discovery advertise the media features the store really has. */
  store?: ContentStore;
}

/** The authenticated discovery response. Adapters may also call `discoveryBody` directly. */
export function handleDiscovery({ authHeader, keys, config, store }: DiscoveryArgs): Promise<HandlerResult> {
  return guarded(async () => {
    authorize(authHeader, keys);
    return ok(discoveryBody(config, store));
  });
}
