import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InkwireClientError, capabilities, edits, get, isScheduled, list, listMedia, publish, remove, terms, update, updateMedia, uploadMedia,
} from "../index";

interface Seen { method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer }
type Reply = { status?: number; headers?: Record<string, string>; json?: unknown; text?: string };

let server: Server;
let base: string;
let seen: Seen[];
let replies: Reply[]; // consumed in order; the last one repeats

beforeEach(async () => {
  seen = []; replies = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
    const r = (replies.length > 1 ? replies.shift() : replies[0]) ?? { status: 200, json: {} };
    res.writeHead(r.status ?? 200, { "inkwire-version": "1", ...(r.json !== undefined ? { "content-type": "application/json" } : {}), ...r.headers });
    res.end(r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : ""));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const entry = (over: object = {}) => ({
  id: "post.hello", external_id: "e1", kind: "post", title: "Hello", slug: "hello", url: "https://site.test/post/hello",
  status: "published", published_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  markdown: "# Hello\n\nbody", seo: { title: "Hello", description: "Hello", noindex: false }, ...over,
});
const sent = (i = 0) => JSON.parse(seen[i]!.body.toString("utf8"));

describe("publish", () => {
  it("POSTs /api/content with auth + idempotency headers and returns the result (kind included)", async () => {
    replies = [{ json: { id: "post.hello", external_id: "e1", url: "u", slug: "hello", kind: "page", status: "draft", created: true } }];
    const r = await publish(`${base}/`, "k", { external_id: "e1", title: "T", markdown: "x", kind: "page" });
    expect(r).toMatchObject({ id: "post.hello", kind: "page", created: true });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/content" });
    expect(seen[0]!.headers.authorization).toBe("Bearer k");
    expect(seen[0]!.headers["idempotency-key"]).toBe("e1");
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    expect(sent()).toMatchObject({ external_id: "e1", kind: "page" });
  });
  it("sends categories, cover_image_alt and the new SEO overrides unchanged", async () => {
    replies = [{ json: { id: "p", external_id: "e1", url: "u", slug: "s", kind: "post", status: "draft", created: true } }];
    const payload = {
      external_id: "e1", title: "T", markdown: "x", categories: ["Guides", "News"], cover_image_alt: "A red bicycle",
      seo: { og_title: "Card", og_description: "Card text", json_ld: '{"@context":"https://schema.org"}' },
    };
    await publish(base, "k", payload);
    expect(sent()).toEqual(payload);
  });
  it("surfaces an explicit slug conflict as code conflict (409), not retried", async () => {
    replies = [{ status: 409, json: { error: { code: "conflict", message: "slug taken" } } }];
    await expect(publish(base, "k", { external_id: "e", title: "T", markdown: "x", slug: "s" }))
      .rejects.toMatchObject({ code: "conflict", httpStatus: 409, message: "slug taken" });
    expect(seen).toHaveLength(1);
  });
});

describe("capabilities", () => {
  it("reads GET /api/inkwire", async () => {
    replies = [{ json: { inkwire: 1, site: { name: "A", url: "https://a.test" }, features: ["upsert", "list", "get"], kinds: ["post", "page"], limits: { markdown_bytes: 100 } } }];
    const c = await capabilities(base, "k");
    expect(c).toMatchObject({ features: ["upsert", "list", "get"], kinds: ["post", "page"], limits: { markdown_bytes: 100 } });
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/inkwire" });
    expect(seen[0]!.headers.authorization).toBe("Bearer k");
  });
  it("falls back to upsert-only on 404", async () => {
    replies = [{ status: 404, json: { error: { code: "not_found", message: "no" } } }];
    expect(await capabilities(base, "k")).toEqual({ features: ["upsert"], kinds: ["post"], limits: {} });
    expect(seen).toHaveLength(1);
  });
  it("limits are optional: absent reads as no limits, everything else is passed through", async () => {
    replies = [{ json: { inkwire: 1, features: ["upsert", "media"], kinds: ["post"] } }];
    expect(await capabilities(base, "k")).toEqual({ inkwire: 1, features: ["upsert", "media"], kinds: ["post"], limits: {} });
  });
  it("reads site.description / site.language and the new feature names", async () => {
    const features = ["upsert", "list", "get", "update", "delete", "terms", "schedule", "media", "media_list", "media_update"];
    replies = [{ json: { inkwire: 1, site: { name: "A", url: "https://a.test", description: "A blog", language: "fr-CA" }, features, kinds: ["post"], limits: { media_bytes: 5 } } }];
    const c = await capabilities(base, "k");
    expect(c.site).toEqual({ name: "A", url: "https://a.test", description: "A blog", language: "fr-CA" });
    expect(c.features).toEqual(features);
    expect(c.features.includes("media_update")).toBe(true);
  });
  it("other failures still throw (401)", async () => {
    replies = [{ status: 401, json: { error: { code: "unauthorized", message: "bad key" } } }];
    await expect(capabilities(base, "bad")).rejects.toMatchObject({ code: "unauthorized", httpStatus: 401 });
  });
});

describe("list", () => {
  it("encodes every query field, skips undefined, and returns items + next_cursor", async () => {
    replies = [{ json: { items: [{ id: "a" }], next_cursor: "c2" } }];
    const r = await list(base, "k", {
      status: "draft", kind: "page", tag: "a b", category: "Guides & Tips", search: "x&y=z", external_id: "e/1", slug: "s", limit: 5, cursor: "abc+/=",
    });
    expect(r).toEqual({ items: [{ id: "a" }], next_cursor: "c2" });
    const u = new URL(seen[0]!.url, "http://x");
    expect(u.pathname).toBe("/api/content");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      status: "draft", kind: "page", tag: "a b", category: "Guides & Tips", search: "x&y=z", external_id: "e/1", slug: "s", limit: "5", cursor: "abc+/=",
    });
  });
  it("sends no query string for an empty query, and drops undefined/empty values", async () => {
    replies = [{ json: { items: [], next_cursor: null } }];
    await list(base, "k");
    await list(base, "k", { status: undefined, search: "" });
    expect(seen.map((s) => s.url)).toEqual(["/api/content", "/api/content"]);
  });
  it("filters by category and returns categories in the summaries", async () => {
    replies = [{ json: { items: [{ id: "a", categories: ["Guides"] }], next_cursor: null } }];
    const r = await list(base, "k", { category: "Guides" });
    expect(seen[0]!.url).toBe("/api/content?category=Guides");
    expect(r.items[0]!.categories).toEqual(["Guides"]);
  });
  it("pages forward with the cursor", async () => {
    replies = [{ json: { items: [{ id: "a" }], next_cursor: "n1" } }, { json: { items: [{ id: "b" }], next_cursor: null } }];
    const p1 = await list(base, "k", { limit: 1 });
    const p2 = await list(base, "k", { limit: 1, cursor: p1.next_cursor! });
    expect([p1.items[0]!.id, p2.items[0]!.id, p2.next_cursor]).toEqual(["a", "b", null]);
    expect(seen[1]!.url).toBe("/api/content?limit=1&cursor=n1");
  });
});

