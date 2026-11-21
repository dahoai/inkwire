import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InkwireError, MemoryStore, authorize, discoveryBody, handleDiscovery, parseApiKeys } from "../src/index.js";
import { PNG, RO, SVG, b, config, env, errCode, keys, multipart, post } from "./helpers.js";

describe("every response", () => {
  test("carries Inkwire-Version: 1, success and error", async () => {
    const e = env();
    for (const r of [await e.upsert(post(1)), await e.upsert("{bad"), await e.get("nope"), await e.list(""), await e.upsert(post(2), null)]) {
      assert.equal(r.headers["Inkwire-Version"], "1");
    }
  });
  test("errors always have a non-empty message", async () => {
    const e = env();
    for (const r of [await e.upsert("{bad"), await e.get("nope"), await e.upsert(post(1), "Bearer nope")]) {
      assert.ok(typeof b(r).error.message === "string" && b(r).error.message.length > 0);
    }
  });
});

describe("auth", () => {
  test("parseApiKeys trims, skips empties, reads :ro", () => {
    assert.deepEqual(
      parseApiKeys(" dev-key , audit-key:ro ,, ,:ro").map(({ key, ro }) => ({ key, ro })),
      [
        { key: "dev-key", ro: false },
        { key: "audit-key", ro: true },
      ],
    );
    assert.deepEqual(parseApiKeys(undefined), []);
  });
  test("authorize returns the key, throws unauthorized otherwise", () => {
    assert.equal(authorize("Bearer dev-key", keys).ro, false);
    assert.equal(authorize("Bearer audit-key", keys).ro, true);
    for (const h of [undefined, "", "dev-key", "Bearer ", "Bearer wrong", "Basic dev-key"]) {
      assert.throws(() => authorize(h, keys), (e: unknown) => e instanceof InkwireError && e.code === "unauthorized");
    }
  });
  test("wrong or missing key -> 401 on every handler", async () => {
    const e = env();
    const made = b(await e.upsert(post(1)));
    for (const h of [null, "Bearer nope"]) {
      assert.equal((await e.upsert(post(2), h)).status, 401);
      assert.equal((await e.list("", h)).status, 401);
      assert.equal((await e.get(made.id, h)).status, 401);
      assert.equal((await e.patch(made.id, { title: "x" }, undefined, h)).status, 401);
      assert.equal((await e.del(made.id, undefined, h)).status, 401);
      assert.equal((await e.media("application/json", "{}", h)).status, 401);
      assert.equal((await handleDiscovery({ authHeader: h ?? undefined, keys, config })).status, 401);
    }
  });
  test("read-only key: 403 on every write, ok on every read", async () => {
    const e = env();
    const made = b(await e.upsert(post(1)));
    assert.equal((await e.upsert(post(2), RO)).status, 403);
    assert.equal(errCode(await e.upsert(post(2), RO)), "forbidden");
    assert.equal((await e.patch(made.id, { title: "x" }, undefined, RO)).status, 403);
    assert.equal((await e.del(made.id, undefined, RO)).status, 403);
    assert.equal((await e.media("application/json", JSON.stringify({ url: "https://example.test/ok.png" }), RO)).status, 403);
    assert.equal((await e.list("", RO)).status, 200);
    assert.equal((await e.get(made.id, RO)).status, 200);
    assert.equal((await handleDiscovery({ authHeader: RO, keys, config })).status, 200);
    assert.equal(b(await e.get(made.id)).title, "Post 1"); // refused writes changed nothing
  });
  test("a read-only key sees what the full key wrote (same scope)", async () => {
    const e = env();
    await e.upsert(post(1));
    assert.equal(b(await e.list("", RO)).items.length, 1);
  });
});

