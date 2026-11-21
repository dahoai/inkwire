import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { FileStore, MemoryStore, alternates, imageSize, resolveRedirect, sitemapEntries } from "../src/index.js";
import { PNG, RO, b, env, errCode, multipart } from "./helpers.js";

// Entries live on the configured site (https://test.example), so links to them are checkable.
const site = () => new MemoryStore({ urlFor: (e) => `https://test.example/${e.kind}/${e.slug}`, mediaUrlBase: "https://test.example/media" });
const entry = (n: number | string, extra: Record<string, unknown> = {}) => ({
  external_id: `x-${n}`,
  title: `Entry ${n}`,
  excerpt: `About entry ${n}`,
  markdown: `Intro ${n}.\n\n## Part\n\nText.`,
  status: "published",
  ...extra,
});
const upload = async (e: ReturnType<typeof env>) => {
  const m = multipart([{ name: "file", file: { filename: "dot.png", contentType: "image/png", data: PNG } }]);
  return b(await e.media(m.contentType, m.body));
};
const codes = (r: { body: unknown }) => (b(r as any).warnings ?? []).map((w: { code: string }) => w.code);

describe("warnings", () => {
  test("a clean entry has none; every write answers with the list", async () => {
    const e = env(site());
    const r = await e.upsert(entry(1));
    assert.deepEqual(b(r).warnings, []);
    assert.deepEqual(b(await e.patch(b(r).id, { excerpt: "Still clean" })).warnings, []);
  });

  test("titles and descriptions: duplicate, too long, missing; noindex pages are left alone", async () => {
    const e = env(site());
    await e.upsert(entry(1, { title: "Pricing", excerpt: "What it costs" }));
    assert.deepEqual(codes(await e.upsert(entry(2, { title: "pricing ", excerpt: "what it costs" }))).sort(), ["description_duplicate", "title_duplicate"]);
    assert.deepEqual(codes(await e.upsert(entry(3, { title: "x".repeat(70) }))), ["title_long"]);
    assert.deepEqual(codes(await e.upsert(entry(4, { excerpt: undefined }))), ["description_missing"]);
    assert.deepEqual(codes(await e.upsert(entry(5, { title: "Pricing", excerpt: undefined, seo: { noindex: true } }))), []);
    // A draft is not a duplicate of anything yet, but a draft gets its own warnings.
    await e.upsert(entry(6, { title: "Roadmap", status: "draft" }));
    assert.deepEqual(codes(await e.upsert(entry(7, { title: "Roadmap" }))), []);
    const w = b(await e.upsert(entry(8, { title: "Pricing", status: "draft" }))).warnings;
    assert.equal(w[0].code, "title_duplicate");
    assert.equal(w[0].field, "title");
    assert.match(w[0].message, /pricing/i);
  });

  test("headings, image alt text and generic link text", async () => {
    const e = env(site());
    const w = (md: string, extra = {}) => e.upsert(entry(`m-${md.length}-${Math.random()}`, { markdown: md, ...extra })).then(codes);
    assert.deepEqual(await w("# Second title\n\ntext"), ["h1_extra"]);
    assert.deepEqual(await w("## A\n\n#### D"), ["heading_skipped"]);
    assert.deepEqual(await w("### starts too deep"), ["heading_skipped"]);
    assert.deepEqual(await w("![](https://test.example/media/a.png) ![ok](https://test.example/media/b.png)"), ["image_alt_missing"]);
    assert.deepEqual(await w("text", { cover_image_url: "https://test.example/c.png" }), ["image_alt_missing"]);
    assert.deepEqual(await w("text", { cover_image_url: "https://test.example/c.png", cover_image_alt: "A cat" }), []);
    assert.deepEqual(await w("[Click here](https://elsewhere.test/) and [lire la suite](https://elsewhere.test/)"), ["anchor_generic"]);
  });

  test("links: to a missing entry, to a draft, to an old address; other pages of the site are not judged", async () => {
    const e = env(site());
    await e.upsert(entry(1, { slug: "live" }));
    await e.upsert(entry(2, { slug: "unpublished", status: "draft" }));
    const moved = b(await e.upsert(entry(3, { slug: "old-name" })));
    await e.patch(moved.id, { slug: "new-name" });
    const md = [
      "[live](/post/live) [gone](https://test.example/post/no-such-post) [draft](/post/unpublished)",
      "[old](/post/old-name) [pricing](/pricing) [out](https://elsewhere.test/post/x)",
    ].join("\n\n");
    const w = b(await e.upsert(entry(4, { markdown: md }))).warnings;
    assert.deepEqual(w.map((x: { code: string }) => x.code), ["link_broken", "link_redirect"]);
    assert.match(w[0].message, /\/post\/no-such-post/);
    assert.match(w[0].message, /\/post\/unpublished \(a draft\)/);
    assert.match(w[1].message, /\/post\/old-name/);
  });

  test("links to pages the site serves outside the store are fine when the store says so (pageExists)", async () => {
    const store = site();
    const e = env(Object.assign(store, { pageExists: async (_key: string, p: string) => p === "/post/hand-written" }));
    await e.upsert(entry(1, { slug: "live" }));
    const md = "[file](/post/hand-written) [gone](/post/no-such-post)";
    const w = b(await e.upsert(entry(2, { markdown: md }))).warnings;
    assert.deepEqual(w.map((x: { code: string }) => x.code), ["link_broken"]);
    assert.doesNotMatch(w[0].message, /hand-written/);
  });

  test("dry run: same validation and answer, nothing written, read-only keys allowed", async () => {
    const e = env(site());
    const created = await e.upsert(entry(1, { title: "Same" }), RO, "dry_run=true");
    assert.equal(created.status, 200);
    assert.equal(b(created).dry_run, true);
    assert.equal(b(created).id, null);
    assert.equal(b(created).created, true);
    assert.equal(created.headers.ETag, undefined);
    assert.equal(b(await e.list("")).items.length, 0, "nothing written");
    assert.equal(errCode(await e.upsert(entry(1), RO)), "forbidden", "a real write still needs a full key");

    const a = b(await e.upsert(entry(1, { title: "Same" })));
    await e.upsert(entry(2, { title: "Other" }));
    const p = await e.patch(a.id, { title: "Other", slug: "renamed" }, undefined, undefined, "dry_run=true");
    assert.equal(b(p).dry_run, true);
    assert.equal(b(p).title, "Other");
    assert.equal(b(p).url, "https://test.example/post/renamed", "the address it would get");
    assert.deepEqual(codes(p), ["title_duplicate"]);
    assert.equal(b(await e.get(a.id)).title, "Same", "nothing written");
    assert.equal(b(await e.revisions(a.id)).items.length, 0, "no revision kept");
    assert.equal(errCode(await e.patch(a.id, { slug: "other" }, undefined, undefined, "dry_run=true")), "conflict", "slug rules apply");
    assert.equal(errCode(await e.patch(a.id, { title: "x" }, '"stale"', undefined, "dry_run=true")), "stale", "If-Match applies");
    assert.equal(errCode(await e.upsert(entry(1), undefined, "dry_run=maybe")), "invalid_payload");
  });
});

