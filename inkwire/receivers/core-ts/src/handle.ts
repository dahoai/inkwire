import { randomBytes } from "node:crypto";
import { type ApiKey, authorize, requireWrite } from "./auth.js";
import { InkwireError } from "./errors.js";
import { withLock } from "./lock.js";
import { assertImage, imageSize, parseMultipart, safeFilename } from "./media.js";
import { renderMarkdown, sizeImages, slugify } from "./render.js";
import { ContentInput, MediaPatchSchema, MediaUrlInput, PatchSchema, RestoreInput } from "./schema.js";
import { cleanOverrides, effectiveSeo, mergeOverrides } from "./seo.js";
import { pageMedia } from "./list.js";
import type { ContentStore, SaveEntry, StoredContent, StoredMedia, StoredRevision } from "./store.js";
import { seoWarnings, type Warning } from "./warnings.js";

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
  /** `revisions`: how many past versions an entry keeps (default 50), when the store keeps them. */
  limits?: { markdown_bytes?: number; media_bytes?: number; revisions?: number };
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

/** Suffixes a compressing proxy adds to an ETag it passes on (Caddy, Apache: `"abc-gzip"`). */
const ENCODING_SUFFIXES = new Set(["gzip", "br", "zstd", "deflate"]);

/** Exact match, or the ETag as a proxy rewrote it: weak (`W/`, nginx, Cloudflare) or with an encoding suffix. */
function matchesIfMatch(header: string | null | undefined, etag: string): boolean {
  if (header === null || header === undefined) return true;
  const tokens = header.split(",").map((t) => t.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1"));
  return tokens.some((t) => t === "*" || t === etag || (t.startsWith(`${etag}-`) && ENCODING_SUFFIXES.has(t.slice(etag.length + 1))));
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
    ...(e.lang !== undefined ? { lang: e.lang } : {}),
    ...(e.translation_key !== undefined ? { translation_key: e.translation_key } : {}),
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

// --- Revisions: every write that replaces an entry (update, restore, delete) first keeps the version it
// replaces, so the first edit of a page that predates Inkwire is undoable too.

const DEFAULT_KEEP_REVISIONS = 50;
const hasRevisions = (s: ContentStore) => Boolean(s.saveRevision && s.listRevisions && s.moveRevisions);
const keepOf = (config?: InkwireConfig) => Math.max(1, Math.floor(config?.limits?.revisions ?? DEFAULT_KEEP_REVISIONS));

async function keepRevision(store: ContentStore, scope: string, entry: StoredContent, by: StoredRevision["replaced_by"], config?: InkwireConfig) {
  if (!hasRevisions(store)) return;
  const { key: _key, ...was } = entry;
  const revision = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
  await store.saveRevision!(scope, entry.id, { revision, created_at: new Date().toISOString(), replaced_by: by, entry: was }, keepOf(config));
}

/** A store whose ids follow the slug or kind moved the entry: its history goes with it. */
async function followMove(store: ContentStore, scope: string, fromId: string, toId: string) {
  if (fromId === toId) return;
  if (hasRevisions(store)) await store.moveRevisions!(scope, fromId, toId);
  if (hasRedirects(store)) await store.moveRedirects!(scope, fromId, toId);
}

// --- Redirects: a write that changes an entry's address keeps the old one, leading to the entry.

const hasRedirects = (s: ContentStore) => Boolean(s.saveRedirect && s.findRedirect && s.moveRedirects);

/** After a save that replaced `before`: the history and redirects follow the id, the old address redirects. */
async function afterMove(store: ContentStore, scope: string, before: StoredContent, saved: StoredContent) {
  await followMove(store, scope, before.id, saved.id);
  if (hasRedirects(store) && (before.kind !== saved.kind || before.slug !== saved.slug)) {
    await store.saveRedirect!(scope, { kind: before.kind, slug: before.slug, id: saved.id, created_at: new Date().toISOString() });
  }
}

// --- Translations: only a store that keeps the fields takes them.

function requireTranslations(store: ContentStore, o: object) {
  if (!store.translations && ("lang" in o || "translation_key" in o)) {
    throw new InkwireError("invalid_payload", "this receiver does not store translations: unknown field lang, translation_key");
  }
}

// --- Rendering and warnings

/** Media items read per write to size images. ponytail: a full scan; a store with a url lookup would skip it. */
const SIZE_SCAN_CAP = 2_000;
/** Entries read per write to check duplicates and links. */
const WARN_SCAN_CAP = 2_000;

async function render(store: ContentStore, scope: string, markdown: string): Promise<string> {
  const html = renderMarkdown(markdown);
  if (!store.listMedia || !html.includes("<img")) return html;
  const sizes = new Map<string, { width: number; height: number }>();
  let cursor: string | undefined;
  let seen = 0;
  do {
    const page = await store.listMedia(scope, { limit: MAX_PAGE, ...(cursor ? { cursor } : {}) });
    for (const m of page.items) if (m.width && m.height) sizes.set(m.url, { width: m.width, height: m.height });
    seen += page.items.length;
    cursor = page.next_cursor ?? undefined;
  } while (cursor && seen < SIZE_SCAN_CAP);
  return sizeImages(html, sizes);
}

async function siteEntries(store: ContentStore, scope: string, exceptId?: string): Promise<StoredContent[]> {
  const all: StoredContent[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(scope, { limit: MAX_PAGE, ...(cursor ? { cursor } : {}) });
    all.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor && all.length < WARN_SCAN_CAP);
  return all.filter((e) => e.id !== exceptId);
}

/** The warnings for an entry as it will be, or none when the receiver does not advertise `warnings`. */
async function warningsFor(
  store: ContentStore,
  scope: string,
  config: InkwireConfig,
  entry: SaveEntry & { url?: string },
  others: StoredContent[],
): Promise<Warning[] | undefined> {
  if (!discoveryBody(config, store).features.includes("warnings")) return undefined;
  return seoWarnings(entry, {
    siteUrl: config.site.url,
    others,
    ...(hasRedirects(store) ? { redirects: async (kind: string, slug: string) => Boolean(await store.findRedirect!(scope, kind, slug)) } : {}),
    ...(store.pageExists ? { pageExists: (path: string) => store.pageExists!(scope, path) } : {}),
  });
}

/** Where an entry would live, from another entry of its kind (a store finalizes the real address). */
function predictUrl(kind: string, slug: string, samples: (StoredContent | undefined)[]): string | undefined {
  const s = samples.find((e) => e && e.kind === kind && e.url.includes(e.slug));
  if (!s) return undefined;
  const at = s.url.lastIndexOf(s.slug);
  return s.url.slice(0, at) + slug + s.url.slice(at + s.slug.length);
}

const isDryRun = (query?: URLSearchParams) => {
  const v = query?.get("dry_run");
  if (v === null || v === undefined || v === "false") return false;
  if (v === "true" || v === "") return true;
  throw new InkwireError("invalid_payload", 'dry_run must be "true" or "false"');
};

function requireRevisions(store: ContentStore) {
  if (!hasRevisions(store)) throw new InkwireError("not_found", "this receiver keeps no revisions");
}

const revisionSummary = (r: StoredRevision) => ({
  revision: r.revision,
  created_at: r.created_at,
  replaced_by: r.replaced_by,
  kind: r.entry.kind,
  slug: r.entry.slug,
  title: r.entry.title,
  status: r.entry.status,
});

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
  /** The request's query string: `dry_run=true` validates and answers without writing. */
  query?: URLSearchParams;
  keys: ApiKey[];
  store: ContentStore;
  config: InkwireConfig;
}

export function handleUpsert({ authHeader, rawBody, query, keys, store, config }: UpsertArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const dryRun = isDryRun(query);
    // A dry run writes nothing, so a read-only key may check a draft too.
    const key = dryRun ? authorize(authHeader, keys) : authedWrite(authHeader, keys);
    const limits = limitsOf(config);
    // JSON escapes can make a body up to ~6x its text: refuse the absurd before parsing it.
    if (rawBody.length > limits.markdown_bytes * 6 + 100_000) {
      throw new InkwireError("too_large", `the body is over the limit (markdown_bytes ${limits.markdown_bytes})`);
    }
    const raw = parseJson(rawBody);
    requireTranslations(store, raw);
    const input = validate(ContentInput, raw);
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
        html: await render(store, scope, input.markdown),
        ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.categories !== undefined ? { categories: input.categories } : {}),
        ...(input.cover_image_url !== undefined ? { cover_image_url: input.cover_image_url } : {}),
        ...(input.cover_image_alt !== undefined ? { cover_image_alt: input.cover_image_alt } : {}),
        ...(input.canonical_url !== undefined ? { canonical_url: input.canonical_url } : {}),
        seo: cleanOverrides(input.seo),
        ...(input.author !== undefined ? { author: input.author } : {}),
        ...(input.lang !== undefined ? { lang: input.lang } : {}),
        ...(input.translation_key !== undefined ? { translation_key: input.translation_key } : {}),
        status: input.status,
        published_at: input.published_at ?? existing?.published_at ?? now,
        updated_at: now,
        version: (existing?.version ?? 0) + 1,
      };
      const others = await siteEntries(store, scope, existing?.id);
      const url = existing && existing.kind === entry.kind && existing.slug === entry.slug ? existing.url : predictUrl(entry.kind, slug, [existing, ...others]);
      const warnings = await warningsFor(store, scope, config, { ...entry, ...(url ? { url } : {}) }, others);
      const extra = warnings ? { warnings } : {};
      if (dryRun) {
        return ok({ id: existing?.id ?? null, external_id: entry.external_id, ...(url ? { url } : {}), slug, kind: entry.kind, status: entry.status, created: !existing, dry_run: true, ...extra });
      }
      if (existing) await keepRevision(store, scope, existing, "update", config);
      const saved = await store.save(scope, entry);
      if (existing) await afterMove(store, scope, existing, saved);
      return ok(
        {
          id: saved.id,
          external_id: saved.external_id,
          url: saved.url,
          slug: saved.slug,
          kind: saved.kind,
          status: saved.status,
          created: !existing,
          ...extra,
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
    if (!store.translations && (query.get("lang") || query.get("translation_key"))) {
      throw new InkwireError("invalid_payload", "this receiver does not store translations: lang and translation_key are not filters here");
    }
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
      ...(query.get("lang") ? { lang: query.get("lang")! } : {}),
      ...(query.get("translation_key") ? { translation_key: query.get("translation_key")! } : {}),
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
  /** The request's query string: `dry_run=true` validates and answers without writing. */
  query?: URLSearchParams;
  ifMatchHeader?: string | null;
  keys: ApiKey[];
  store: ContentStore;
  config: InkwireConfig;
}

export function handlePatch({ authHeader, id, rawBody, query, ifMatchHeader, keys, store, config }: PatchArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const dryRun = isDryRun(query);
    const key = dryRun ? authorize(authHeader, keys) : authedWrite(authHeader, keys);
    const limits = limitsOf(config);
    if (rawBody.length > limits.markdown_bytes * 6 + 100_000) {
      throw new InkwireError("too_large", `the body is over the limit (markdown_bytes ${limits.markdown_bytes})`);
    }
    const raw = parseJson(rawBody);
    if ("external_id" in raw) throw new InkwireError("invalid_payload", "external_id cannot be changed");
    requireTranslations(store, raw);
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
        html: patch.markdown !== undefined ? await render(store, scope, patch.markdown) : current.html,
        seo: patch.seo !== undefined ? mergeOverrides(current.seo, patch.seo) : current.seo,
        status: patch.status ?? current.status,
        published_at: patch.published_at === null ? now : (patch.published_at ?? current.published_at),
        updated_at: now,
        version: current.version + 1,
      };
      const optional = ["excerpt", "tags", "categories", "cover_image_url", "cover_image_alt", "canonical_url", "author", "lang", "translation_key"] as const;
      for (const f of optional) {
        const v = f in patch ? (patch as Record<string, unknown>)[f] : (current as unknown as Record<string, unknown>)[f];
        if (v !== null && v !== undefined) (next as unknown as Record<string, unknown>)[f] = v;
      }
      const others = await siteEntries(store, scope, current.id);
      const url = next.kind === current.kind && next.slug === current.slug ? current.url : predictUrl(next.kind, next.slug, [current, ...others]);
      const warnings = await warningsFor(store, scope, config, { ...next, ...(url ? { url } : {}) }, others);
      const extra = warnings ? { warnings } : {};
      if (dryRun) {
        const preview = full({ ...next, id: current.id, url: url ?? "", etag: "" } as StoredContent);
        if (!url) delete (preview as { url?: string }).url;
        return ok({ ...preview, dry_run: true, ...extra });
      }
      await keepRevision(store, scope, current, "update", config);
      const saved = await store.save(scope, next);
      await afterMove(store, scope, current, saved);
      return ok({ ...full(saved), ...extra }, etagHeader(saved));
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
  /** For `limits.revisions` (how many past versions to keep). */
  config?: InkwireConfig;
}