describe("get", () => {
  it("returns the content and the ETag header as sent", async () => {
    replies = [{ headers: { etag: '"abc-1"' }, json: entry() }];
    const r = await get(base, "k", "post.hello");
    expect(r.etag).toBe('"abc-1"');
    expect(r.content).toMatchObject({ id: "post.hello", markdown: "# Hello\n\nbody", seo: { noindex: false } });
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/content/post.hello" });
  });
  it("returns cover_image_alt and the effective og_title / og_description / json_ld", async () => {
    const seo = { title: "Hello", description: "Hello", noindex: false, og_title: "Card", og_description: "Card text", json_ld: '{"@type":"FAQPage"}' };
    replies = [{ json: entry({ categories: ["Guides"], cover_image_alt: "A red bicycle", seo }) }];
    const { content } = await get(base, "k", "post.hello");
    expect(content.categories).toEqual(["Guides"]);
    expect(content.cover_image_alt).toBe("A red bicycle");
    expect(content.seo).toEqual(seo);
  });
  it("url-encodes the id", async () => {
    replies = [{ json: entry() }];
    await get(base, "k", "a/b c?d");
    expect(seen[0]!.url).toBe("/api/content/a%2Fb%20c%3Fd");
  });
  it("etag is null when the receiver sends none; 404 is typed not_found", async () => {
    replies = [{ json: entry() }];
    expect((await get(base, "k", "x")).etag).toBeNull();
    replies = [{ status: 404, json: { error: { code: "not_found", message: "no entry" } } }];
    await expect(get(base, "k", "x")).rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
  });
});

