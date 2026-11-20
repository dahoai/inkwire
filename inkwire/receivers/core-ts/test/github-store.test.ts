import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { GitHubStore, InkwireError } from "../src/index.js";
import { PNG, b, env, errCode, multipart, post } from "./helpers.js";
import { API, TOKEN, fakeGitHub } from "./fake-github.js";

const store = (gh: ReturnType<typeof fakeGitHub>, over: Record<string, unknown> = {}) =>
  new GitHubStore({
    owner: "acme",
    repo: "site",
    branch: "main",
    dir: "content",
    token: TOKEN,
    mediaUrlBase: "https://site.test/media",
    fetch: gh.fetchFn,
    ...over,
  });

let gh: ReturnType<typeof fakeGitHub>;
beforeEach(() => {
  gh = fakeGitHub();
});

describe("GitHubStore through the handlers", () => {
  test("create writes content/<kind>/<slug>.md on the branch, with the token as a bearer header only", async () => {
    const e = env(store(gh));
    const r = await e.upsert(post(1, { title: "On GitHub" }));
    assert.equal(r.status, 200);
    assert.equal(b(r).id, "post.on-github");
    const text = gh.files.get("content/post/on-github.md")!;
    assert.match(text, /^---\ntitle: On GitHub\n/);
    assert.match(text, /# Post 1/);
    const put = gh.calls.find((c) => c.method === "PUT")!;
    assert.equal(put.body.branch, "main");
    assert.equal(put.body.sha, undefined); // a new file
    assert.match(put.body.message, /^inkwire: create post\/on-github$/);
    assert.equal(put.headers.authorization, `Bearer ${TOKEN}`);
    for (const c of gh.calls) assert.ok(!c.path.includes(TOKEN) && !c.query.includes(TOKEN));
    assert.ok(gh.calls.every((c) => c.query.includes("ref=main") || c.method !== "GET" || c.path.startsWith("/git/trees/")));
  });

  test("ETag is the blob sha and changes with the content", async () => {
    const e = env(store(gh));
    const a = b(await e.upsert(post(1)));
    const g1 = await e.get(a.id);
    assert.equal(g1.headers.ETag, `"${gh.sha(gh.files.get("content/post/post-1.md")!)}"`);
    await e.patch(a.id, { title: "changed" });
    assert.notEqual((await e.get(a.id)).headers.ETag, g1.headers.ETag);
  });

  test("update replaces with the current blob sha; a stale If-Match is refused without writing", async () => {
    const e = env(store(gh));
    const a = b(await e.upsert(post(1)));
    const etag = (await e.get(a.id)).headers.ETag!;
    await e.patch(a.id, { title: "second" }, etag);
    const puts = gh.calls.filter((c) => c.method === "PUT").length;
    assert.equal((await e.patch(a.id, { title: "racer" }, etag)).status, 412);
    assert.equal(gh.calls.filter((c) => c.method === "PUT").length, puts);
    const update = gh.calls.filter((c) => c.method === "PUT")[1]!;
    assert.ok(update.body.sha);
    assert.match(update.body.message, /^inkwire: update /);
  });

  test("upsert of the same external_id updates in place (found through the tree)", async () => {
    const e = env(store(gh));
    const a = b(await e.upsert(post(1)));
    const again = b(await e.upsert(post(1, { title: "Retitled" })));
    assert.equal(again.created, false);
    assert.equal(again.id, a.id);
    assert.equal([...gh.files.keys()].filter((k) => k.endsWith(".md")).length, 1);
  });

  test("a kind change moves the file: new path written, old path deleted", async () => {
    const e = env(store(gh));
    const a = b(await e.upsert(post(1, { title: "Movable" })));
    const r = await e.patch(a.id, { kind: "page" });
    assert.equal(b(r).id, "page.movable");
    assert.deepEqual([...gh.files.keys()], ["content/page/movable.md"]);
  });

  test("delete removes the file with its sha; then get is 404", async () => {
    const e = env(store(gh));
    const a = b(await e.upsert(post(1)));
    assert.equal((await e.del(a.id)).status, 200);
    assert.equal(gh.files.size, 0);
    const del = gh.calls.find((c) => c.method === "DELETE")!;
    assert.ok(del.body.sha);
    assert.equal((await e.get(a.id)).status, 404);
  });

  test("reads hand-written files in the repo, outside the API", async () => {
    gh = fakeGitHub({
      "content/post/hand.md": "# Hand written\n\nneedle\n",
      "content/page/about.md": "---\nstatus: draft\n---\n# About\n",
      "content/post/Bad Name.md": "# no\n",
      "content/media/pic.png": "binary",
      "content/post/notes.txt": "no",
      "other/post/elsewhere.md": "# outside dir\n",
    });
    const e = env(store(gh));
    const all = b(await e.list(""));
    assert.deepEqual(all.items.map((i: any) => i.id), ["page.about", "post.hand"]); // ordered by path
    assert.equal(all.items[1].external_id, null);
    assert.equal(all.items[1].title, "Hand written");
    assert.deepEqual(b(await e.list("search=needle")).items.map((i: any) => i.id), ["post.hand"]);
    assert.deepEqual(b(await e.list("status=draft")).items.map((i: any) => i.id), ["page.about"]);
    assert.deepEqual(b(await e.list("kind=page")).items.map((i: any) => i.id), ["page.about"]);
  });

  test("list pages by path cursor without repeats", async () => {
    gh = fakeGitHub(Object.fromEntries(["a", "b", "c", "d", "e"].map((s) => [`content/post/${s}.md`, `# ${s}\n`])));
    const e = env(store(gh));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body: any = b(await e.list(`limit=2${cursor ? `&cursor=${cursor}` : ""}`));
      seen.push(...body.items.map((i: any) => i.slug));
      cursor = body.next_cursor;
      pages++;
    } while (cursor);
    assert.deepEqual(seen, ["a", "b", "c", "d", "e"]);
    assert.equal(pages, 3);
    assert.equal((await e.list("cursor=garbage")).status, 400);
  });

  test("a warm list reads each file once (cached by blob sha); a changed file is read again", async () => {
    gh = fakeGitHub({ "content/post/a.md": "# a\n", "content/post/b.md": "# b\n" });
    const e = env(store(gh));
    await e.list("");
    const reads = () => gh.calls.filter((c) => c.path.startsWith("/contents/") && c.method === "GET").length;
    const first = reads();
    assert.equal(first, 2);
    await e.list("");
    assert.equal(reads(), first);
    gh.files.set("content/post/a.md", "# a changed\n");
    assert.equal(b(await e.list("")).items[0].title, "a changed");
    assert.equal(reads(), first + 1);
  });

  test("explicit slug conflict and slug dedupe work across the tree", async () => {
    const e = env(store(gh));
    await e.upsert(post(1, { title: "Same" }));
    assert.equal(b(await e.upsert(post(2, { title: "Same" }))).slug, "same-2");
    assert.equal((await e.upsert(post(3, { slug: "same" }))).status, 409);
  });

  test("media: PUT base64 under content/media/, url under mediaUrlBase", async () => {
    const e = env(store(gh));
    const m = multipart([{ name: "alt", value: "px" }, { name: "file", file: { filename: "px.png", contentType: "image/png", data: PNG } }]);
    const r = await e.media(m.contentType, m.body);
    assert.equal(r.status, 200);
    assert.equal(b(r).alt, "px");
    assert.match(b(r).url, /^https:\/\/site\.test\/media\/[0-9a-f]{16}-px\.png$/);
    const [path, text] = [...gh.files][0]!;
    assert.match(path, /^content\/media\/[0-9a-f]{16}-px\.png$/);
    const put = gh.calls.find((c) => c.method === "PUT")!;
    assert.deepEqual(Buffer.from(put.body.content, "base64"), PNG);
    assert.ok(text);
  });

  test("dir '' puts kinds at the repo root", async () => {
    const e = env(store(gh, { dir: "" }));
    await e.upsert(post(1));
    assert.deepEqual([...gh.files.keys()], ["post/post-1.md"]);
    assert.equal(b(await e.list("")).items.length, 1);
  });
});