export function handleDelete({ authHeader, id, ifMatchHeader, keys, store, config }: DeleteArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authedWrite(authHeader, keys);
    return withLock(key.scope, async () => {
      const current = await store.get(key.scope, id);
      if (!current) throw new InkwireError("not_found", `no entry with id "${id}"`);
      checkIfMatch(ifMatchHeader, current);
      // Kept first: a deleted entry stays restorable from its history.
      await keepRevision(store, key.scope, current, "delete", config);
      const removed = await store.remove(key.scope, current.id);
      if (!removed) throw new InkwireError("not_found", `no entry with id "${id}"`);
      return ok({ id: current.id, deleted: true });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// GET /api/content/{id}/revisions, GET /api/content/{id}/revisions/{revision}  (feature `revisions`)

export interface RevisionsArgs {
  authHeader: string | null | undefined;
  id: string;
  keys: ApiKey[];
  store: ContentStore;
}

/** The entry's past versions, newest first. Works for a deleted entry too (that is how it is restored). */
export function handleRevisions({ authHeader, id, keys, store }: RevisionsArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authorize(authHeader, keys);
    requireRevisions(store);
    const items = await store.listRevisions!(key.scope, id);
    if (items.length === 0 && !(await store.get(key.scope, id))) throw new InkwireError("not_found", `no entry with id "${id}"`);
    return ok({ items: items.map(revisionSummary) });
  });
}

export interface RevisionArgs extends RevisionsArgs {
  revision: string;
}

/** One past version in full, in the same shape as GET /api/content/{id}. */
export function handleRevision({ authHeader, id, revision, keys, store }: RevisionArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authorize(authHeader, keys);
    requireRevisions(store);
    const r = (await store.listRevisions!(key.scope, id)).find((x) => x.revision === revision);
    if (!r) throw new InkwireError("not_found", `no revision "${revision}" of entry "${id}"`);
    return ok({ ...revisionSummary(r), entry: full({ ...r.entry, key: key.scope }) });
  });
}