describe("update", () => {
  it("PATCHes the subset (nulls kept) with If-Match and returns content + new etag", async () => {
    replies = [{ headers: { etag: '"abc-2"' }, json: entry({ title: "After" }) }];
    const r = await update(base, "k", "post.hello", { title: "After", excerpt: null, seo: { image_url: null, noindex: true } }, { ifMatch: '"abc-1"' });
    expect(r.etag).toBe('"abc-2"');
    expect(r.content.title).toBe("After");
    expect(seen[0]).toMatchObject({ method: "PATCH", url: "/api/content/post.hello" });
    expect(seen[0]!.headers["if-match"]).toBe('"abc-1"');
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    expect(sent()).toEqual({ title: "After", excerpt: null, seo: { image_url: null, noindex: true } });
  });
  it("PATCHes the new fields, keeping nulls (categories, cover_image_alt, seo.json_ld)", async () => {
    replies = [{ json: entry() }];
    const patch = {
      categories: ["Guides"], cover_image_alt: null,
      seo: { og_title: "Card", og_description: "Card text", json_ld: null },
    };
    await update(base, "k", "post.hello", patch);
    expect(sent()).toEqual(patch);
    await update(base, "k", "post.hello", { categories: null, cover_image_alt: "Alt", seo: { json_ld: '{"@type":"FAQPage"}' } });
    expect(sent(1)).toEqual({ categories: null, cover_image_alt: "Alt", seo: { json_ld: '{"@type":"FAQPage"}' } });
  });
  it("sends no If-Match when none is given", async () => {
    replies = [{ json: entry() }];
    await update(base, "k", "x", { excerpt: "e" });
    expect(seen[0]!.headers["if-match"]).toBeUndefined();
  });
  it("a 412 surfaces as InkwireClientError code stale and is not retried", async () => {
    replies = [{ status: 412, json: { error: { code: "stale", message: "changed since you read it" } } }];
    const err = await update(base, "k", "x", { title: "T" }, { ifMatch: '"old"' }).catch((e) => e);
    expect(err).toBeInstanceOf(InkwireClientError);
    expect(err).toMatchObject({ code: "stale", httpStatus: 412 });
    expect(seen).toHaveLength(1);
  });
  it("a 412 without a body still maps to stale", async () => {
    replies = [{ status: 412, text: "" }];
    await expect(update(base, "k", "x", { title: "T" })).rejects.toMatchObject({ code: "stale", httpStatus: 412 });
  });
  it("400 and 403 are typed and not retried", async () => {
    replies = [{ status: 403, json: { error: { code: "forbidden", message: "read-only key" } } }];
    await expect(update(base, "k", "x", { title: "T" })).rejects.toMatchObject({ code: "forbidden" });
    replies = [{ status: 400, json: { error: { code: "invalid_payload", message: "bad" } } }];
    await expect(update(base, "k", "x", { title: "T" })).rejects.toMatchObject({ code: "invalid_payload" });
    expect(seen).toHaveLength(2);
  });
  it("the get -> edits -> update flow", async () => {
    replies = [{ headers: { etag: '"v1"' }, json: entry() }, { headers: { etag: '"v2"' }, json: entry({ markdown: "# Hello\n\nbody!" }) }];
    const { content, etag } = await get(base, "k", "post.hello");
    const md = edits(content.markdown, [{ find: "body", replace: "body!" }]);
    const r = await update(base, "k", "post.hello", { markdown: md }, { ifMatch: etag! });
    expect(r.etag).toBe('"v2"');
    expect(seen[1]!.headers["if-match"]).toBe('"v1"');
    expect(sent(1)).toEqual({ markdown: "# Hello\n\nbody!" });
  });
});