describe("GitHubStore failures", () => {
  test("a token is required, and dir cannot traverse", () => {
    assert.throws(() => store(gh, { token: "" }));
    assert.throws(() => store(gh, { dir: "../x" }));
  });
  test("unsafe slugs and kinds never become a path", async () => {
    const s = store(gh);
    const entry = (over: object) => ({ key: "default", external_id: "x", kind: "post", title: "t", slug: "ok", markdown: "m", html: "", seo: null, status: "draft" as const, published_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", version: 1, ...over });
    for (const over of [{ slug: "../x" }, { slug: "a/b" }, { kind: "../x" }, { kind: "media" }]) {
      await assert.rejects(s.save("default", entry(over)), (e: unknown) => e instanceof InkwireError && e.code === "invalid_payload");
    }
    assert.equal(await s.get("default", "../etc.passwd"), null);
    assert.equal(gh.calls.length, 0);
  });
  test("saving onto an existing file that is not this entry -> 409 conflict", async () => {
    gh = fakeGitHub({ "content/post/taken.md": "---\n: : not yaml [\n---\nprecious\n" });
    const r = await env(store(gh)).upsert(post(1, { slug: "taken" }));
    assert.equal(r.status, 409);
    assert.ok(gh.files.get("content/post/taken.md")!.includes("precious"));
  });
  test("401 from GitHub -> 500 internal, with no token in the response", async () => {
    gh.hooks.fail = () => new Response(JSON.stringify({ message: `Bad credentials ${TOKEN}` }), { status: 401 });
    const r = await env(store(gh)).upsert(post(1));
    assert.equal(r.status, 500);
    assert.ok(!JSON.stringify(r.body).includes(TOKEN));
  });
  test("rate limit -> 429 rate_limited", async () => {
    gh.hooks.fail = () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
    assert.equal(errCode(await env(store(gh)).list("")), "rate_limited");
  });
  test("a sha race (409/422 from GitHub) -> 412 stale", async () => {
    const e = env(store(gh));
    const a = b(await e.upsert(post(1)));
    gh.hooks.fail = (c) => (c.method === "PUT" ? new Response("{}", { status: 409 }) : undefined);
    assert.equal(errCode(await e.patch(a.id, { title: "x" })), "stale");
  });
  test("network failure -> 500 internal; the cause (which may hold the token) is not echoed", async () => {
    gh.hooks.network = true;
    const r = await env(store(gh)).get("post.x");
    assert.equal(r.status, 500);
    assert.ok(!JSON.stringify(r.body).includes(TOKEN));
  });
  test("a truncated tree is refused, not silently partial", async () => {
    gh.hooks.truncated = true;
    assert.equal((await env(store(gh)).list("")).status, 500);
  });
  test("a missing branch lists as empty (tree 404)", async () => {
    gh.hooks.fail = (c) => (c.path.startsWith("/git/trees/") ? new Response("{}", { status: 404 }) : undefined);
    assert.deepEqual(b(await env(store(gh)).list("")).items, []);
  });
  test("files over 1 MB (no inline content) are read through the blob API", async () => {
    const big = "# Big\n\n" + "x".repeat(100);
    const s = store(gh);
    const base = gh.fetchFn;
    gh = { ...gh, fetchFn: async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/contents/content/post/big.md")) {
        return new Response(JSON.stringify({ type: "file", sha: "bigsha", encoding: "none", content: "" }), { status: 200 });
      }
      if (u.pathname.endsWith("/git/blobs/bigsha")) return new Response(big, { status: 200 });
      return base(input, init);
    } };
    const s2 = new GitHubStore({ owner: "acme", repo: "site", branch: "main", dir: "content", token: TOKEN, mediaUrlBase: "https://site.test/media", fetch: gh.fetchFn });
    const got = await s2.get("default", "post.big");
    assert.equal(got?.title, "Big");
    assert.equal(got?.etag, "bigsha");
    assert.ok(s);
  });
});

describe("GitHubStore edits keep a hand-written file's own frontmatter", () => {
  test("a PATCH changes only what it names; the repo file keeps layout, comments and its draft key", async () => {
    gh = fakeGitHub({
      "content/post/existing-post.md": `---
# Astro content collection
layout: ../../layouts/Post.astro
title: Existing Post
description: The site's own description
pubDate: 2025-03-04
heroImage: /images/hero.png
weight: 7
draft: true
---

# Existing Post

Old text.
`,
    });
    const e = env(store(gh));
    const r = await e.patch("post.existing-post", { status: "published", markdown: "# Existing Post\n\nNew text." });
    assert.equal(r.status, 200);
    const text = gh.files.get("content/post/existing-post.md")!;
    assert.match(text, /# Astro content collection/);
    assert.match(text, /layout: \.\.\/\.\.\/layouts\/Post\.astro/);
    assert.match(text, /weight: 7/);
    assert.match(text, /draft: false/);
    assert.match(text, /pubDate: 2025-03-04/);
    assert.doesNotMatch(text, /^status:/m);
    assert.match(text, /New text\./);
  });
});