describe("redirects", () => {
  test("a slug change keeps the old address; it follows later moves and stops at a delete", async () => {
    const e = env(site());
    const a = b(await e.upsert(entry(1, { slug: "first" })));
    await e.patch(a.id, { slug: "second" });
    await e.patch(a.id, { slug: "third" });
    for (const slug of ["first", "second"]) {
      const r = b(await e.redirect(`kind=post&slug=${slug}`));
      assert.deepEqual(r, { kind: "post", slug, id: a.id, url: "https://test.example/post/third", status: "published" });
    }
    assert.equal(errCode(await e.redirect("kind=post&slug=third")), "not_found", "the entry lives there");
    assert.equal(errCode(await e.redirect("slug=never")), "not_found");
    assert.equal(errCode(await e.redirect("kind=post")), "invalid_payload");
    // Another entry takes an old address: it wins.
    await e.upsert(entry(2, { slug: "first" }));
    assert.equal(errCode(await e.redirect("kind=post&slug=first")), "not_found");
    assert.equal((await resolveRedirect(e.store, "default", "post", "second"))?.id, a.id);
    await e.del(a.id);
    assert.equal(errCode(await e.redirect("kind=post&slug=second")), "not_found", "the entry is gone");
    assert.equal(await resolveRedirect(e.store, "default", "post", "second"), null);
  });

  test("a kind change and a restore to an old slug redirect too; drafts never do publicly", async () => {
    const e = env(site());
    const a = b(await e.upsert(entry(1, { slug: "about" })));
    await e.patch(a.id, { kind: "page" });
    assert.equal(b(await e.redirect("kind=post&slug=about")).url, "https://test.example/page/about");
    const rev = b(await e.revisions(a.id)).items[0].revision;
    await e.restore(a.id, { revision: rev });
    assert.equal(b(await e.redirect("kind=page&slug=about")).url, "https://test.example/post/about");
    await e.patch(a.id, { status: "draft" });
    assert.equal(b(await e.redirect("kind=page&slug=about")).status, "draft");
    assert.equal(await resolveRedirect(e.store, "default", "page", "about"), null, "a page never redirects to a draft");
  });

  test("FileStore: ids follow the slug and redirects follow the id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "inkwire-redirects-"));
    try {
      const e = env(new FileStore({ root, mediaUrlBase: "https://test.example/media" }));
      const a = b(await e.upsert(entry(1, { slug: "one" })));
      const two = b(await e.patch(a.id, { slug: "two" }));
      const three = b(await e.patch(two.id, { slug: "three" }));
      assert.equal(three.id, "post.three");
      assert.equal(b(await e.redirect("slug=one")).id, "post.three");
      assert.equal(b(await e.redirect("slug=two")).id, "post.three");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a store without redirects keeps none and does not advertise them", async () => {
    const plain = Object.assign(Object.create(MemoryStore.prototype), new MemoryStore(), { saveRedirect: undefined });
    const e = env(plain);
    const a = b(await e.upsert(entry(1)));
    assert.equal((await e.patch(a.id, { slug: "moved" })).status, 200);
    assert.equal(errCode(await e.redirect("slug=entry-1")), "not_found");
  });
});