describe("remove", () => {
  it("DELETEs with If-Match and returns the result", async () => {
    replies = [{ json: { id: "post.hello", deleted: true } }];
    expect(await remove(base, "k", "post.hello", { ifMatch: '"v1"' })).toEqual({ id: "post.hello", deleted: true });
    expect(seen[0]).toMatchObject({ method: "DELETE", url: "/api/content/post.hello" });
    expect(seen[0]!.headers["if-match"]).toBe('"v1"');
    expect(seen[0]!.body.length).toBe(0);
  });
  it("no If-Match by default; 404 typed; stale typed", async () => {
    replies = [{ json: { id: "x", deleted: true } }];
    await remove(base, "k", "x");
    expect(seen[0]!.headers["if-match"]).toBeUndefined();
    replies = [{ status: 404, json: { error: { code: "not_found", message: "gone" } } }];
    await expect(remove(base, "k", "x")).rejects.toMatchObject({ code: "not_found" });
    replies = [{ status: 412, json: { error: { code: "stale", message: "changed" } } }];
    await expect(remove(base, "k", "x", { ifMatch: '"old"' })).rejects.toMatchObject({ code: "stale" });
  });
});

describe("terms", () => {
  it("GETs /api/terms with an encoded query and returns the items", async () => {
    const items = [{ kind: "tag", name: "SEO", slug: "seo", count: 12 }, { kind: "category", name: "Guides & Tips", slug: "guides-tips", count: 3 }];
    replies = [{ json: { items } }];
    const r = await terms(base, "k", { kind: "tag", search: "s&e o", limit: 50 });
    expect(r).toEqual({ items });
    expect(seen[0]).toMatchObject({ method: "GET" });
    expect(seen[0]!.headers.authorization).toBe("Bearer k");
    const u = new URL(seen[0]!.url, "http://x");
    expect(u.pathname).toBe("/api/terms");
    expect(Object.fromEntries(u.searchParams)).toEqual({ kind: "tag", search: "s&e o", limit: "50" });
  });
  it("sends no query string without a query, and drops undefined/empty values", async () => {
    replies = [{ json: { items: [] } }];
    await terms(base, "k");
    await terms(base, "k", { kind: undefined, search: "" });
    await terms(base, "k", { kind: "category" });
    expect(seen.map((s) => s.url)).toEqual(["/api/terms", "/api/terms", "/api/terms?kind=category"]);
  });
  it("maps errors: 400 bad kind, 401, 403 not retried; 503 retried", async () => {
    for (const [status, code] of [[400, "invalid_payload"], [401, "unauthorized"], [403, "forbidden"]] as const) {
      seen.length = 0;
      replies = [{ status, json: { error: { code, message: "no" } } }];
      await expect(terms(base, "k", {}, { retries: 3 })).rejects.toMatchObject({ code, httpStatus: status });
      expect(seen).toHaveLength(1);
    }
    seen.length = 0;
    replies = [{ status: 503, json: {} }, { json: { items: [] } }];
    expect(await terms(base, "k", {}, { retries: 2 })).toEqual({ items: [] });
    expect(seen).toHaveLength(2);
  });
});

describe("listMedia", () => {
  const item = { id: "m1", url: "https://site.test/u/a.png", alt: "A", title: "T", mime_type: "image/png", created_at: "2026-01-01T00:00:00.000Z" };
  it("GETs /api/media with an encoded query and returns items + next_cursor", async () => {
    replies = [{ json: { items: [item], next_cursor: "c2" } }];
    const r = await listMedia(base, "k", { search: "red bike&x", limit: 10, cursor: "abc+/=" });
    expect(r).toEqual({ items: [item], next_cursor: "c2" });
    expect(seen[0]).toMatchObject({ method: "GET" });
    expect(seen[0]!.headers.authorization).toBe("Bearer k");
    const u = new URL(seen[0]!.url, "http://x");
    expect(u.pathname).toBe("/api/media");
    expect(Object.fromEntries(u.searchParams)).toEqual({ search: "red bike&x", limit: "10", cursor: "abc+/=" });
  });
  it("no query string by default; pages forward with the cursor", async () => {
    replies = [{ json: { items: [item], next_cursor: "n1" } }, { json: { items: [], next_cursor: null } }];
    const p1 = await listMedia(base, "k");
    const p2 = await listMedia(base, "k", { limit: 1, cursor: p1.next_cursor! });
    expect(p2.next_cursor).toBeNull();
    expect(seen.map((s) => s.url)).toEqual(["/api/media", "/api/media?limit=1&cursor=n1"]);
  });
  it("maps errors: 400 bad limit/cursor, 403, 404 not retried", async () => {
    for (const [status, code] of [[400, "invalid_payload"], [403, "forbidden"], [404, "not_found"]] as const) {
      seen.length = 0;
      replies = [{ status, json: { error: { code, message: "no" } } }];
      await expect(listMedia(base, "k", { limit: 0 })).rejects.toMatchObject({ code, httpStatus: status });
      expect(seen).toHaveLength(1);
    }
  });
});