describe("upsert", () => {
  test("creates, then updates in place per (kind, external_id)", async () => {
    const e = env();
    const a = b(await e.upsert(post(1)));
    assert.deepEqual([a.created, a.kind, a.status, a.external_id], [true, "post", "published", "ext-1"]);
    assert.ok(a.url && a.slug && a.id);
    const again = b(await e.upsert(post(1, { title: "Edited" })));
    assert.equal(again.created, false);
    assert.equal(again.id, a.id);
    assert.equal(again.slug, a.slug);
    assert.equal(b(await e.list("")).items.length, 1);
  });
  test("same external_id in another kind is a new entry", async () => {
    const e = env();
    const a = b(await e.upsert(post(1)));
    const p = b(await e.upsert(post(1, { kind: "page" })));
    assert.equal(p.created, true);
    assert.notEqual(p.id, a.id);
    assert.equal(b(await e.list("")).items.length, 2);
  });
  test("status defaults to draft", async () => {
    assert.equal(b(await env().upsert({ external_id: "d", title: "D", markdown: "x" })).status, "draft");
  });
  test("auto slug: slugify title, dedupe with -2, never 409", async () => {
    const e = env();
    const slugs = [];
    for (const n of [1, 2, 3]) slugs.push(b(await e.upsert(post(n, { title: "Same Title" }))).slug);
    assert.deepEqual(slugs, ["same-title", "same-title-2", "same-title-3"]);
  });
  test("a title with no usable characters falls back to the slug 'entry'", async () => {
    assert.equal(b(await env().upsert(post(1, { title: "!!!" }))).slug, "entry");
  });
  test("explicit slug owned by another entry of that kind -> 409; free in another kind; owner may repost it", async () => {
    const e = env();
    await e.upsert(post(1, { slug: "taken" }));
    const r = await e.upsert(post(2, { slug: "taken" }));
    assert.equal(r.status, 409);
    assert.equal(errCode(r), "conflict");
    assert.equal((await e.upsert(post(3, { slug: "taken", kind: "page" }))).status, 200);
    assert.equal((await e.upsert(post(1, { slug: "taken", title: "Again" }))).status, 200);
  });
  test("kind the receiver does not hold -> 400", async () => {
    const r = await env().upsert(post(1, { kind: "changelog" }));
    assert.equal(r.status, 400);
    assert.equal(errCode(r), "invalid_payload");
  });
  test("invalid payloads -> 400", async () => {
    const e = env();
    const bad: [string, unknown][] = [
      ["javascript: cover", post(1, { cover_image_url: "javascript:alert(1)" })],
      ["javascript: canonical", post(1, { canonical_url: "javascript:alert(1)" })],
      ["javascript: seo image", post(1, { seo: { image_url: "javascript:alert(1)" } })],
      ["unknown field", post(1, { bogus: 1 })],
      ["unknown seo field", post(1, { seo: { keywords: [] } })],
      ["null seo", post(1, { seo: null })],
      ["empty seo title", post(1, { seo: { title: "" } })],
      ["date-only published_at", post(1, { published_at: "2026-07-22" })],
      ["bad kind pattern", post(1, { kind: "Post!" })],
      ["bad slug pattern", post(1, { slug: "Not A Slug" })],
      ["missing title", { external_id: "x", markdown: "x" }],
      ["missing external_id", { title: "x", markdown: "x" }],
      ["missing markdown", { external_id: "x", title: "x" }],
      ["not an object", "[1]"],
      ["not json", "{nope"],
    ];
    for (const [name, body] of bad) {
      const r = await e.upsert(body as never);
      assert.equal(r.status, 400, name);
      assert.equal(errCode(r), "invalid_payload", name);
    }
  });
  test("published_at with an offset is accepted and kept", async () => {
    const e = env();
    const r = b(await e.upsert(post(1, { published_at: "2026-07-22T04:00:00+02:00" })));
    assert.equal(b(await e.get(r.id)).published_at, "2026-07-22T04:00:00+02:00");
  });
  test("markdown over limits.markdown_bytes -> 413 (bytes, not characters)", async () => {
    const e = env();
    const r = await e.upsert(post(1, { markdown: "é".repeat(600) }));
    assert.equal(r.status, 413);
    assert.equal(errCode(r), "too_large");
    assert.equal((await e.upsert(post(2, { markdown: "x".repeat(1000) }))).status, 200);
  });
  test("html is sanitized before it is stored", async () => {
    const e = env();
    const r = b(await e.upsert(post(1, { markdown: "hi <script>alert(1)</script> [x](javascript:alert(1))" })));
    const stored = await e.store.get("default", r.id);
    assert.ok(!/<script|href="javascript|onerror/i.test(stored!.html), stored!.html);
  });
  test("response carries a quoted ETag", async () => {
    assert.match((await env().upsert(post(1))).headers.ETag!, /^".+"$/);
  });
});

describe("get / list", () => {
  async function seeded() {
    const e = env();
    await e.upsert(post(1, { title: "Alpha Launch", excerpt: "about rockets", tags: ["news", "ai"], markdown: "# A\nBody about ROCKETS" }));
    await e.upsert(post(2, { title: "Beta", status: "draft", tags: ["ai"], markdown: "plain" }));
    await e.upsert(post(3, { title: "About us", kind: "page", slug: "about", markdown: "who we are" }));
    return e;
  }
  test("get returns the full entry with a quoted ETag and effective seo", async () => {
    const e = env();
    const a = b(
      await e.upsert(
        post(1, {
          excerpt: "Excerpt here",
          cover_image_url: "https://img.test/c.jpg",
          seo: { title: "SEO title", noindex: true },
          author: { name: "Isaac" },
          canonical_url: "https://origin.test/p",
        }),
      ),
    );
    const r = await e.get(a.id);
    assert.equal(r.status, 200);
    assert.match(r.headers.ETag!, /^".+"$/);
    const body = b(r);
    assert.equal(body.markdown, "# Post 1\n\nbody 1");
    assert.deepEqual(body.seo, { title: "SEO title", description: "Excerpt here", image_url: "https://img.test/c.jpg", noindex: true, og_title: "SEO title", og_description: "Excerpt here" });
    assert.equal(body.external_id, "ext-1");
    assert.deepEqual(body.author, { name: "Isaac" });
    assert.equal(body.canonical_url, "https://origin.test/p");
    assert.equal(body.html, undefined);
  });
  test("effective seo defaults: title, description from excerpt then title, noindex false, no image", async () => {
    const e = env();
    const a = b(await e.upsert(post(1)));
    assert.deepEqual(b(await e.get(a.id)).seo, { title: "Post 1", description: "Post 1", noindex: false, og_title: "Post 1", og_description: "Post 1" });
  });
  test("get unknown id -> 404", async () => {
    const r = await env().get("no-such-id");
    assert.equal(r.status, 404);
    assert.equal(errCode(r), "not_found");
  });
  test("list shape: summaries, no ETag, drafts included", async () => {
    const e = await seeded();
    const r = await e.list("");
    assert.equal(r.headers.ETag, undefined);
    const body = b(r);
    assert.equal(body.items.length, 3);
    assert.equal(body.next_cursor, null);
    for (const k of ["id", "external_id", "kind", "title", "slug", "url", "status", "published_at", "updated_at"]) assert.ok(k in body.items[0], k);
    assert.equal(body.items[0].markdown, undefined);
  });
  test("filters: status, kind, tag, external_id, slug", async () => {
    const e = await seeded();
    const titles = async (qs: string) => b(await e.list(qs)).items.map((i: any) => i.title).sort();
    assert.deepEqual(await titles("status=draft"), ["Beta"]);
    assert.deepEqual(await titles("status=published"), ["About us", "Alpha Launch"]);
    assert.deepEqual(await titles("kind=page"), ["About us"]);
    assert.deepEqual(await titles("tag=ai"), ["Alpha Launch", "Beta"]);
    assert.deepEqual(await titles("tag=news"), ["Alpha Launch"]);
    assert.deepEqual(await titles("external_id=ext-2"), ["Beta"]);
    assert.deepEqual(await titles("slug=about&kind=page"), ["About us"]);
    assert.deepEqual(await titles("kind=page&tag=ai"), []);
  });
  test("search is case-insensitive over title, excerpt and markdown", async () => {
    const e = await seeded();
    const titles = async (qs: string) => b(await e.list(qs)).items.map((i: any) => i.title).sort();
    assert.deepEqual(await titles("search=ALPHA"), ["Alpha Launch"]);
    assert.deepEqual(await titles("search=Rockets"), ["Alpha Launch"]);
    assert.deepEqual(await titles("search=who%20we"), ["About us"]);
    assert.deepEqual(await titles("search=nothing-matches"), []);
  });
  test("invalid status/limit -> 400; limit clamps to 100; default 20", async () => {
    const e = env();
    assert.equal((await e.list("status=bogus")).status, 400);
    assert.equal((await e.list("limit=0")).status, 400);
    assert.equal((await e.list("limit=abc")).status, 400);
    assert.equal((await e.list("limit=100000")).status, 200);
    for (let i = 0; i < 105; i++) await e.upsert(post(i));
    assert.equal(b(await e.list("limit=100000")).items.length, 100);
    assert.equal(b(await e.list("")).items.length, 20);
  });
  test("cursor round-trips every entry exactly once", async () => {
    const e = env();
    for (let i = 0; i < 7; i++) await e.upsert(post(i));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body: any = b(await e.list(`limit=3${cursor ? `&cursor=${cursor}` : ""}`));
      seen.push(...body.items.map((i: any) => i.id));
      cursor = body.next_cursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(new Set(seen).size, 7);
  });
  test("a cursor the receiver did not issue -> 400", async () => {
    assert.equal((await env().list("cursor=garbage")).status, 400);
  });
});

describe("patch", () => {
  async function one(extra: Record<string, unknown> = {}) {
    const e = env();
    const made = b(await e.upsert(post(1, { excerpt: "ex", tags: ["a"], cover_image_url: "https://i.test/c.jpg", author: { name: "N" }, ...extra })));
    const read = await e.get(made.id);
    return { e, id: made.id as string, etag: read.headers.ETag! };
  }
  test("If-Match with the current ETag -> 200, full entry, new ETag", async () => {
    const { e, id, etag } = await one();
    const r = await e.patch(id, { title: "After" }, etag);
    assert.equal(r.status, 200);
    assert.notEqual(r.headers.ETag, etag);
    assert.equal(b(r).title, "After");
    assert.equal(b(r).markdown, "# Post 1\n\nbody 1");
  });
  test("stale If-Match -> 412 and nothing is written", async () => {
    const { e, id, etag } = await one();
    await e.patch(id, { title: "First" }, etag);
    const before = await e.get(id);
    const r = await e.patch(id, { title: "Racer", markdown: "lost" }, etag);
    assert.equal(r.status, 412);
    assert.equal(errCode(r), "stale");
    const after = await e.get(id);
    assert.deepEqual(b(after), b(before));
    assert.equal(after.headers.ETag, before.headers.ETag);
  });
  test("If-Match forms: weak prefix, list, *", async () => {
    const { e, id, etag } = await one();
    assert.equal((await e.patch(id, { title: "a" }, `W/${etag}`)).status, 200);
    const next = (await e.get(id)).headers.ETag!;
    assert.equal((await e.patch(id, { title: "b" }, `"other", ${next}`)).status, 200);
    assert.equal((await e.patch(id, { title: "c" }, "*")).status, 200);
    assert.equal((await e.patch(id, { title: "d" }, '"other"')).status, 412);
  });
  test("If-Match as a compressing proxy rewrote the ETag (Caddy, Apache, then Cloudflare)", async () => {
    const { e, id, etag } = await one();
    const bare = etag.slice(1, -1);
    assert.equal((await e.patch(id, { title: "a" }, `W/"${bare}-gzip"`)).status, 200);
    const next = (await e.get(id)).headers.ETag!.slice(1, -1);
    assert.equal((await e.patch(id, { title: "b" }, `"${next}-tar"`)).status, 412, "only encoding suffixes");
    assert.equal((await e.patch(id, { title: "b" }, `"${bare}-br"`)).status, 412, "an old ETag stays stale");
    assert.equal((await e.patch(id, { title: "b" }, `"${next}-br"`)).status, 200);
  });
  test("no If-Match is allowed", async () => {
    const { e, id } = await one();
    assert.equal((await e.patch(id, { excerpt: "new" })).status, 200);
  });
  test("every accepted write changes the ETag", async () => {
    const { e, id, etag } = await one();
    const r1 = await e.patch(id, { title: "same" });
    const r2 = await e.patch(id, { title: "same" });
    assert.equal(new Set([etag, r1.headers.ETag, r2.headers.ETag]).size, 3);
  });
  test("seo merges per key; image_url null drops one key; null clears the object", async () => {
    const { e, id } = await one({ seo: { title: "T", description: "D" } });
    await e.patch(id, { seo: { noindex: true } });
    assert.deepEqual(b(await e.get(id)).seo, { title: "T", description: "D", image_url: "https://i.test/c.jpg", noindex: true, og_title: "T", og_description: "D" });
    await e.patch(id, { seo: { title: "T2", image_url: "https://i.test/og.jpg" } });
    assert.deepEqual(b(await e.get(id)).seo, { title: "T2", description: "D", image_url: "https://i.test/og.jpg", noindex: true, og_title: "T2", og_description: "D" });
    await e.patch(id, { seo: { image_url: null } });
    assert.equal(b(await e.get(id)).seo.image_url, "https://i.test/c.jpg"); // back to the cover default
    await e.patch(id, { seo: null });
    assert.deepEqual(b(await e.get(id)).seo, { title: "Post 1", description: "ex", image_url: "https://i.test/c.jpg", noindex: false, og_title: "Post 1", og_description: "ex" });
  });
  test("null clears excerpt, tags, cover_image_url, canonical_url, author; published_at null resets to now", async () => {
    const { e, id } = await one({ canonical_url: "https://o.test/p", published_at: "2020-01-01T00:00:00Z" });
    const r = await e.patch(id, { excerpt: null, tags: null, cover_image_url: null, canonical_url: null, author: null });
    assert.equal(r.status, 200);
    const body = b(await e.get(id));
    for (const k of ["excerpt", "tags", "cover_image_url", "canonical_url", "author"]) assert.equal(body[k], undefined, k);
    const r2 = await e.patch(id, { published_at: null });
    assert.equal(r2.status, 200);
    assert.ok(Date.parse(b(r2).published_at) > Date.parse("2021-01-01"));
  });
  test("null on a field that is not nullable -> 400", async () => {
    const { e, id } = await one();
    for (const f of ["title", "markdown", "status", "kind", "slug"]) assert.equal((await e.patch(id, { [f]: null })).status, 400, f);
  });
  test("external_id -> 400; empty body -> 400; unknown field -> 400", async () => {
    const { e, id } = await one();
    assert.equal(errCode(await e.patch(id, { external_id: "sneaky" })), "invalid_payload");
    assert.equal(errCode(await e.patch(id, {})), "invalid_payload");
    assert.equal(errCode(await e.patch(id, { bogus: 1 })), "invalid_payload");
  });
  test("slug onto a taken slug -> 409; own slug fine; a new slug changes the url", async () => {
    const { e, id } = await one();
    await e.upsert(post(2, { slug: "taken" }));
    assert.equal((await e.patch(id, { slug: "taken" })).status, 409);
    const own = b(await e.get(id)).slug;
    assert.equal((await e.patch(id, { slug: own })).status, 200);
    const moved = b(await e.patch(id, { slug: "fresh" }));
    assert.equal(moved.slug, "fresh");
    assert.ok(moved.url.includes("fresh"));
  });
  test("kind change: held kind ok, unheld -> 400, slug rules apply in the target kind", async () => {
    const { e, id } = await one();
    const r = await e.patch(id, { kind: "page" });
    assert.equal(r.status, 200);
    assert.equal(b(r).kind, "page");
    assert.equal(errCode(await e.patch(id, { kind: "changelog" })), "invalid_payload");
    const p = b(await e.upsert(post(9, { kind: "post", slug: "hello" })));
    await e.upsert(post(10, { kind: "page", slug: "hello" }));
    assert.equal(b(await e.patch(p.id, { kind: "page" })).slug, "hello-2"); // not asked for: deduped
    const p2 = b(await e.upsert(post(11, { kind: "post", slug: "other" })));
    await e.upsert(post(12, { kind: "page", slug: "clash" }));
    assert.equal((await e.patch(p2.id, { kind: "page", slug: "clash" })).status, 409); // asked for: conflict
  });
  test("markdown patch re-renders html and enforces the limit", async () => {
    const { e, id } = await one();
    await e.patch(id, { markdown: "new **bold**" });
    assert.match((await e.store.get("default", id))!.html, /<strong>bold<\/strong>/);
    assert.equal((await e.patch(id, { markdown: "x".repeat(1001) })).status, 413);
  });
  test("unknown id -> 404", async () => {
    const r = await env().patch("no-such-id", { title: "x" });
    assert.equal(r.status, 404);
    assert.equal(errCode(r), "not_found");
  });
});

describe("delete", () => {
  test("removes the entry: get -> 404, gone from list, second delete 404", async () => {
    const e = env();
    const a = b(await e.upsert(post(1)));
    const r = await e.del(a.id);
    assert.equal(r.status, 200);
    assert.deepEqual(b(r), { id: a.id, deleted: true });
    assert.equal((await e.get(a.id)).status, 404);
    assert.equal(b(await e.list("")).items.length, 0);
    assert.equal((await e.del(a.id)).status, 404);
  });
  test("If-Match honoured: stale -> 412 and the entry stays", async () => {
    const e = env();
    const a = b(await e.upsert(post(1)));
    const etag = (await e.get(a.id)).headers.ETag!;
    await e.patch(a.id, { title: "moved on" });
    assert.equal((await e.del(a.id, etag)).status, 412);
    assert.equal((await e.get(a.id)).status, 200);
    assert.equal((await e.del(a.id, (await e.get(a.id)).headers.ETag)).status, 200);
  });
  test("re-posting a deleted external_id creates a fresh entry", async () => {
    const e = env();
    await e.del(b(await e.upsert(post(1))).id);
    assert.equal(b(await e.upsert(post(1))).created, true);
  });
});

describe("media", () => {
  const json = "application/json";
  test("multipart png ok, alt echoed, url present", async () => {
    const m = multipart([
      { name: "alt", value: "One pixel" },
      { name: "file", file: { filename: "px.png", contentType: "image/png", data: PNG } },
    ]);
    const r = await env().media(m.contentType, m.body);
    assert.equal(r.status, 200);
    assert.ok(b(r).id && b(r).url);
    assert.equal(b(r).alt, "One pixel");
    assert.match(b(r).url, /px\.png$/);
  });
  test("multipart without alt returns no alt", async () => {
    const m = multipart([{ name: "file", file: { filename: "px.png", contentType: "image/png", data: PNG } }]);
    assert.equal(b(await env().media(m.contentType, m.body)).alt, undefined);
  });
  test("svg refused by name, by declared type, and by content", async () => {
    const e = env();
    for (const file of [
      { filename: "x.svg", contentType: "image/png", data: PNG },
      { filename: "x.png", contentType: "image/svg+xml", data: PNG },
      { filename: "x.png", contentType: "image/png", data: SVG },
      { filename: "x.png", contentType: "image/png", data: Buffer.from("<?xml version='1.0'?><svg></svg>") },
    ]) {
      const m = multipart([{ name: "file", file }]);
      const r = await e.media(m.contentType, m.body);
      assert.equal(r.status, 400, file.filename + file.contentType);
      assert.equal(errCode(r), "invalid_payload");
    }
  });
  test("a declared type that contradicts the bytes, non-image bytes, an empty file, a non-image type -> 400", async () => {
    const e = env();
    for (const file of [
      { filename: "x.jpg", contentType: "image/jpeg", data: PNG },
      { filename: "x.png", contentType: "image/png", data: Buffer.from("not an image at all") },
      { filename: "x.png", contentType: "image/png", data: Buffer.alloc(0) },
      { filename: "x.pdf", contentType: "application/pdf", data: PNG },
    ]) {
      const m = multipart([{ name: "file", file }]);
      assert.equal((await e.media(m.contentType, m.body)).status, 400, file.filename);
    }
  });
  test("missing file part, bad boundary, other content types -> 400", async () => {
    const e = env();
    const m = multipart([{ name: "alt", value: "x" }]);
    assert.equal((await e.media(m.contentType, m.body)).status, 400);
    assert.equal((await e.media("multipart/form-data", "x")).status, 400);
    assert.equal((await e.media("multipart/form-data; boundary=zzz", "no boundary inside")).status, 400);
    assert.equal((await e.media("text/plain", "x")).status, 400);
    assert.equal((await e.media(undefined, "x")).status, 400);
  });
  test("filename cannot escape: traversal and odd characters are cleaned", async () => {
    const m = multipart([{ name: "file", file: { filename: "../../etc/pa ss<wd>.png", contentType: "image/png", data: PNG } }]);
    const r = await env().media(m.contentType, m.body);
    assert.equal(r.status, 200);
    assert.ok(!b(r).url.includes(".."));
    assert.match(b(r).url, /\/[0-9a-f]{16}-[A-Za-z0-9._-]+\.png$/);
  });
  test("over limits.media_bytes -> 413 for multipart and for url fetches", async () => {
    const e = env();
    const m = multipart([{ name: "file", file: { filename: "big.png", contentType: "image/png", data: Buffer.concat([PNG, Buffer.alloc(5000)]) } }]);
    assert.equal((await e.media(m.contentType, m.body)).status, 413);
    assert.equal(errCode(await e.media(json, JSON.stringify({ url: "https://example.test/big.png" }))), "too_large");
  });
  test("JSON url variant: ok, alt echoed; javascript:/non-http -> 400; content still sniffed", async () => {
    const e = env();
    const r = await e.media(json, JSON.stringify({ url: "https://example.test/ok.png", alt: "An image" }));
    assert.equal(r.status, 200);
    assert.equal(b(r).alt, "An image");
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://x/y.png", "not a url"]) {
      assert.equal((await e.media(json, JSON.stringify({ url }))).status, 400, url);
    }
    assert.equal((await e.media(json, JSON.stringify({ url: "https://example.test/lie.png" }))).status, 400);
    assert.equal((await e.media(json, JSON.stringify({ url: "https://example.test/ok.png", extra: 1 }))).status, 400);
  });
  test("a fetch failure is an internal error that does not leak the cause", async () => {
    const r = await env().media(json, JSON.stringify({ url: "https://example.test/unknown.png" }));
    assert.equal(r.status, 500);
    assert.equal(errCode(r), "internal");
    assert.ok(!/no network/.test(JSON.stringify(r.body)));
  });
  test("a store without saveMedia -> 404", async () => {
    const s = env().store;
    const bare = { get: s.get.bind(s), list: s.list.bind(s), save: s.save.bind(s), remove: s.remove.bind(s) };
    assert.equal((await env(bare).media(json, JSON.stringify({ url: "https://example.test/ok.png" }))).status, 404);
  });
});

