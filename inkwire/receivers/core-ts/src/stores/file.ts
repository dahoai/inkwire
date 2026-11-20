import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { InkwireError } from "../errors.js";
import { KIND_RE, RESERVED_KINDS, SLUG_FILE_RE, idFor, parseEntryFile, parseId, serializeEntry } from "../files.js";
import { matches, pageOf, recencyKey } from "../list.js";
import type { ContentStore, ListFilter, ListResult, MediaInput, SaveEntry, StoredContent, StoredMedia } from "../store.js";

export interface FileStoreOptions {
  /** The content directory: `<root>/<kind>/<slug>.md`. */
  root: string;
  /** Public base of `<root>/media`, no trailing slash. Media url = `${mediaUrlBase}/<filename>`. */
  mediaUrlBase: string;
  /** Public address of an entry. Default: the origin of `mediaUrlBase` + `/<kind>/<slug>`. */
  urlFor?: (e: { kind: string; slug: string }) => string;
}

/**
 * Entries as markdown files with YAML frontmatter, so a repo of existing `.md` files is readable
 * on day one (missing frontmatter defaults: title from the first `# ` heading, external_id null,
 * status published, kind from the folder, dates from the file). One FileStore is one site: the
 * `key` argument is stamped on what it returns, not used to partition directories. Files whose
 * name is not a slug (`^[a-z0-9-]+$`) or whose frontmatter is not valid YAML are not addressable
 * and stay hidden rather than guessed at.
 */
export class FileStore implements ContentStore {
  private root: string;
  private mediaBase: string;
  private urlFor: (e: { kind: string; slug: string }) => string;
  private cache = new Map<string, { sig: string; entry: Omit<StoredContent, "key"> | null }>();

  constructor(opts: FileStoreOptions) {
    this.root = path.resolve(opts.root);
    this.mediaBase = opts.mediaUrlBase.replace(/\/+$/, "");
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

  private fileFor(kind: string, slug: string): string {
    if (!KIND_RE.test(kind) || RESERVED_KINDS.has(kind)) {
      throw new InkwireError("invalid_payload", `kind "${kind}" cannot be stored as a folder`);
    }
    if (!SLUG_FILE_RE.test(slug)) throw new InkwireError("invalid_payload", `slug "${slug}" is not a valid filename`);
    const full = path.join(this.root, kind, `${slug}.md`);
    if (path.relative(this.root, full).startsWith("..")) throw new InkwireError("invalid_payload", "path escapes the content directory");
    return full;
  }

  private async read(kind: string, slug: string): Promise<Omit<StoredContent, "key"> | null> {
    const file = this.fileFor(kind, slug);
    let st;
    try {
      st = await stat(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
      throw e;
    }
    if (!st.isFile()) return null;
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = this.cache.get(file);
    if (hit?.sig === sig) return hit.entry;
    const raw = await readFile(file, "utf8");
    const draft = parseEntryFile(raw, { kind, slug, mtimeIso: st.mtime.toISOString() });
    const entry = draft
      ? {
          ...draft,
          id: idFor(kind, slug),
          url: this.urlFor({ kind, slug }),
          etag: `${st.mtimeMs.toString(36)}-${st.size.toString(36)}-${createHash("sha1").update(raw).digest("hex").slice(0, 10)}`,
        }
      : null;
    this.cache.set(file, { sig, entry });
    return entry;
  }

  async get(key: string, id: string) {
    const p = parseId(id);
    if (!p) return null;
    const e = await this.read(p.kind, p.slug);
    return e ? { ...e, key } : null;
  }

  async list(key: string, filter: ListFilter): Promise<ListResult> {
    let kinds: string[];
    if (filter.kind) {
      kinds = KIND_RE.test(filter.kind) && !RESERVED_KINDS.has(filter.kind) ? [filter.kind] : [];
    } else {
      const dirs = await readdir(this.root, { withFileTypes: true }).catch(() => []);
      kinds = dirs.filter((d) => d.isDirectory() && KIND_RE.test(d.name) && !RESERVED_KINDS.has(d.name)).map((d) => d.name);
    }
    const found: StoredContent[] = [];
    for (const kind of kinds) {
      let slugs: string[];
      if (filter.slug) {
        slugs = SLUG_FILE_RE.test(filter.slug) ? [filter.slug] : [];
      } else {
        const files = await readdir(path.join(this.root, kind)).catch(() => [] as string[]);
        slugs = files.filter((f) => f.endsWith(".md") && SLUG_FILE_RE.test(f.slice(0, -3))).map((f) => f.slice(0, -3));
      }
      for (const slug of slugs) {
        const e = await this.read(kind, slug);
        if (e) {
          const withKey = { ...e, key };
          if (matches(withKey, filter)) found.push(withKey);
        }
      }
    }
    found.sort((a, b) => (recencyKey(a) < recencyKey(b) ? -1 : 1));
    return pageOf(found, recencyKey, filter.limit, filter.cursor);
  }

  async save(key: string, entry: SaveEntry): Promise<StoredContent> {
    const file = this.fileFor(entry.kind, entry.slug);
    const newId = idFor(entry.kind, entry.slug);
    // Never overwrite a file that is not this entry (including one whose frontmatter we cannot read).
    if (entry.id !== newId) {
      const taken = await stat(file).then(() => true, () => false);
      if (taken) throw new InkwireError("conflict", `${entry.kind}/${entry.slug}.md already exists`);
    }
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.${entry.slug}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, serializeEntry(entry), { encoding: "utf8", mode: 0o644 });
      await rename(tmp, file);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    if (entry.id && entry.id !== newId) {
      const old = parseId(entry.id);
      if (old) await unlink(this.fileFor(old.kind, old.slug)).catch(() => {});
    }
    this.cache.delete(file);
    const saved = await this.read(entry.kind, entry.slug);
    if (!saved) throw new InkwireError("internal", "the entry was written but could not be read back");
    return { ...saved, key };
  }

  async remove(_key: string, id: string) {
    const p = parseId(id);
    if (!p) return false;
    const file = this.fileFor(p.kind, p.slug);
    try {
      await unlink(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
    this.cache.delete(file);
    return true;
  }

  async saveMedia(_key: string, m: MediaInput): Promise<StoredMedia> {
    const dir = path.join(this.root, "media");
    await mkdir(dir, { recursive: true });
    const hex = randomBytes(8).toString("hex");
    const name = `${hex}-${m.filename}`;
    const file = path.join(dir, name);
    const tmp = path.join(dir, `.${hex}.tmp`);
    try {
      await writeFile(tmp, m.bytes);
      await rename(tmp, file);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    await writeFile(`${file}.meta.json`, JSON.stringify({ alt: m.alt ?? null, content_type: m.contentType }), "utf8");
    return { id: hex, url: `${this.mediaBase}/${name}`, ...(m.alt !== undefined ? { alt: m.alt } : {}) };
  }
}