// ---------------------------------------------------------------------------------------------
// POST /api/content/{id}/restore  (feature `revisions`)

export interface RestoreArgs {
  authHeader: string | null | undefined;
  id: string;
  rawBody: string | Buffer;
  ifMatchHeader?: string | null;
  keys: ApiKey[];
  store: ContentStore;
  config: InkwireConfig;
}

/**
 * Makes the entry what it was at `revision` (a new write: the version it replaces is kept, so a restore
 * is itself undoable). Restores a deleted entry. `If-Match` is checked against the current entry.
 */
export function handleRestore({ authHeader, id, rawBody, ifMatchHeader, keys, store, config }: RestoreArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authedWrite(authHeader, keys);
    requireRevisions(store);
    const { revision } = validate(RestoreInput, parseJson(rawBody));
    const scope = key.scope;

    return withLock(scope, async () => {
      const current = await store.get(scope, id);
      if (current) checkIfMatch(ifMatchHeader, current);
      const r = (await store.listRevisions!(scope, id)).find((x) => x.revision === revision);
      if (!r) throw new InkwireError("not_found", `no revision "${revision}" of entry "${id}"`);
      const was = r.entry;
      requireKind(config, was.kind);
      await assertSlugFree(store, scope, was.kind, was.slug, current?.id ?? id);
      if (was.external_id !== null) {
        const other = (await store.list(scope, { kind: was.kind, external_id: was.external_id, limit: 1 })).items[0];
        if (other && other.id !== (current?.id ?? id)) {
          throw new InkwireError("conflict", `external_id "${was.external_id}" is now used by another entry (${other.id})`);
        }
      }

      if (current) await keepRevision(store, scope, current, "restore", config);
      const { id: _id, url: _url, etag: _etag, version, updated_at: _updated, ...fields } = was;
      const selfId = current?.id ?? id;
      const next: SaveEntry = {
        ...fields,
        id: selfId,
        key: scope,
        // Rendered again: the sanitizer in force now applies, not the one at the time.
        html: await render(store, scope, was.markdown),
        updated_at: new Date().toISOString(),
        version: Math.max(current?.version ?? 0, version) + 1,
      };
      const saved = await store.save(scope, next);
      if (current) await afterMove(store, scope, current, saved);
      else await followMove(store, scope, selfId, saved.id);
      const warnings = await warningsFor(store, scope, config, saved, await siteEntries(store, scope, saved.id));
      return ok({ ...full(saved), ...(warnings ? { warnings } : {}) }, etagHeader(saved));
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
      ...(imageSize(bytes, imageType) ?? {}),
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
  ...(m.width !== undefined && m.height !== undefined ? { width: m.width, height: m.height } : {}),
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
// GET /api/redirects  (feature `redirects`)

export interface RedirectArgs {
  authHeader: string | null | undefined;
  query: URLSearchParams;
  keys: ApiKey[];
  store: ContentStore;
}

/** Where an old address (`kind`, `slug`) leads now. */
export function handleRedirect({ authHeader, query, keys, store }: RedirectArgs): Promise<HandlerResult> {
  return guarded(async () => {
    const key = authorize(authHeader, keys);
    if (!hasRedirects(store)) throw new InkwireError("not_found", "this receiver keeps no redirects");
    const kind = query.get("kind") || "post";
    const slug = query.get("slug");
    if (!slug) throw new InkwireError("invalid_payload", "slug is required");
    if (await slugOwner(store, key.scope, kind, slug)) {
      throw new InkwireError("not_found", `an entry lives at ${kind}/${slug}: nothing redirects from there`);
    }
    const r = await store.findRedirect!(key.scope, kind, slug);
    const e = r ? await store.get(key.scope, r.id) : null;
    if (!e) throw new InkwireError("not_found", `nothing redirects from ${kind}/${slug}`);
    return ok({ kind, slug, id: e.id, url: e.url, status: e.status });
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
    ...(store && hasRevisions(store) ? ["revisions"] : []),
    "warnings",
    ...(store && hasRedirects(store) ? ["redirects"] : []),
    ...(store?.translations ? ["translations"] : []),
  ];
  const features = [...new Set(["upsert", ...(config.features ?? derived)])];
  const { revisions: _keep, ...limits } = limitsOf(config);
  return {
    inkwire: 1,
    site: config.site,
    features,
    kinds: config.kinds,
    limits: features.includes("revisions") ? { ...limits, revisions: keepOf(config) } : limits,
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