describe("revisions", () => {
  test("an update keeps what it replaced; restore brings it back and is itself undoable", async () => {
    const e = env();
    const a = b(await e.upsert(post(1, { excerpt: "first ex", seo: { title: "Old SEO" } })));
    assert.deepEqual(b(await e.revisions(a.id)).items, [], "a fresh entry has no past versions");
    await e.patch(a.id, { title: "Broken", markdown: "oops", excerpt: null, seo: null });
    const hist = b(await e.revisions(a.id)).items;
    assert.equal(hist.length, 1);
    assert.deepEqual([hist[0].replaced_by, hist[0].title, hist[0].kind, hist[0].slug], ["update", "Post 1", "post", a.slug]);
    const one = await e.revision(a.id, hist[0].revision);
    assert.equal(one.status, 200);
    assert.equal(b(one).entry.markdown, "# Post 1\n\nbody 1");
    assert.equal(b(one).entry.seo.title, "Old SEO", "a revision shows the effective seo, like get");

    const etag = (await e.get(a.id)).headers.ETag!;
    const r = await e.restore(a.id, { revision: hist[0].revision }, etag);
    assert.equal(r.status, 200);
    assert.ok(r.headers.ETag);
    assert.deepEqual([b(r).title, b(r).markdown, b(r).excerpt, b(r).seo.title, b(r).id], ["Post 1", "# Post 1\n\nbody 1", "first ex", "Old SEO", a.id]);
    assert.notEqual(r.headers.ETag, etag, "a restore is a new write");
    const after = b(await e.revisions(a.id)).items;
    assert.deepEqual(after.map((x: any) => [x.replaced_by, x.title]), [["restore", "Broken"], ["update", "Post 1"]], "newest first");
    assert.equal(b(await e.restore(a.id, { revision: after[0].revision })).title, "Broken", "undo the undo");
  });
  test("upsert of the same external_id keeps the replaced version too", async () => {
    const e = env();
    const a = b(await e.upsert(post(1)));
    await e.upsert(post(1, { title: "Reposted" }));
    assert.deepEqual(b(await e.revisions(a.id)).items.map((x: any) => x.title), ["Post 1"]);
  });
  test("a deleted entry is listed and restored under its id", async () => {
    const e = env();
    const a = b(await e.upsert(post(1)));
    await e.del(a.id);
    const hist = b(await e.revisions(a.id)).items;
    assert.equal(hist[0].replaced_by, "delete");
    const r = await e.restore(a.id, { revision: hist[0].revision });
    assert.equal(r.status, 200);
    assert.equal(b(r).id, a.id);
    assert.equal((await e.get(a.id)).status, 200);
    assert.equal(b(await e.list("")).items.length, 1);
  });
  test("restore refuses: a stale If-Match, an unknown revision, a slug taken since, a read-only key", async () => {
    const e = env();
    const a = b(await e.upsert(post(1, { slug: "home" })));
    const etag = (await e.get(a.id)).headers.ETag!;
    await e.patch(a.id, { slug: "moved" });
    const rev = b(await e.revisions(a.id)).items[0].revision;
    assert.equal(errCode(await e.restore(a.id, { revision: rev }, etag)), "stale");
    assert.equal(errCode(await e.restore(a.id, { revision: "nope" })), "not_found");
    assert.equal(errCode(await e.restore(a.id, {})), "invalid_payload");
    assert.equal(errCode(await e.restore(a.id, { revision: rev }, undefined, RO)), "forbidden");
    await e.upsert(post(2, { slug: "home" }));
    assert.equal(errCode(await e.restore(a.id, { revision: rev })), "conflict");
    assert.equal(b(await e.get(a.id)).slug, "moved", "nothing changed");
  });
  test("unknown id -> 404; history is capped at limits.revisions; reads work with a read-only key", async () => {
    const e = env();
    assert.equal(errCode(await e.revisions("nope")), "not_found");
    const a = b(await e.upsert(post(1)));
    for (let i = 0; i < 60; i++) await e.patch(a.id, { title: `t${i}` });
    const items = b(await e.revisions(a.id, RO)).items;
    assert.equal(items.length, 50);
    assert.equal(items[0].title, "t58");
  });
  test("a store without revisions answers not_found and keeps nothing", async () => {
    const plain = Object.assign(Object.create(MemoryStore.prototype), new MemoryStore(), { saveRevision: undefined, listRevisions: undefined, moveRevisions: undefined });
    const e = env(plain);
    const a = b(await e.upsert(post(1)));
    assert.equal((await e.patch(a.id, { title: "x" })).status, 200);
    assert.equal(errCode(await e.revisions(a.id)), "not_found");
    assert.ok(!discoveryBody(config, plain).features.includes("revisions"));
  });
});

