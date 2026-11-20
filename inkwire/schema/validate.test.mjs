import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";

const loadJson = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url)));
const ajv = addFormats(new Ajv({ allErrors: true }));
const compile = (f) => ajv.compile(loadJson(f));
const load = (f) => JSON.parse(readFileSync(new URL(`./examples/${f}`, import.meta.url)));

const create = compile("./inkwire-content.schema.json");
const patch = compile("./inkwire-patch.schema.json");
const discovery = compile("./inkwire-discovery.schema.json");
const media = compile("./inkwire-media.schema.json");

test("create: valid-minimal passes", () => assert.equal(create(load("valid-minimal.json")), true));
test("create: valid-full passes", () => assert.equal(create(load("valid-full.json")), true));
test("create: missing title fails", () => {
  assert.equal(create(load("invalid-missing-title.json")), false);
  assert.ok(create.errors.some((e) => e.params.missingProperty === "title"));
});
test("create: partial seo overrides pass", () => {
  assert.equal(create({ external_id: "seo-1", title: "T", markdown: "x", seo: { noindex: true } }), true);
});
test("create: unknown seo properties fail", () => {
  assert.equal(create({ external_id: "seo-2", title: "T", markdown: "x", seo: { keywords: ["x"] } }), false);
});
test("create: empty seo title and description fail", () => {
  assert.equal(create({ external_id: "seo-3", title: "T", markdown: "x", seo: { title: "" } }), false);
  assert.equal(create({ external_id: "seo-4", title: "T", markdown: "x", seo: { description: "" } }), false);
});
test("create: non-http seo image and null seo fail", () => {
  assert.equal(create({ external_id: "seo-5", title: "T", markdown: "x", seo: { image_url: "javascript:alert(1)" } }), false);
  assert.equal(create({ external_id: "seo-6", title: "T", markdown: "x", seo: null }), false);
  assert.equal(create({ external_id: "seo-7", title: "T", markdown: "x", seo: { title: null } }), false);
  assert.equal(create({ external_id: "seo-8", title: "T", markdown: "x", seo: { noindex: "false" } }), false);
});
test("create: kind must be a lowercase identifier", () => {
  assert.equal(create({ external_id: "k-1", title: "T", markdown: "x", kind: "post" }), true);
  assert.equal(create({ external_id: "k-2", title: "T", markdown: "x", kind: "blog_post" }), true);
  assert.equal(create({ external_id: "k-3", title: "T", markdown: "x", kind: "Post" }), false);
  assert.equal(create({ external_id: "k-4", title: "T", markdown: "x", kind: "a/b" }), false);
  assert.equal(create({ external_id: "k-5", title: "T", markdown: "x", kind: "" }), false);
  assert.equal(create({ external_id: "k-6", title: "T", markdown: "x", kind: 7 }), false);
});

test("patch: every publish field is optional and one is required", () => {
  assert.equal(patch({ title: "New" }), true);
  assert.equal(patch({}), false);
  assert.equal(
    patch({
      title: "T", kind: "page", markdown: "m", slug: "s", excerpt: null, tags: null,
      cover_image_url: null, canonical_url: null, seo: null, author: null, status: "draft",
      published_at: null,
    }),
    true,
  );
});
test("patch: external_id cannot be changed", () => {
  assert.equal(patch({ external_id: "c-1", title: "T" }), false);
});
test("patch: unknown fields fail", () => {
  assert.equal(patch({ bogus: 1 }), false);
});
test("patch: empty markdown fails, null clears", () => {
  assert.equal(patch({ markdown: "" }), false);
  assert.equal(patch({ markdown: "x" }), true);
  assert.equal(patch({ excerpt: null }), true);
});
test("patch: seo merges per key, values validated", () => {
  assert.equal(patch({ seo: { noindex: true } }), true);
  assert.equal(patch({ seo: { image_url: null } }), true);
  assert.equal(patch({ seo: { title: "" } }), false);
  assert.equal(patch({ seo: { keywords: ["x"] } }), false);
});
test("patch: slug cannot be cleared and must stay a slug", () => {
  assert.equal(patch({ slug: null }), false);
  assert.equal(patch({ slug: "ok-slug" }), true);
  assert.equal(patch({ slug: "Not A Slug" }), false);
});
test("patch: status stays an enum", () => {
  assert.equal(patch({ status: null }), false);
  assert.equal(patch({ status: "published" }), true);
  assert.equal(patch({ status: "archived" }), false);
});

test("discovery: minimal and full pass", () => {
  assert.equal(discovery({ inkwire: 1, features: ["upsert"], kinds: ["post"] }), true);
  assert.equal(
    discovery({
      inkwire: 1,
      site: { name: "Acme", url: "https://acme.com" },
      features: ["upsert", "list", "get", "update", "delete", "media"],
      kinds: ["post", "page"],
      limits: { markdown_bytes: 1000000, media_bytes: 10000000 },
    }),
    true,
  );
});
test("discovery: rejects wrong shape", () => {
  assert.equal(discovery({ features: ["upsert"], kinds: ["post"] }), false); // missing inkwire: 1
  assert.equal(discovery({ inkwire: 2, features: ["upsert"], kinds: ["post"] }), false);
  assert.equal(discovery({ inkwire: 1, features: [], kinds: ["post"] }), false);
  assert.equal(discovery({ inkwire: 1, features: ["upsert"], kinds: [] }), false);
  assert.equal(discovery({ inkwire: 1, features: ["upsert"] }), false);
  assert.equal(discovery({ inkwire: 1, features: ["upsert"], kinds: ["post"], limits: { bogus: 1 } }), false);
});

test("media: url variant validates", () => {
  assert.equal(media({ url: "https://x.test/a.jpg" }), true);
  assert.equal(media({ url: "https://x.test/a.jpg", alt: "A chart" }), true);
  assert.equal(media({ url: "javascript:alert(1)" }), false);
  assert.equal(media({ alt: "no url" }), false);
  assert.equal(media({ url: "https://x.test/a.jpg", bogus: 1 }), false);
});
