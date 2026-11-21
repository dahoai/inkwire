import { randomBytes } from "node:crypto";
import { InkwireError } from "../errors.js";
import { KIND_RE, RESERVED_KINDS, SLUG_FILE_RE, idFor, parseEntryFile, parseId, serializeEntry, updateEntryFile } from "../files.js";
import { matches, pageMedia, pageOf, recencyKey } from "../list.js";
import { MEDIA_FILE_RE, MEDIA_ID_RE, META_SUFFIX, type MediaMeta, metaFor, parseMeta, patchMeta, serializeMeta, toMedia } from "../media-meta.js";
import type { ContentStore, ListFilter, ListResult, MediaInput, MediaListFilter, MediaListResult, SaveEntry, StoredContent, StoredMedia, StoredRedirect } from "../store.js";

export interface GitHubStoreOptions {
  owner: string;
  repo: string;
  branch: string;
  /** Folder in the repo that holds `<kind>/<slug>.md` (and `media/`). Empty string = repo root. */
  dir: string;
  /** A token with contents read/write on the repo. Never logged, never put in an error message. */
  token: string;
  /** Public base of `<dir>/media`, no trailing slash. */
  mediaUrlBase: string;
  /** Public address of an entry. Default: the origin of `mediaUrlBase` + `/<kind>/<slug>`. */
  urlFor?: (e: { kind: string; slug: string }) => string;
  /** Default https://api.github.com (GitHub Enterprise, or a local stand-in in tests). */
  apiBase?: string;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

type Draft = Omit<StoredContent, "key">;
const CACHE_MAX = 2000;
const CONCURRENCY = 8;
const EPOCH = "1970-01-01T00:00:00.000Z";
/** How long a read of `.redirects.json` is reused: a page that 404s must not cost a GitHub call each time. */
const REDIRECTS_TTL_MS = 60_000;

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/**
 * Entries as markdown files in a GitHub repo, through the contents/trees REST API (raw `fetch`).
 * One store is one site. The ETag is the file's blob sha, so it changes exactly when the content does.
 *
 * Listing is ordered by path (kind, slug), not by recency: GitHub has no cheap per-file dates. A
 * file with no dates in its frontmatter reports the epoch. Content filters (status, tag, search,
 * external_id) read file bodies; they are cached by blob sha, so a warm process makes one request
 * (the tree) and a cold one reads each candidate file once.
 */
export class GitHubStore implements ContentStore {
  readonly translations = true;
  private o: GitHubStoreOptions;
  private dir: string;
  private mediaBase: string;
  private fetchFn: typeof fetch;
  private api: string;
  private urlFor: (e: { kind: string; slug: string }) => string;
  private cache = new Map<string, Draft | null>(); // blob sha -> parsed entry
  private metaCache = new Map<string, MediaMeta>(); // blob sha of a media sidecar -> parsed
  private redirectsCache: { at: number; sha: string | null; items: StoredRedirect[] } | null = null;

  constructor(opts: GitHubStoreOptions) {
    if (!opts.token) throw new Error("GitHubStore: token is required");
    const dir = opts.dir.replace(/^\/+|\/+$/g, "");
    if (dir.split("/").some((s) => s === ".." || s === ".")) throw new Error("GitHubStore: dir must not contain . or ..");
    this.o = opts;
    this.dir = dir;
    this.mediaBase = opts.mediaUrlBase.replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.api = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.urlFor =
      opts.urlFor ??
      ((e) => {
        let origin = this.mediaBase;
        try {
          origin = new URL(this.mediaBase).origin;
        } catch {}
        return `${origin}/${e.kind}/${e.slug}`;
      });
  }

  private prefix() {
    return this.dir ? `${this.dir}/` : "";
  }

  private pathFor(kind: string, slug: string): string {
    if (!KIND_RE.test(kind) || RESERVED_KINDS.has(kind)) throw new InkwireError("invalid_payload", `kind "${kind}" cannot be stored as a folder`);
    if (!SLUG_FILE_RE.test(slug)) throw new InkwireError("invalid_payload", `slug "${slug}" is not a valid filename`);
    return `${this.prefix()}${kind}/${slug}.md`;
  }

  private async gh(method: string, endpoint: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> {
    const url = `${this.api}/repos/${encodeURIComponent(this.o.owner)}/${encodeURIComponent(this.o.repo)}${endpoint}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.o.token}`,
          Accept: accept,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "inkwire-receiver-core",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new InkwireError("internal", "could not reach GitHub");
    }
    return res;
  }