describe("discovery", () => {
  test("body: inkwire 1, site, features, kinds, limits", () => {
    const d = discoveryBody(config, new MemoryStore());
    assert.equal(d.inkwire, 1);
    assert.deepEqual(d.kinds, ["post", "page"]);
    assert.deepEqual(d.features, ["upsert", "list", "get", "update", "delete", "terms", "media", "media_url", "media_list", "media_update", "revisions", "warnings", "redirects", "translations"]);
    assert.deepEqual(d.limits, { markdown_bytes: 1000, media_bytes: 4000, revisions: 50 });
    assert.ok(!("revisions" in discoveryBody(config).limits), "no store, no revisions limit");
  });
  test("explicit features win and always include upsert; media features follow the store; schedule follows the config; default limits", () => {
    assert.deepEqual(discoveryBody({ ...config, features: ["list"] }).features, ["upsert", "list"]);
    assert.deepEqual(discoveryBody(config).features, ["upsert", "list", "get", "update", "delete", "terms", "warnings"]);
    assert.ok(discoveryBody({ ...config, schedule: true }).features.includes("schedule"));
    assert.ok(!discoveryBody(config, new MemoryStore()).features.includes("schedule"));
    assert.ok(!discoveryBody({ ...config, fetchMedia: undefined }, new MemoryStore()).features.includes("media_url"), "no fetcher, no media_url");
    const { saveMedia: _s, ...noUpload } = new MemoryStore() as unknown as Record<string, unknown>;
    assert.ok(!discoveryBody(config, Object.assign(Object.create(MemoryStore.prototype), { saveMedia: undefined, listMedia: undefined, updateMedia: undefined })).features.some((f) => f.startsWith("media")));
    void noUpload;
    assert.equal(discoveryBody({ site: config.site, kinds: ["post"] }).limits.markdown_bytes, 1_000_000);
  });
});

