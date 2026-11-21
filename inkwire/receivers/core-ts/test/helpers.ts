import {
  type ContentStore,
  type HandlerResult,
  type InkwireConfig,
  MemoryStore,
  handleDelete,
  handleGet,
  handleList,
  handleMedia,
  handleMediaList,
  handleMediaUpdate,
  handleTerms,
  handlePatch,
  handleRestore,
  handleRevision,
  handleRevisions,
  handleUpsert,
  parseApiKeys,
} from "../src/index.js";

export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
export const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

export const keys = parseApiKeys("dev-key,audit-key:ro");
export const FULL = "Bearer dev-key";
export const RO = "Bearer audit-key";

export const config: InkwireConfig = {
  site: { name: "Test", url: "https://test.example" },
  kinds: ["post", "page"],
  limits: { markdown_bytes: 1000, media_bytes: 4000 },
  async fetchMedia(url) {
    if (url === "https://example.test/ok.png") return { bytes: PNG, contentType: "image/png" };
    if (url === "https://example.test/lie.png") return { bytes: SVG, contentType: "image/png" };
    if (url === "https://example.test/big.png") return { bytes: Buffer.concat([PNG, Buffer.alloc(5000)]), contentType: "image/png" };
    throw new Error("no network");
  },
};

export function env(store: ContentStore = new MemoryStore()) {
  const upsert = (body: unknown, auth: string | null = FULL) =>
    handleUpsert({ authHeader: auth ?? undefined, rawBody: typeof body === "string" ? body : JSON.stringify(body), keys, store, config });
  const list = (qs = "", auth: string | null = FULL) =>
    handleList({ authHeader: auth ?? undefined, query: new URLSearchParams(qs), keys, store, config });
  const get = (id: string, auth: string | null = FULL) => handleGet({ authHeader: auth ?? undefined, id, keys, store });
  const patch = (id: string, body: unknown, ifMatch?: string, auth: string | null = FULL) =>
    handlePatch({ authHeader: auth ?? undefined, id, rawBody: JSON.stringify(body), ifMatchHeader: ifMatch, keys, store, config });
  const del = (id: string, ifMatch?: string, auth: string | null = FULL) =>
    handleDelete({ authHeader: auth ?? undefined, id, ifMatchHeader: ifMatch, keys, store });
  const media = (contentType: string | undefined, rawBody: Buffer | string, auth: string | null = FULL) =>
    handleMedia({ authHeader: auth ?? undefined, contentType, rawBody, keys, config, store });
  const terms = (qs = "", auth: string | null = FULL) => handleTerms({ authHeader: auth ?? undefined, query: new URLSearchParams(qs), keys, store });
  const mediaList = (qs = "", auth: string | null = FULL) => handleMediaList({ authHeader: auth ?? undefined, query: new URLSearchParams(qs), keys, store });
  const mediaUpdate = (id: string, body: unknown, auth: string | null = FULL) =>
    handleMediaUpdate({ authHeader: auth ?? undefined, id, rawBody: typeof body === "string" ? body : JSON.stringify(body), keys, store });
  const revisions = (id: string, auth: string | null = FULL) => handleRevisions({ authHeader: auth ?? undefined, id, keys, store });
  const revision = (id: string, rev: string, auth: string | null = FULL) => handleRevision({ authHeader: auth ?? undefined, id, revision: rev, keys, store });
  const restore = (id: string, body: unknown, ifMatch?: string, auth: string | null = FULL) =>
    handleRestore({ authHeader: auth ?? undefined, id, rawBody: JSON.stringify(body), ifMatchHeader: ifMatch, keys, store, config });
  return { store, upsert, list, get, patch, del, media, terms, mediaList, mediaUpdate, revisions, revision, restore };
}

export const post = (n: number | string, extra: Record<string, unknown> = {}) => ({
  external_id: `ext-${n}`,
  title: `Post ${n}`,
  markdown: `# Post ${n}\n\nbody ${n}`,
  status: "published",
  ...extra,
});

export const b = (r: HandlerResult) => r.body as any;
export const errCode = (r: HandlerResult) => b(r).error?.code;

/** Builds a multipart/form-data body by hand. */
export function multipart(
  parts: { name: string; value?: string; file?: { filename: string; contentType: string; data: Buffer } }[],
  boundary = "----inkwiretest",
) {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (p.file) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.file.filename}"\r\nContent-Type: ${p.file.contentType}\r\n\r\n`,
        ),
        p.file.data,
        Buffer.from("\r\n"),
      );
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value ?? ""}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}
