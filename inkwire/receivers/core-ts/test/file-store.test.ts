import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { FileStore, InkwireError, type SaveEntry } from "../src/index.js";
import { PNG, b, env, post, multipart } from "./helpers.js";

let root: string;
let store: FileStore;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "inkwire-fs-"));
  store = new FileStore({ root, mediaUrlBase: "https://site.test/media" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const entry = (over: Partial<SaveEntry> = {}): SaveEntry => ({
  key: "default",
  external_id: "ext-1",
  kind: "post",
  title: "Hello",
  slug: "hello",
  markdown: "# Hello\n\nbody",
  html: "<h1>Hello</h1>",
  seo: null,
  status: "published",
  published_at: "2026-07-22T04:00:00.000Z",
  updated_at: "2026-07-22T04:00:00.000Z",
  version: 1,
  ...over,
});
const write = (rel: string, text: string) => {
  const f = path.join(root, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text);
  return f;
};

describe("FileStore round trip", () => {
  test("writes <kind>/<slug>.md with YAML frontmatter and reads it back identically", async () => {
    const full = entry({
      excerpt: "Ex: with colon",
      tags: ["a", "b c"],
      cover_image_url: "https://i.test/c.jpg",
      canonical_url: "https://o.test/p",
      seo: { title: "S", noindex: true },
      author: { name: "Isaac", email: "i@x.com" },
      external_id: "123",
      markdown: "# Hello\n\n---\n\nSecond: part\n\n```yaml\nkey: value\n```",
      version: 3,
    });
    const saved = await store.save("default", full);
    assert.equal(saved.id, "post.hello");
    const file = path.join(root, "post", "hello.md");
    const text = readFileSync(file, "utf8");
    assert.match(text, /^---\n/);
    assert.match(text, /title: Hello/);
    assert.ok(text.endsWith("```\n"));
    const read = await store.get("default", "post.hello");
    assert.ok(read);
    for (const k of ["external_id", "kind", "title", "slug", "markdown", "excerpt", "tags", "cover_image_url", "canonical_url", "seo", "author", "status", "published_at", "updated_at", "version"] as const) {
      assert.deepEqual(read[k], (full as any)[k], k);
    }
    assert.match(read.html, /<h1>Hello<\/h1>/);
    assert.equal(read.url, "https://site.test/post/hello");
    assert.equal(read.etag, saved.etag);
  });

  test("list and get via the handlers: create, patch, delete leave a clean directory", async () => {
    const e = env(store);
    const a = b(await e.upsert(post(1, { title: "On Disk" })));
    assert.ok(existsSync(path.join(root, "post", "on-disk.md")));
    await e.patch(a.id, { kind: "page" });
    assert.ok(!existsSync(path.join(root, "post", "on-disk.md")));
    assert.ok(existsSync(path.join(root, "page", "on-disk.md")));
    await e.del(b(await e.list("")).items[0].id);
    assert.deepEqual(readdirSync(path.join(root, "page")), []);
  });

  test("no temp files are left behind", async () => {
    await store.save("default", entry());
    await store.save("default", entry({ id: "post.hello", title: "Again" }));
    assert.deepEqual(readdirSync(path.join(root, "post")), ["hello.md"]);
  });

  test("remove returns false for a missing entry, true once", async () => {
    await store.save("default", entry());
    assert.equal(await store.remove("default", "post.hello"), true);
    assert.equal(await store.remove("default", "post.hello"), false);
    assert.equal(await store.remove("default", "../../etc/passwd"), false);
  });
});

describe("FileStore reads hand-written files", () => {
  test("no frontmatter: title from the first # heading, external_id null, published, kind from folder", async () => {
    write("post/plain.md", "# A Plain File\n\nJust text.\n");
    const e = await store.get("default", "post.plain");
    assert.ok(e);
    assert.equal(e.title, "A Plain File");
    assert.equal(e.external_id, null);
    assert.equal(e.status, "published");
    assert.equal(e.kind, "post");
    assert.equal(e.slug, "plain");
    assert.equal(e.markdown, "# A Plain File\n\nJust text.");
    assert.ok(!Number.isNaN(Date.parse(e.published_at)));
    assert.ok(!Number.isNaN(Date.parse(e.updated_at)));
  });
  test("partial frontmatter: given fields kept, the rest defaulted", async () => {
    write("page/about.md", "---\nstatus: draft\ntags: one, two\ndate: 2025-03-04\nauthor: Ana\n---\n\n# About\n\ntext\n");
    const e = (await store.get("default", "page.about"))!;
    assert.equal(e.status, "draft");
    assert.deepEqual(e.tags, ["one", "two"]);
    assert.equal(e.title, "About");
    assert.equal(e.kind, "page");
    assert.deepEqual(e.author, { name: "Ana" });
    assert.equal(e.published_at, "2025-03-04T00:00:00.000Z");
    assert.equal(e.external_id, null);
  });
  test("a title falls back to the slug when there is no heading", async () => {
    write("post/no-heading.md", "just words\n");
    assert.equal((await store.get("default", "post.no-heading"))!.title, "no heading");
  });
  test("hand-written entries show up in list, are filterable, and can be patched", async () => {
    write("post/hand.md", "# Hand\n\nneedle text\n");
    const e = env(store);
    await e.upsert(post(1));
    const all = b(await e.list(""));
    assert.equal(all.items.length, 2);
    const hand = b(await e.list("search=needle")).items[0];
    assert.equal(hand.external_id, null);
    assert.equal(hand.title, "Hand");
    const r = await e.patch(hand.id, { title: "Hand edited" });
    assert.equal(r.status, 200);
    assert.match(readFileSync(path.join(root, "post", "hand.md"), "utf8"), /title: Hand edited/);
  });
  test("files that cannot be addressed or read stay hidden", async () => {
    write("post/Bad Name.md", "# no\n");
    write("post/ok.md", "---\n: : not yaml [\n---\nbody\n");
    write("post/.hidden.md", "# no\n");
    write("post/notes.txt", "no");
    write("post/fine.md", "# Fine\n");
    const list = await store.list("default", { limit: 100 });
    assert.deepEqual(list.items.map((i) => i.slug), ["fine"]);
  });
  test("non-http cover/canonical URLs from hand-written frontmatter are dropped", async () => {
    write("post/x.md", "---\ncover_image_url: javascript:alert(1)\ncanonical_url: data:x\nseo:\n  image_url: javascript:alert(1)\n---\nbody\n");
    const e = (await store.get("default", "post.x"))!;
    assert.equal(e.cover_image_url, undefined);
    assert.equal(e.canonical_url, undefined);
    assert.equal(e.seo, null);
  });
  test("the media folder is not a kind", async () => {
    write("media/stray.md", "# stray\n");
    assert.deepEqual((await store.list("default", { limit: 10 })).items, []);
    assert.equal(await store.get("default", "media.stray"), null);
  });
});

describe("FileStore path safety", () => {
  test("slugs and kinds outside the pattern never touch a path", async () => {
    for (const slug of ["../escape", "a/b", "..", "A", "with space", "x.md", "", "a\0b", "..%2f"]) {
      await assert.rejects(store.save("default", entry({ slug })), (e: unknown) => e instanceof InkwireError && e.code === "invalid_payload", JSON.stringify(slug));
    }
    for (const kind of ["../x", "media", "A", "a/b", ".hidden"]) {
      await assert.rejects(store.save("default", entry({ kind })), (e: unknown) => e instanceof InkwireError && e.code === "invalid_payload", kind);
    }
    assert.deepEqual(readdirSync(root), []);
    assert.ok(!existsSync(path.join(root, "..", "escape.md")));
  });
  test("ids that are not kind.slug resolve to nothing", async () => {
    write("post/real.md", "# real\n");
    for (const id of ["../post/real", "post/real", "post.real/../real", "post.", ".real", "post.REAL", "", "x".repeat(500), "post.re\0al"]) {
      assert.equal(await store.get("default", id), null, JSON.stringify(id));
    }
    assert.ok(await store.get("default", "post.real"));
  });
  test("list filters with traversal values find nothing and touch nothing", async () => {
    write("post/real.md", "# real\n");
    assert.deepEqual((await store.list("default", { kind: "../post", limit: 10 })).items, []);
    assert.deepEqual((await store.list("default", { slug: "../real", limit: 10 })).items, []);
  });
  test("saving onto a file that is not this entry -> conflict, file untouched", async () => {
    write("post/taken.md", "---\n: : not yaml [\n---\nprecious\n");
    await assert.rejects(store.save("default", entry({ slug: "taken" })), (e: unknown) => e instanceof InkwireError && e.code === "conflict");
    assert.match(readFileSync(path.join(root, "post", "taken.md"), "utf8"), /precious/);
  });
});

describe("FileStore ETag", () => {
  test("changes when the file is touched or edited outside the API", async () => {
    const saved = await store.save("default", entry());
    const same = (await store.get("default", saved.id))!;
    assert.equal(same.etag, saved.etag);
    const file = path.join(root, "post", "hello.md");
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    const touched = (await store.get("default", saved.id))!;
    assert.notEqual(touched.etag, saved.etag);
    writeFileSync(file, readFileSync(file, "utf8").replace("body", "BODY"));
    const edited = (await store.get("default", saved.id))!;
    assert.notEqual(edited.etag, touched.etag);
    assert.equal(edited.markdown.includes("BODY"), true);
  });
  test("a PATCH based on a pre-edit ETag is stale", async () => {
    const e = env(store);
    const a = b(await e.upsert(post(1)));
    const etag = (await e.get(a.id)).headers.ETag!;
    const file = path.join(root, "post", `${a.slug}.md`);
    writeFileSync(file, readFileSync(file, "utf8") + "\nhand edit\n");
    assert.equal((await e.patch(a.id, { title: "x" }, etag)).status, 412);
  });
});

describe("FileStore media", () => {
  test("writes <root>/media/<hex>-<name> with an alt sidecar and a url under mediaUrlBase", async () => {
    const m = await store.saveMedia("default", { bytes: PNG, contentType: "image/png", filename: "px.png", alt: "One pixel" });
    assert.match(m.url, /^https:\/\/site\.test\/media\/[0-9a-f]{16}-px\.png$/);
    assert.equal(m.alt, "One pixel");
    const name = m.url.split("/").pop()!;
    assert.deepEqual(readFileSync(path.join(root, "media", name)), PNG);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, "media", `${name}.meta.json`), "utf8")), { alt: "One pixel", content_type: "image/png", created_at: m.created_at });
    assert.equal(m.mime_type, "image/png");
  });
  test("through handleMedia", async () => {
    const mp = multipart([{ name: "file", file: { filename: "p.png", contentType: "image/png", data: PNG } }]);
    const r = await env(store).media(mp.contentType, mp.body);
    assert.equal(r.status, 200);
    assert.equal(readdirSync(path.join(root, "media")).length, 2);
  });
});