describe("concurrency", () => {
  test("two simultaneous creates of the same external_id make one entry", async () => {
    const e = env();
    const [a, c] = await Promise.all([e.upsert(post(1)), e.upsert(post(1))]);
    assert.deepEqual([b(a).created, b(c).created].sort(), [false, true]);
    assert.equal(b(await e.list("")).items.length, 1);
  });
  test("two simultaneous patches with the same ETag: one wins, one is 412", async () => {
    const e = env();
    const a = b(await e.upsert(post(1)));
    const etag = (await e.get(a.id)).headers.ETag!;
    const rs = await Promise.all([e.patch(a.id, { title: "A" }, etag), e.patch(a.id, { title: "B" }, etag)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 412]);
  });
  test("two simultaneous auto-slugs get different slugs", async () => {
    const e = env();
    const [a, c] = await Promise.all([e.upsert(post(1, { title: "Dup" })), e.upsert(post(2, { title: "Dup" }))]);
    assert.notEqual(b(a).slug, b(c).slug);
  });
});

describe("categories, cover alt and the extra seo fields", () => {
  test("round-trip through create, get, list and patch (null clears)", async () => {
    const e = env();
    const a = b(
      await e.upsert(
        post(1, {
          categories: ["Guides", "How-to"],
          cover_image_url: "https://i.test/c.jpg",
          cover_image_alt: "A cover",
          seo: { og_title: "OG", og_description: "OGD", json_ld: '{"@type":"FAQPage"}' },
        }),
      ),
    );
    const got = b(await e.get(a.id));
    assert.deepEqual(got.categories, ["Guides", "How-to"]);
    assert.equal(got.cover_image_alt, "A cover");
    assert.deepEqual(got.seo, { title: "Post 1", description: "Post 1", image_url: "https://i.test/c.jpg", noindex: false, og_title: "OG", og_description: "OGD", json_ld: '{"@type":"FAQPage"}' });
    assert.deepEqual(b(await e.list("category=Guides")).items.map((i: any) => i.categories), [["Guides", "How-to"]]);
    assert.equal(b(await e.list("category=nope")).items.length, 0);
    await e.patch(a.id, { categories: null, cover_image_alt: null, seo: { json_ld: null } });
    const cleared = b(await e.get(a.id));
    assert.equal(cleared.categories, undefined);
    assert.equal(cleared.cover_image_alt, undefined);
    assert.equal(cleared.seo.json_ld, undefined);
    assert.equal(cleared.seo.og_title, "OG");
  });
  test("json_ld must be one JSON object or an array of objects", async () => {
    const e = env();
    for (const bad of ["{nope", '"text"', "42", "[]", "[1]", "null", "x"]) {
      assert.equal((await e.upsert(post(1, { seo: { json_ld: bad } }))).status, 400, bad);
    }
    assert.equal((await e.upsert(post(2, { seo: { json_ld: '[{"@type":"A"},{"@type":"B"}]' } }))).status, 200);
    assert.equal((await e.upsert(post(3, { seo: { og_title: "" } }))).status, 400);
    assert.equal((await e.upsert(post(4, { categories: [""] }))).status, 400);
  });
});