describe("translations", () => {
  test("lang and translation_key are stored, listed, filtered and cleared", async () => {
    const e = env(site());
    const en = b(await e.upsert(entry("en", { title: "Pricing", lang: "en", translation_key: "pricing" })));
    const fr = b(await e.upsert(entry("fr", { title: "Tarifs", excerpt: "Ce que ça coûte", lang: "fr-CA", translation_key: "pricing" })));
    assert.equal(b(await e.get(fr.id)).lang, "fr-CA");
    assert.deepEqual(b(await e.list("translation_key=pricing")).items.map((i: { lang: string }) => i.lang).sort(), ["en", "fr-CA"]);
    assert.deepEqual(b(await e.list("lang=en")).items.map((i: { id: string }) => i.id), [en.id]);
    assert.equal(errCode(await e.upsert(entry(3, { lang: "not a tag" }))), "invalid_payload");
    const cleared = b(await e.patch(fr.id, { lang: null, translation_key: null }));
    assert.equal(cleared.lang, undefined);
    assert.equal(cleared.translation_key, undefined);
  });

  test("hreflang alternates: public translations, self included, one per language, by language", async () => {
    const e = env(site());
    const en = b(await e.upsert(entry("en", { lang: "en", translation_key: "home" })));
    await e.upsert(entry("fr", { lang: "fr", translation_key: "home" }));
    await e.upsert(entry("de", { lang: "de", translation_key: "home", status: "draft" }));
    const self = (await e.store.get("default", en.id))!;
    assert.deepEqual(await alternates(e.store, "default", self), [
      { lang: "en", url: "https://test.example/post/entry-en" },
      { lang: "fr", url: "https://test.example/post/entry-fr" },
    ]);
    const alone = b(await e.upsert(entry("solo", { lang: "en", translation_key: "solo" })));
    assert.deepEqual(await alternates(e.store, "default", (await e.store.get("default", alone.id))!), []);
    // Two English versions of one page: a warning, the newest wins.
    assert.deepEqual(codes(await e.upsert(entry("en2", { lang: "en", translation_key: "home" }))), ["translation_lang_duplicate"]);
  });

  test("a store that does not keep them refuses the fields", async () => {
    const plain = Object.assign(Object.create(MemoryStore.prototype), new MemoryStore(), { translations: false });
    const e = env(plain);
    assert.equal(errCode(await e.upsert(entry(1, { lang: "en" }))), "invalid_payload");
    assert.equal(errCode(await e.list("lang=en")), "invalid_payload");
  });
});