describe("updateMedia", () => {
  it("PATCHes /api/media/{id} with the body (nulls kept) and returns the item", async () => {
    const item = { id: "m1", url: "u", title: "New", mime_type: "image/png", created_at: "2026-01-01T00:00:00.000Z" };
    replies = [{ json: item }];
    const r = await updateMedia(base, "k", "m1", { alt: null, title: "New" });
    expect(r).toEqual(item);
    expect(seen[0]).toMatchObject({ method: "PATCH", url: "/api/media/m1" });
    expect(seen[0]!.headers.authorization).toBe("Bearer k");
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    expect(sent()).toEqual({ alt: null, title: "New" });
  });
  it("url-encodes the id", async () => {
    replies = [{ json: { id: "x", url: "u", mime_type: "image/png", created_at: "t" } }];
    await updateMedia(base, "k", "a/b c?d", { alt: "x" });
    expect(seen[0]!.url).toBe("/api/media/a%2Fb%20c%3Fd");
  });
  it("maps errors: 404 unknown id, 400 empty body, 403 read-only, not retried", async () => {
    for (const [status, code] of [[404, "not_found"], [400, "invalid_payload"], [403, "forbidden"]] as const) {
      seen.length = 0;
      replies = [{ status, json: { error: { code, message: "no" } } }];
      await expect(updateMedia(base, "k", "m", {})).rejects.toMatchObject({ code, httpStatus: status });
      expect(seen).toHaveLength(1);
    }
  });
  it("retries a 500 and then succeeds", async () => {
    replies = [{ status: 500, json: {} }, { json: { id: "m", url: "u", mime_type: "image/png", created_at: "t" } }];
    expect((await updateMedia(base, "k", "m", { alt: "a" }, { retries: 2 })).id).toBe("m");
    expect(seen).toHaveLength(2);
  });
});