  /** Maps a failed response to an InkwireError. The token never appears in the message. */
  private async failure(res: Response, what: string): Promise<InkwireError> {
    const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
    if (rateLimited) return new InkwireError("rate_limited", "GitHub rate limit reached; retry later");
    if (res.status === 401 || res.status === 403) return new InkwireError("internal", `GitHub refused the receiver's token while ${what}`);
    if (res.status === 409 || res.status === 422) return new InkwireError("stale", `the file changed in the repository while ${what}; read it again and retry`);
    return new InkwireError("internal", `GitHub answered ${res.status} while ${what}`);
  }

  private remember(sha: string, e: Draft | null) {
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(sha, e);
  }

  private parse(raw: string, kind: string, slug: string, sha: string): Draft | null {
    const draft = parseEntryFile(raw, { kind, slug, mtimeIso: EPOCH });
    const e = draft ? { ...draft, id: idFor(kind, slug), url: this.urlFor({ kind, slug }), etag: sha } : null;
    this.remember(sha, e);
    return e;
  }

  private async fetchFile(kind: string, slug: string, knownSha?: string): Promise<Draft | null> {
    if (knownSha && this.cache.has(knownSha)) return this.cache.get(knownSha) ?? null;
    const res = await this.gh("GET", `/contents/${encodePath(this.pathFor(kind, slug))}?ref=${encodeURIComponent(this.o.branch)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await this.failure(res, "reading an entry");
    const json = (await res.json()) as { sha?: string; content?: string; encoding?: string; type?: string };
    if (json.type && json.type !== "file") return null;
    const sha = json.sha ?? "";
    if (sha && this.cache.has(sha)) return this.cache.get(sha) ?? null;
    return this.parse(await this.decode(json), kind, slug, sha);
  }

  private async decode(json: { sha?: string; content?: string; encoding?: string }): Promise<string> {
    if (json.encoding === "base64" && typeof json.content === "string" && json.content !== "") {
      return Buffer.from(json.content, "base64").toString("utf8");
    }
    // Files over 1 MB come back without content: read the blob instead.
    const blob = await this.gh("GET", `/git/blobs/${encodeURIComponent(json.sha ?? "")}`, undefined, "application/vnd.github.raw+json");
    if (!blob.ok) throw await this.failure(blob, "reading an entry");
    return blob.text();
  }

  /** A file's current text and blob sha, or null when it does not exist. */
  private async rawAt(filePath: string): Promise<{ sha: string; raw: string } | null> {
    const res = await this.gh("GET", `/contents/${encodePath(filePath)}?ref=${encodeURIComponent(this.o.branch)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await this.failure(res, "checking a file");
    const json = (await res.json()) as { sha?: string; content?: string; encoding?: string; type?: string };
    if (json.type && json.type !== "file") return null;
    return { sha: json.sha ?? "", raw: await this.decode(json) };
  }

  async get(key: string, id: string) {
    const p = parseId(id);
    if (!p) return null;
    const e = await this.fetchFile(p.kind, p.slug);
    return e ? { ...e, key } : null;
  }

  async list(key: string, filter: ListFilter): Promise<ListResult> {
    const treeRes = await this.gh("GET", `/git/trees/${encodeURIComponent(this.o.branch)}?recursive=1`);
    if (treeRes.status === 404) return { items: [], next_cursor: null };
    if (!treeRes.ok) throw await this.failure(treeRes, "listing entries");
    const tree = (await treeRes.json()) as { tree?: { path: string; type: string; sha: string }[]; truncated?: boolean };
    if (tree.truncated) throw new InkwireError("internal", "the repository is too large to list through the trees API");

    const prefix = this.prefix();
    const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([a-z][a-z0-9_-]{0,63})/([a-z0-9-]+)\\.md$`);
    const candidates: { kind: string; slug: string; sha: string; path: string }[] = [];
    for (const t of tree.tree ?? []) {
      if (t.type !== "blob") continue;
      const m = re.exec(t.path);
      if (!m || RESERVED_KINDS.has(m[1]!)) continue;
      if (filter.kind && m[1] !== filter.kind) continue;
      if (filter.slug && m[2] !== filter.slug) continue;
      candidates.push({ kind: m[1]!, slug: m[2]!, sha: t.sha, path: t.path });
    }
    // Newest first (SPEC: `updated_at` descending, ties by id), which needs every candidate read:
    // a file's date is in its frontmatter and GitHub has no cheap mtime. Reads are cached by blob
    // sha, so only files that changed since the last listing cost a request. A kind or slug
    // filter narrows the candidates before any read.
    const loaded: StoredContent[] = [];
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const chunk = candidates.slice(i, i + CONCURRENCY);
      const entries = await Promise.all(chunk.map((c) => this.fetchFile(c.kind, c.slug, c.sha)));
      for (const e of entries) {
        if (!e) continue;
        const withKey: StoredContent = { ...e, key };
        if (matches(withKey, filter)) loaded.push(withKey);
      }
    }
    loaded.sort((a, b) => (recencyKey(a) < recencyKey(b) ? -1 : 1));
    return pageOf(loaded, recencyKey, filter.limit, filter.cursor);
  }

  private async shaAt(filePath: string): Promise<string | null> {
    const res = await this.gh("GET", `/contents/${encodePath(filePath)}?ref=${encodeURIComponent(this.o.branch)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await this.failure(res, "checking a file");
    const j = (await res.json()) as { sha?: string };
    return j.sha ?? null;
  }

  async save(key: string, entry: SaveEntry): Promise<StoredContent> {
    const filePath = this.pathFor(entry.kind, entry.slug);
    const newId = idFor(entry.kind, entry.slug);
    const existing = await this.rawAt(filePath);
    if (existing && entry.id !== newId) throw new InkwireError("conflict", `${entry.kind}/${entry.slug}.md already exists`);
    // An edit of an existing file changes only what changed in it (its own frontmatter keys survive).
    const old = entry.id ? parseId(entry.id) : null;
    const previous = !old ? null : entry.id === newId ? existing : await this.rawAt(this.pathFor(old.kind, old.slug));
    const before = previous && old ? this.parse(previous.raw, old.kind, old.slug, previous.sha) : null;
    const text = (previous && before && updateEntryFile(previous.raw, before, entry)) || serializeEntry(entry);
    const action = entry.id ? "update" : "create";
    const res = await this.gh("PUT", `/contents/${encodePath(filePath)}`, {
      message: `inkwire: ${action} ${entry.kind}/${entry.slug}`,
      content: b64(text),
      branch: this.o.branch,
      ...(existing ? { sha: existing.sha } : {}),
    });
    if (!res.ok) throw await this.failure(res, "saving an entry");
    const j = (await res.json()) as { content?: { sha?: string } };
    const sha = j.content?.sha ?? "";

    if (entry.id && entry.id !== newId) {
      const old = parseId(entry.id);
      if (old) await this.deleteAt(this.pathFor(old.kind, old.slug)).catch(() => false);
    }
    const { id: _id, ...rest } = entry;
    const saved: StoredContent = { ...rest, id: newId, key, url: this.urlFor(entry), etag: sha };
    const { key: _k, ...draft } = saved;
    this.remember(sha, draft);
    return saved;
  }

  private async deleteAt(filePath: string): Promise<boolean> {
    const sha = await this.shaAt(filePath);
    if (!sha) return false;
    const res = await this.gh("DELETE", `/contents/${encodePath(filePath)}`, {
      message: `inkwire: delete ${filePath.slice(this.prefix().length)}`,
      sha,
      branch: this.o.branch,
    });
    if (res.status === 404) return false;
    if (!res.ok) throw await this.failure(res, "deleting an entry");
    return true;
  }

  async remove(_key: string, id: string) {
    const p = parseId(id);
    if (!p) return false;
    return this.deleteAt(this.pathFor(p.kind, p.slug));
  }

  private async putFile(filePath: string, content: string | Buffer, message: string, sha?: string, what = "saving media"): Promise<string> {
    const res = await this.gh("PUT", `/contents/${encodePath(filePath)}`, {
      message,
      content: b64(content),
      branch: this.o.branch,
      ...(sha ? { sha } : {}),
    });
    if (!res.ok) throw await this.failure(res, what);
    return ((await res.json()) as { content?: { sha?: string } }).content?.sha ?? "";
  }

  // Redirects: one JSON list in the repo, `<dir>/.redirects.json` (the FileStore's format). Writes
  // carry the blob sha, so two writers cannot silently drop each other's redirect (GitHub answers 409).
  // ponytail: reads are cached for REDIRECTS_TTL_MS, so another process's new redirect shows up within a minute.

  private get redirectsPath() {
    return `${this.prefix()}.redirects.json`;
  }

  private async readRedirects(fresh = false): Promise<{ sha: string | null; items: StoredRedirect[] }> {
    const c = this.redirectsCache;
    if (!fresh && c && Date.now() - c.at < REDIRECTS_TTL_MS) return c;
    const file = await this.rawAt(this.redirectsPath);
    let items: StoredRedirect[] = [];
    try {
      const parsed: unknown = file ? JSON.parse(file.raw) : [];
      if (Array.isArray(parsed)) items = parsed as StoredRedirect[];
    } catch {}
    this.redirectsCache = { at: Date.now(), sha: file?.sha ?? null, items };
    return this.redirectsCache;
  }

  private async writeRedirects(change: (items: StoredRedirect[]) => StoredRedirect[] | null, message: string) {
    const { sha, items } = await this.readRedirects(true);
    const next = change(items);
    if (!next) return;
    const newSha = await this.putFile(this.redirectsPath, JSON.stringify(next, null, 1), message, sha ?? undefined, "saving redirects");
    this.redirectsCache = { at: Date.now(), sha: newSha, items: next };
  }

  async saveRedirect(_key: string, r: StoredRedirect) {
    await this.writeRedirects((all) => [...all.filter((x) => x.kind !== r.kind || x.slug !== r.slug), r], `inkwire: redirect ${r.kind}/${r.slug}`);
  }

  async findRedirect(_key: string, kind: string, slug: string) {
    return (await this.readRedirects()).items.find((r) => r.kind === kind && r.slug === slug) ?? null;
  }

  async moveRedirects(_key: string, fromId: string, toId: string) {
    await this.writeRedirects(
      (all) => (all.some((r) => r.id === fromId) ? all.map((r) => (r.id === fromId ? { ...r, id: toId } : r)) : null),
      "inkwire: redirects follow a moved entry",
    );
  }

  async saveMedia(_key: string, m: MediaInput): Promise<StoredMedia> {
    const hex = randomBytes(8).toString("hex");
    const name = `${hex}-${m.filename}`;
    const meta = metaFor(m);
    await this.putFile(`${this.prefix()}media/${name}`, m.bytes, `inkwire: add media ${name}`);
    await this.putFile(`${this.prefix()}media/${name}${META_SUFFIX}`, serializeMeta(meta), `inkwire: describe media ${name}`);
    return toMedia(hex, `${this.mediaBase}/${name}`, meta);
  }

  /** Every uploaded image in the media folder, with the blob sha of its sidecar when it has one. */
  private async mediaFiles(): Promise<{ name: string; metaSha?: string }[]> {
    const treeRes = await this.gh("GET", `/git/trees/${encodeURIComponent(this.o.branch)}?recursive=1`);
    if (treeRes.status === 404) return [];
    if (!treeRes.ok) throw await this.failure(treeRes, "listing media");
    const tree = (await treeRes.json()) as { tree?: { path: string; type: string; sha: string }[]; truncated?: boolean };
    if (tree.truncated) throw new InkwireError("internal", "the repository is too large to list through the trees API");
    const base = `${this.prefix()}media/`;
    const shas = new Map<string, string>();
    for (const t of tree.tree ?? []) if (t.type === "blob" && t.path.startsWith(base) && !t.path.slice(base.length).includes("/")) shas.set(t.path.slice(base.length), t.sha);
    const out: { name: string; metaSha?: string }[] = [];
    for (const [name] of shas) {
      if (name.endsWith(META_SUFFIX) || !MEDIA_FILE_RE.test(name)) continue;
      const metaSha = shas.get(`${name}${META_SUFFIX}`);
      out.push({ name, ...(metaSha ? { metaSha } : {}) });
    }
    return out;
  }

  private async readMeta(name: string, metaSha: string | undefined): Promise<MediaMeta> {
    if (!metaSha) return parseMeta(null, name, EPOCH);
    const hit = this.metaCache.get(metaSha);
    if (hit) return hit;
    const blob = await this.gh("GET", `/git/blobs/${encodeURIComponent(metaSha)}`, undefined, "application/vnd.github.raw+json");
    if (!blob.ok) throw await this.failure(blob, "reading media");
    const meta = parseMeta(await blob.text(), name, EPOCH);
    if (this.metaCache.size >= CACHE_MAX) this.metaCache.delete(this.metaCache.keys().next().value as string);
    this.metaCache.set(metaSha, meta);
    return meta;
  }

  async listMedia(_key: string, filter: MediaListFilter): Promise<MediaListResult> {
    const files = await this.mediaFiles();
    const all: StoredMedia[] = [];
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const chunk = files.slice(i, i + CONCURRENCY);
      const metas = await Promise.all(chunk.map((f) => this.readMeta(f.name, f.metaSha)));
      chunk.forEach((f, j) => all.push(toMedia(MEDIA_FILE_RE.exec(f.name)![1]!, `${this.mediaBase}/${f.name}`, metas[j]!)));
    }
    return pageMedia(all, filter);
  }

  async updateMedia(_key: string, id: string, patch: { alt?: string | null; title?: string | null }): Promise<StoredMedia | null> {
    if (!MEDIA_ID_RE.test(id)) return null;
    const file = (await this.mediaFiles()).find((f) => f.name.startsWith(`${id}-`));
    if (!file) return null;
    const cur = await this.readMeta(file.name, file.metaSha);
    const meta = patchMeta(cur, patch);
    await this.putFile(`${this.prefix()}media/${file.name}${META_SUFFIX}`, serializeMeta(meta), `inkwire: describe media ${file.name}`, file.metaSha);
    return toMedia(id, `${this.mediaBase}/${file.name}`, meta);
  }
}