describe("sitemap", () => {
  test("public, indexable, self-canonical entries only, with lastmod", async () => {
    const e = env(site());
    const a = b(await e.upsert(entry(1)));
    await e.upsert(entry(2, { status: "draft" }));
    await e.upsert(entry(3, { seo: { noindex: true } }));
    await e.upsert(entry(4, { canonical_url: "https://elsewhere.test/original" }));
    await e.upsert(entry(5, { published_at: "2999-01-01T00:00:00Z" }));
    const self = b(await e.upsert(entry(6, { canonical_url: "https://test.example/post/entry-6" })));
    const items = await sitemapEntries(e.store, "default");
    assert.deepEqual(items.map((i) => i.url).sort(), [a.url, self.url].sort());
    assert.ok(items.every((i) => i.kind === "post" && !Number.isNaN(Date.parse(i.lastmod))));
  });
});

describe("image sizes", () => {
  test("read from PNG, GIF, WebP (VP8, VP8L, VP8X), JPEG and AVIF headers", () => {
    assert.deepEqual(imageSize(PNG, "image/png"), { width: 1, height: 1 });
    const gif = Buffer.from("474946383961" + "2003" + "1000", "hex"); // 800 x 16
    assert.deepEqual(imageSize(gif, "image/gif"), { width: 800, height: 16 });
    const riff = (chunk: string, data: Buffer) => Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP" + chunk, "latin1"), Buffer.alloc(4), data]);
    const vp8 = Buffer.alloc(10);
    vp8.set([0x9d, 0x01, 0x2a], 3);
    vp8.writeUInt16LE(640, 6);
    vp8.writeUInt16LE(480, 8);
    assert.deepEqual(imageSize(riff("VP8 ", vp8), "image/webp"), { width: 640, height: 480 });
    const vp8l = Buffer.alloc(10);
    vp8l[0] = 0x2f;
    vp8l.writeUInt32LE((100 - 1) | ((50 - 1) << 14), 1);
    assert.deepEqual(imageSize(riff("VP8L", vp8l), "image/webp"), { width: 100, height: 50 });
    const vp8x = Buffer.alloc(10);
    vp8x.writeUIntLE(1920 - 1, 4, 3);
    vp8x.writeUIntLE(1080 - 1, 7, 3);
    assert.deepEqual(imageSize(riff("VP8X", vp8x), "image/webp"), { width: 1920, height: 1080 });
    // SOI, an APP0 segment, then SOF2 (progressive): height 300, width 400.
    const jpeg = Buffer.from("ffd8" + "ffe00004abcd" + "ffc2000b08012c019003012200", "hex");
    assert.deepEqual(imageSize(jpeg, "image/jpeg"), { width: 400, height: 300 });
    const ispe = Buffer.alloc(20);
    ispe.writeUInt32BE(20, 0);
    ispe.write("ispe", 4, "latin1");
    ispe.writeUInt32BE(1200, 12);
    ispe.writeUInt32BE(630, 16);
    assert.deepEqual(imageSize(Buffer.concat([Buffer.from("0000001c667479706176696600000000", "hex"), ispe]), "image/avif"), { width: 1200, height: 630 });
    assert.equal(imageSize(Buffer.from("ffd8ff", "hex"), "image/jpeg"), null);
  });

  test("uploads record their size, edits keep it, and markdown images of the library get width and height", async () => {
    const e = env(site());
    const up = await upload(e);
    assert.equal(up.width, 1);
    assert.equal(up.height, 1);
    assert.equal(b(await e.mediaUpdate(up.id, { alt: "A dot" })).width, 1);
    const a = b(await e.upsert(entry(1, { markdown: `![A dot](${up.url})\n\n![Other](https://elsewhere.test/x.png)` })));
    const html = (await e.store.get("default", a.id))!.html;
    assert.match(html, new RegExp(`<img src="${up.url}" alt="A dot" width="1" height="1" />`));
    assert.match(html, /<img src="https:\/\/elsewhere.test\/x.png" alt="Other" \/>/);
  });

  test("FileStore keeps the size in the sidecar", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "inkwire-size-"));
    try {
      const e = env(new FileStore({ root, mediaUrlBase: "https://test.example/media" }));
      const up = await upload(e);
      assert.equal(b(await e.mediaUpdate(up.id, { title: "Dot" })).height, 1);
      assert.equal(b(await e.mediaList("")).items[0].width, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