describe("isScheduled", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  it("is true only for a published entry dated after now", () => {
    expect(isScheduled({ status: "published", published_at: "2026-06-01T00:00:01Z" }, now)).toBe(true);
    expect(isScheduled({ status: "published", published_at: "2026-06-01T00:00:00Z" }, now)).toBe(false);
    expect(isScheduled({ status: "published", published_at: "2026-01-01T00:00:00Z" }, now)).toBe(false);
    expect(isScheduled({ status: "draft", published_at: "2027-01-01T00:00:00Z" }, now)).toBe(false);
  });
  it("defaults now to the current time and accepts a full entry", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(isScheduled({ status: "published", published_at: future })).toBe(true);
    expect(isScheduled(entry({ published_at: future }) as any)).toBe(true);
    expect(isScheduled(entry() as any)).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe("uploadMedia", () => {
  it("JSON variant: url + alt", async () => {
    replies = [{ json: { id: "m1", url: "https://site.test/m/x.png", alt: "An image" } }];
    const r = await uploadMedia(base, "k", { url: "https://img.test/x.png", alt: "An image" });
    expect(r).toEqual({ id: "m1", url: "https://site.test/m/x.png", alt: "An image" });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/media" });
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    expect(sent()).toEqual({ url: "https://img.test/x.png", alt: "An image" });
  });
  it("returns mime_type, created_at and title from the upload response", async () => {
    const item = { id: "m1", url: "u", alt: "a", title: "t", mime_type: "image/jpeg", created_at: "2026-07-22T04:00:00.000Z" };
    replies = [{ json: item }];
    const r = await uploadMedia(base, "k", { url: "https://img.test/x.jpg" });
    expect(r).toEqual(item);
    expect([r.mime_type, r.created_at, r.title]).toEqual(["image/jpeg", "2026-07-22T04:00:00.000Z", "t"]);
  });
  it("JSON variant without alt sends no alt", async () => {
    replies = [{ json: { id: "m1", url: "u" } }];
    await uploadMedia(base, "k", { url: "https://img.test/x.png" });
    expect(sent()).toEqual({ url: "https://img.test/x.png" });
  });
  it("multipart variant: file part with filename + content type, alt field, boundary header", async () => {
    replies = [{ json: { id: "m2", url: "https://site.test/m/px.png", alt: "One pixel" } }];
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
    const r = await uploadMedia(base, "k", { filename: "px.png", data, contentType: "image/png", alt: "One pixel" });
    expect(r.id).toBe("m2");
    const ct = seen[0]!.headers["content-type"]!;
    expect(ct).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0]!.headers.authorization).toBe("Bearer k");
    const body = seen[0]!.body;
    const text = body.toString("latin1");
    expect(text).toMatch(/name="file"; filename="px.png"/);
    expect(text).toMatch(/content-type: image\/png/i);
    expect(text).toMatch(/name="alt"\r\n\r\nOne pixel/);
    expect(body.includes(data)).toBe(true); // bytes intact
  });
  it("multipart without alt has no alt field; accepts a Uint8Array", async () => {
    replies = [{ json: { id: "m3", url: "u" } }];
    await uploadMedia(base, "k", { filename: "a.png", data: new Uint8Array([1, 2, 3]), contentType: "image/png" });
    expect(seen[0]!.body.toString("latin1")).not.toMatch(/name="alt"/);
  });
  it("typed errors: svg refused (400), too large (413), read-only (403)", async () => {
    for (const [status, code] of [[400, "invalid_payload"], [413, "too_large"], [403, "forbidden"]] as const) {
      replies = [{ status, json: { error: { code, message: "no" } } }];
      await expect(uploadMedia(base, "k", { url: "https://img.test/x.svg" })).rejects.toMatchObject({ code, httpStatus: status });
    }
  });
  it("retries a multipart upload on 503 (the form body is re-sent intact)", async () => {
    replies = [{ status: 503, json: {} }, { json: { id: "m4", url: "u" } }];
    const r = await uploadMedia(base, "k", { filename: "a.png", data: new Uint8Array([9, 8, 7]), contentType: "image/png" }, { retries: 2 });
    expect(r.id).toBe("m4");
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body.includes(Buffer.from([9, 8, 7]))).toBe(true);
  });
});

describe("edits", () => {
  const md = "# Title\n\nThe quick brown fox.\n\nThe lazy dog.";
  it("applies each edit once, in order, without touching the network", () => {
    expect(edits(md, [{ find: "quick brown", replace: "slow red" }, { find: "slow red fox", replace: "cat" }]))
      .toBe("# Title\n\nThe cat.\n\nThe lazy dog.");
    expect(seen).toHaveLength(0);
  });
  it("empty list is a no-op; replace may be empty or contain $ patterns literally", () => {
    expect(edits(md, [])).toBe(md);
    expect(edits("a $1 b", [{ find: "$1", replace: "$& $$" }])).toBe("a $& $$ b");
    expect(edits("keep drop keep", [{ find: " drop", replace: "" }])).toBe("keep keep");
  });
  it("no match -> edit_not_found, naming the edit", () => {
    const run = () => edits(md, [{ find: "quick", replace: "x" }, { find: "absent", replace: "y" }]);
    expect(run).toThrowError(InkwireClientError);
    try { run(); } catch (e) { expect(e).toMatchObject({ code: "edit_not_found", httpStatus: 0 }); expect((e as Error).message).toContain("edit 2"); }
  });
  it("several matches -> edit_ambiguous with the count", () => {
    try { edits(md, [{ find: "The ", replace: "A " }]); expect.unreachable(); }
    catch (e) { expect(e).toMatchObject({ code: "edit_ambiguous" }); expect((e as Error).message).toContain("2 times"); }
  });
  it("an empty find is refused; overlapping matches count non-overlapping", () => {
    expect(() => edits(md, [{ find: "", replace: "x" }])).toThrowError(/empty/);
    expect(edits("aaa", [{ find: "aa", replace: "b" }])).toBe("ba");
  });
});