describe("terms", () => {
  test("counts tags and categories, folds case, most used first, filters by kind and search", async () => {
    const e = env();
    await e.upsert(post(1, { tags: ["SEO", "ai"], categories: ["Guides"] }));
    await e.upsert(post(2, { tags: ["seo", "SEO"], categories: ["Guides", "News"], status: "draft" }));
    await e.upsert(post(3, { tags: ["SEO"] }));
    const all = b(await e.terms()).items;
    assert.deepEqual(all[0], { kind: "tag", name: "SEO", slug: "seo", count: 3 }, "the most used spelling, counted once per entry");
    assert.deepEqual(all.map((t: any) => `${t.kind}:${t.name}:${t.count}`), ["tag:SEO:3", "category:Guides:2", "tag:ai:1", "category:News:1"]);
    assert.deepEqual(b(await e.terms("kind=category")).items.map((t: any) => t.name), ["Guides", "News"]);
    assert.deepEqual(b(await e.terms("search=NEW")).items.map((t: any) => t.name), ["News"]);
    assert.equal(b(await e.terms("limit=1")).items.length, 1);
  });
  test("bad kind or limit -> 400; no key -> 401; a read-only key may read", async () => {
    const e = env();
    assert.equal((await e.terms("kind=color")).status, 400);
    assert.equal((await e.terms("limit=0")).status, 400);
    assert.equal((await e.terms("", null)).status, 401);
    assert.equal((await e.terms("", RO)).status, 200);
  });
  test("reads past one page of entries", async () => {
    const e = env();
    for (let i = 0; i < 130; i++) await e.upsert(post(i, { tags: ["bulk"] }));
    assert.equal(b(await e.terms()).items[0].count, 130);
  });
});