describe("retries", () => {
  it("retries 429 then succeeds, on any verb", async () => {
    replies = [{ status: 429, json: { error: { code: "rate_limited", message: "slow down" } } }, { json: { items: [], next_cursor: null } }];
    await list(base, "k", {}, { retries: 2 });
    expect(seen).toHaveLength(2);
  });
  it("retries 5xx on PATCH and DELETE, gives up after `retries` with the typed error", async () => {
    replies = [{ status: 500, json: { error: { code: "internal", message: "boom" } } }];
    await expect(update(base, "k", "x", { title: "T" }, { retries: 2 })).rejects.toMatchObject({ code: "internal", httpStatus: 500 });
    expect(seen).toHaveLength(2);
    seen.length = 0;
    await expect(remove(base, "k", "x", { retries: 2 })).rejects.toMatchObject({ httpStatus: 500 });
    expect(seen).toHaveLength(2);
  });
  it("never retries 4xx other than 429 (400, 401, 403, 404, 409, 412, 413)", async () => {
    for (const status of [400, 401, 403, 404, 409, 412, 413]) {
      seen.length = 0;
      replies = [{ status, json: { error: { code: "x", message: "m" } } }];
      await expect(get(base, "k", "x", { retries: 3 })).rejects.toMatchObject({ httpStatus: status });
      expect(seen, `status ${status}`).toHaveLength(1);
    }
  });
  it("retries: 0 still makes exactly one attempt", async () => {
    replies = [{ status: 500, json: {} }];
    await expect(get(base, "k", "x", { retries: 0 })).rejects.toMatchObject({ httpStatus: 500 });
    expect(seen).toHaveLength(1);
  });
  it("a 5xx with no JSON body maps to code internal; a 200 with a non-JSON body is an internal error", async () => {
    replies = [{ status: 502, text: "<html>bad gateway</html>" }];
    await expect(get(base, "k", "x", { retries: 1 })).rejects.toMatchObject({ code: "internal", httpStatus: 502 });
    replies = [{ status: 200, text: "not json" }];
    await expect(get(base, "k", "x")).rejects.toMatchObject({ code: "internal", httpStatus: 200 });
  });
  it("opts.fetch is used by every call (and global fetch is not)", async () => {
    const urls: string[] = [];
    const custom = async (url: string, init: RequestInit) => { urls.push(`${init.method} ${url}`); return new Response(JSON.stringify({ items: [], next_cursor: null, features: ["upsert"], kinds: ["post"], limits: {}, id: "x", deleted: true, url: "u" }), { status: 200 }); };
    await publish("https://s.test", "k", { external_id: "e", title: "T", markdown: "x" }, { fetch: custom });
    await capabilities("https://s.test", "k", { fetch: custom });
    await list("https://s.test", "k", {}, { fetch: custom });
    await get("https://s.test", "k", "i", { fetch: custom });
    await update("https://s.test", "k", "i", { title: "T" }, { fetch: custom });
    await remove("https://s.test", "k", "i", { fetch: custom });
    await uploadMedia("https://s.test", "k", { url: "https://i.test/a.png" }, { fetch: custom });
    await terms("https://s.test", "k", {}, { fetch: custom });
    await listMedia("https://s.test", "k", {}, { fetch: custom });
    await updateMedia("https://s.test", "k", "m", { alt: "a" }, { fetch: custom });
    expect(urls).toEqual([
      "POST https://s.test/api/content", "GET https://s.test/api/inkwire", "GET https://s.test/api/content",
      "GET https://s.test/api/content/i", "PATCH https://s.test/api/content/i", "DELETE https://s.test/api/content/i",
      "POST https://s.test/api/media", "GET https://s.test/api/terms", "GET https://s.test/api/media",
      "PATCH https://s.test/api/media/m",
    ]);
    expect(seen).toHaveLength(0);
  });
});