describe("media library", () => {
  const upload = async (e: ReturnType<typeof env>, alt: string) => {
    const mp = multipart([
      { name: "file", file: { filename: "p.png", contentType: "image/png", data: PNG } },
      { name: "alt", value: alt },
    ]);
    return b(await e.media(mp.contentType, mp.body));
  };
  test("upload reports mime_type and created_at", async () => {
    const m = await upload(env(), "A");
    assert.equal(m.mime_type, "image/png");
    assert.ok(!Number.isNaN(Date.parse(m.created_at)));
  });
  test("lists newest first, searches alt, pages with a cursor", async () => {
    const e = env();
    const a = await upload(e, "first one");
    await new Promise((r) => setTimeout(r, 5));
    const c = await upload(e, "second one");
    const all = b(await e.mediaList("limit=10")).items;
    assert.deepEqual(all.map((m: any) => m.id), [c.id, a.id]);
    assert.deepEqual(b(await e.mediaList("search=FIRST")).items.map((m: any) => m.id), [a.id]);
    const page = b(await e.mediaList("limit=1"));
    assert.equal(page.items[0].id, c.id);
    assert.deepEqual(b(await e.mediaList(`limit=1&cursor=${page.next_cursor}`)).items.map((m: any) => m.id), [a.id]);
    assert.equal((await e.mediaList("limit=0")).status, 400);
    assert.equal((await e.mediaList("cursor=!!!")).status, 400);
    assert.equal((await e.mediaList("", null)).status, 401);
    assert.equal((await e.mediaList("", RO)).status, 200);
  });
  test("patch sets, clears and refuses", async () => {
    const e = env();
    const m = await upload(e, "old");
    const set = b(await e.mediaUpdate(m.id, { alt: "new", title: "T" }));
    assert.deepEqual([set.alt, set.title], ["new", "T"]);
    const cleared = b(await e.mediaUpdate(m.id, { alt: null }));
    assert.equal(cleared.alt, undefined);
    assert.equal(cleared.title, "T");
    assert.equal((await e.mediaUpdate("nope", { alt: "x" })).status, 404);
    assert.equal((await e.mediaUpdate(m.id, {})).status, 400);
    assert.equal((await e.mediaUpdate(m.id, { url: "https://x.test/a.png" })).status, 400);
    assert.equal((await e.mediaUpdate(m.id, "{bad")).status, 400);
    assert.equal((await e.mediaUpdate(m.id, { alt: "x" }, RO)).status, 403);
  });
  test("a store without listing or editing answers 404 not_found", async () => {
    const bare = Object.assign(Object.create(MemoryStore.prototype), { listMedia: undefined, updateMedia: undefined }) as MemoryStore;
    const e = env(bare);
    assert.equal((await e.mediaList()).status, 404);
    assert.equal((await e.mediaUpdate("x", { alt: "y" })).status, 404);
  });
});
