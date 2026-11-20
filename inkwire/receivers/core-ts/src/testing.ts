import assert from "node:assert/strict";
import type { ContentStore, SaveEntry, StoredContent } from "./store.js";

/**
 * The store contract as a test suite, for anyone backing Inkwire with their own database.
 *
 *   import { describe, test } from "node:test";          // or vitest's describe / it
 *   import { runStoreContract } from "inkwire-receiver-core/testing";
 *   runStoreContract({ name: "my store", describe, test, create: async () => ({ store: new MyStore(db), cleanup }) });
 *
 * `create` must hand back an EMPTY store each time it is called (a fresh schema, a truncated
 * table, a new directory). The suite checks what the HTTP handlers rely on and what the black-box
 * conformance run cannot see from outside: scope isolation, id stability across a slug or kind
 * change, the etag moving on every write, optional fields coming back absent (not `null`),
 * exact `external_id` and `slug` lookups, and paging that neither repeats nor skips an entry.
 *
 * Uniqueness under concurrent writers (one row per `external_id`, one per `kind` + `slug`) is a
 * database constraint, not something a test can prove: add the unique indexes.
 */
export interface StoreContractOptions {
  name: string;
  describe: (name: string, fn: () => void) => void;
  test: (name: string, fn: () => Promise<void>) => void;
  create: () => Promise<{ store: ContentStore; cleanup?: () => Promise<void> | void }>;
  /**
   * False for a store that is one site, not one site per key (FileStore, GitHubStore stamp the key
   * on what they return but do not partition by it). Default true: the scope isolation checks run.
   */
  scoped?: boolean;
  /**
   * False for a store whose id is derived from the entry's place (`<kind>.<slug>`): a slug or kind
   * change then gives the entry a new id and the old one stops resolving. Default true: the id
   * survives the change.
   */
  opaqueIds?: boolean;
  /**
   * True for a store that holds only `post` (a blog's table): the checks that move an entry to
   * another kind, or list a second kind, are skipped; asking for any other kind must list nothing.
   */
  singleKind?: boolean;
  /** Public address the store is expected to give an entry. Default: any non-empty string. */
  expectUrl?: (e: { kind: string; slug: string }) => string;
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const T0 = Date.parse("2026-07-22T04:00:00.000Z");
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

export function entry(over: Partial<SaveEntry> = {}): SaveEntry {
  const slug = over.slug ?? "hello";
  return {
    key: "default",
    external_id: over.external_id === undefined ? `ext-${slug}` : over.external_id,
    kind: "post",
    title: "Hello",
    slug,
    markdown: "# Hello\n\nbody",
    html: "<h1>Hello</h1>\n<p>body</p>",
    seo: null,
    status: "published",
    published_at: iso(0),
    updated_at: iso(0),
    version: 1,
    ...over,
  };
}

export function runStoreContract(o: StoreContractOptions): void {
  const { describe, test } = o;
  const A = "scope-a";
  const B = "scope-b";

  async function withStore(fn: (store: ContentStore) => Promise<void>) {
    const { store, cleanup } = await o.create();
    try {
      await fn(store);
    } finally {
      await cleanup?.();
    }
  }

  const page = (store: ContentStore, key: string, limit: number, cursor?: string) =>
    store.list(key, { limit, ...(cursor ? { cursor } : {}) });

  describe(`Inkwire store contract: ${o.name}`, () => {
    test("save creates an entry; get returns it with an id, the scope, a url and an etag", () =>
      withStore(async (store) => {
        const saved = await store.save(A, entry({ tags: ["seo", "ai"], categories: ["Guides", "News"], excerpt: "Short", cover_image_url: "https://x.test/c.jpg", cover_image_alt: "A cover", canonical_url: "https://x.test/p", author: { name: "Isaac", email: "i@x.test" }, seo: { title: "T", noindex: true, og_title: "OG", og_description: "OGD", json_ld: '{"@type":"FAQPage"}' } }));
        assert.ok(saved.id, "id");
        assert.equal(saved.key, A);
        assert.ok(saved.url, "url");
        if (o.expectUrl) assert.equal(saved.url, o.expectUrl(saved));
        assert.ok(saved.etag, "etag");
        const got = await store.get(A, saved.id);
        assert.ok(got);
        for (const k of ["external_id", "kind", "title", "slug", "markdown", "html", "excerpt", "tags", "categories", "cover_image_url", "cover_image_alt", "canonical_url", "seo", "author", "status", "published_at", "updated_at", "version"] as const) {
          assert.deepEqual(got[k], saved[k], `get() and save() agree on ${k}`);
        }
        assert.deepEqual(got.tags, ["seo", "ai"]);
        assert.deepEqual(got.categories, ["Guides", "News"]);
        assert.equal(got.cover_image_alt, "A cover");
        assert.deepEqual(got.seo, { title: "T", noindex: true, og_title: "OG", og_description: "OGD", json_ld: '{"@type":"FAQPage"}' });
        assert.deepEqual(got.author, { name: "Isaac", email: "i@x.test" });
        assert.equal(got.published_at, iso(0), "dates come back as the same ISO string");
      }));

    test("get of an unknown id is null, not an error", () =>
      withStore(async (store) => {
        assert.equal(await store.get(A, "does-not-exist"), null);
      }));

    test("optional fields that were not set come back absent (undefined), never null or empty", () =>
      withStore(async (store) => {
        const saved = await store.save(A, entry());
        const got = (await store.get(A, saved.id)) as StoredContent;
        for (const k of ["excerpt", "tags", "categories", "cover_image_url", "cover_image_alt", "canonical_url", "author"] as const) {
          assert.equal(got[k], undefined, `${k} must be undefined, not ${JSON.stringify(got[k])} (map a NULL column to undefined)`);
        }
        assert.equal(got.seo, null, "seo is null when there are no overrides");
        assert.equal(got.external_id, saved.external_id);
      }));

    test("an entry written by hand has external_id null and is first-class", () =>
      withStore(async (store) => {
        const saved = await store.save(A, entry({ slug: "by-hand", external_id: null }));
        assert.equal((await store.get(A, saved.id))?.external_id, null);
        assert.equal((await store.list(A, { limit: 10 })).items.length, 1);
      }));

    test("an update keeps the id, moves the etag, and a slug or kind change moves the entry", () =>
      withStore(async (store) => {
        const first = await store.save(A, entry({ slug: "old-slug" }));
        const second = await store.save(A, entry({ id: first.id, slug: "new-slug", title: "Renamed", version: 2, updated_at: iso(5) }));
        const opaque = o.opaqueIds !== false;
        if (opaque) assert.equal(second.id, first.id, "id survives a slug change");
        else assert.equal(await store.get(A, first.id), null, "a place-derived id stops resolving after the move");
        assert.notEqual(second.etag, first.etag, "etag changes on every accepted write");
        assert.equal((await store.get(A, second.id))?.slug, "new-slug");
        assert.equal((await store.list(A, { slug: "old-slug", limit: 5 })).items.length, 0, "the old slug is free");
        assert.equal((await store.list(A, { slug: "new-slug", limit: 5 })).items.length, 1);
        assert.equal((await store.list(A, { limit: 10 })).items.length, 1, "no duplicate left behind");
        if (o.singleKind) return;
        const third = await store.save(A, entry({ id: second.id, slug: "new-slug", kind: "page", version: 3, updated_at: iso(6) }));
        if (opaque) assert.equal(third.id, first.id);
        assert.equal((await store.list(A, { kind: "post", limit: 5 })).items.length, 0);
        assert.equal((await store.list(A, { kind: "page", limit: 5 })).items.length, 1);
      }));

    test("the etag changes when only the body changes", () =>
      withStore(async (store) => {
        const first = await store.save(A, entry());
        const second = await store.save(A, entry({ id: first.id, markdown: "changed", html: "<p>changed</p>", version: 2, updated_at: iso(1) }));
        assert.notEqual(second.etag, first.etag);
        assert.equal((await store.get(A, first.id))?.etag, second.etag, "get() reports the etag the last save returned");
      }));

    test("list filters: status, kind, tag, search, external_id, slug", () =>
      withStore(async (store) => {
        await store.save(A, entry({ slug: "one", external_id: "e1", title: "The Needle", tags: ["a", "b"], categories: ["Guides"] }));
        await store.save(A, entry({ slug: "two", external_id: "e2", status: "draft", kind: o.singleKind ? "post" : "page", markdown: "haystack with a NEEDLE inside", updated_at: iso(1) }));
        await store.save(A, entry({ slug: "three", external_id: "e3", excerpt: "needle in the excerpt", tags: ["b"], updated_at: iso(2) }));
        const slugs = async (f: Parameters<ContentStore["list"]>[1]) => (await store.list(A, f)).items.map((e) => e.slug).sort();
        assert.deepEqual(await slugs({ limit: 10 }), ["one", "three", "two"]);
        assert.deepEqual(await slugs({ status: "draft", limit: 10 }), ["two"]);
        assert.deepEqual(await slugs({ kind: "page", limit: 10 }), o.singleKind ? [] : ["two"]);
        assert.deepEqual(await slugs({ tag: "b", limit: 10 }), ["one", "three"]);
        assert.deepEqual(await slugs({ tag: "nope", limit: 10 }), []);
        assert.deepEqual(await slugs({ category: "Guides", limit: 10 }), ["one"]);
        assert.deepEqual(await slugs({ category: "guides", limit: 10 }), [], "category matches exactly");
        assert.deepEqual(await slugs({ search: "needle", limit: 10 }), ["one", "three", "two"], "case-insensitive over title, excerpt and markdown");
        assert.deepEqual(await slugs({ external_id: "e2", limit: 10 }), ["two"], "exact external_id");
        assert.deepEqual(await slugs({ external_id: "e", limit: 10 }), [], "external_id is not a prefix match");
        assert.deepEqual(await slugs({ slug: "one", limit: 10 }), ["one"]);
        assert.deepEqual(await slugs({ slug: "on", limit: 10 }), [], "slug is not a prefix match");
        assert.deepEqual(await slugs({ kind: "post", slug: "one", limit: 10 }), ["one"], "filters combine");
      }));

    test("list is newest first by updated_at and pages without repeating or skipping, even when an entry changes between pages", () =>
      withStore(async (store) => {
        for (let i = 0; i < 7; i++) await store.save(A, entry({ slug: `p${i}`, external_id: `e${i}`, updated_at: iso(i) }));
        const first = await page(store, A, 3);
        assert.deepEqual(first.items.map((e) => e.slug), ["p6", "p5", "p4"], "newest first");
        assert.ok(first.next_cursor, "a cursor when there is more");
        // a new entry and an edit to an entry already on page one, between the two requests
        await store.save(A, entry({ slug: "fresh", external_id: "efresh", updated_at: iso(50) }));
        const edited = first.items[0]!;
        await store.save(A, entry({ id: edited.id, slug: edited.slug, external_id: edited.external_id, version: 2, updated_at: iso(60) }));
        const second = await page(store, A, 3, first.next_cursor!);
        assert.deepEqual(second.items.map((e) => e.slug), ["p3", "p2", "p1"], "page two continues where page one stopped");
        const third = await page(store, A, 3, second.next_cursor!);
        assert.deepEqual(third.items.map((e) => e.slug), ["p0"]);
        assert.equal(third.next_cursor, null, "no cursor on the last page");
      }));

    test("a cursor the store did not issue is rejected with an invalid_payload error", () =>
      withStore(async (store) => {
        await store.save(A, entry());
        await assert.rejects(() => page(store, A, 3, "not-a-cursor"), (e: unknown) => (e as { code?: string }).code === "invalid_payload");
      }));

    test("scopes are isolated: another key sees none of it, can not read, list or remove it", () =>
      withStore(async (store) => {
        if (o.scoped === false) return;
        const mine = await store.save(A, entry({ slug: "mine" }));
        await store.save(B, entry({ slug: "mine", external_id: "ext-mine" }));
        assert.equal((await store.list(B, { limit: 10 })).items.length, 1, "B sees only its own entry, same slug and external_id are allowed in each scope");
        assert.equal(await store.get(B, mine.id), null);
        assert.equal(await store.remove(B, mine.id), false);
        assert.ok(await store.get(A, mine.id), "A's entry survived B's remove");
        assert.equal((await store.list(A, { external_id: "ext-mine", limit: 5 })).items.length, 1);
      }));

    test("remove returns true once, false after, and the entry is gone", () =>
      withStore(async (store) => {
        const saved = await store.save(A, entry());
        assert.equal(await store.remove(A, saved.id), true);
        assert.equal(await store.remove(A, saved.id), false);
        assert.equal(await store.get(A, saved.id), null);
        assert.equal((await store.list(A, { limit: 5 })).items.length, 0);
      }));

    test("concurrent saves of different entries all land", () =>
      withStore(async (store) => {
        await Promise.all(Array.from({ length: 12 }, (_, i) => store.save(A, entry({ slug: `c${i}`, external_id: `ec${i}`, updated_at: iso(i) }))));
        const all = await store.list(A, { limit: 100 });
        assert.equal(all.items.length, 12);
        assert.equal(new Set(all.items.map((e) => e.id)).size, 12, "ids are unique");
      }));

    test("unicode and long markdown survive the round trip", () =>
      withStore(async (store) => {
        const markdown = `# Été à Paris — ñ 日本 🚀\n\n${"line of text\n".repeat(5000)}`;
        const saved = await store.save(A, entry({ slug: "unicode", title: "Été à Paris — ñ 日本 🚀", markdown }));
        const got = await store.get(A, saved.id);
        assert.equal(got?.title, "Été à Paris — ñ 日本 🚀");
        assert.equal(got?.markdown, markdown);
      }));

    test("saveMedia (when the store has it) returns an id and a url, and keeps the alt text", () =>
      withStore(async (store) => {
        if (!store.saveMedia) return;
        const m = await store.saveMedia(A, { bytes: PNG, contentType: "image/png", filename: "px.png", alt: "One pixel" });
        assert.ok(m.id && m.url);
        assert.equal(m.alt, "One pixel");
        assert.equal(m.mime_type, "image/png");
        assert.ok(!Number.isNaN(Date.parse(m.created_at)), "created_at is a timestamp");
        const bare = await store.saveMedia(A, { bytes: PNG, contentType: "image/png", filename: "px.png" });
        assert.equal(bare.alt, undefined);
        assert.notEqual(bare.id, m.id);
      }));

    test("listMedia (when the store has it): newest first, search over alt, title and filename, stable paging", () =>
      withStore(async (store) => {
        if (!store.saveMedia || !store.listMedia) return;
        const ids: string[] = [];
        for (const [i, alt] of ["alpha", "beta", "gamma"].entries()) {
          ids.push((await store.saveMedia(A, { bytes: PNG, contentType: "image/png", filename: `${alt}-file.png`, alt: `${alt} alt` })).id);
          if (i < 2) await new Promise((r) => setTimeout(r, 15));
        }
        const all = await store.listMedia(A, { limit: 10 });
        assert.deepEqual(all.items.map((m) => m.id), [ids[2], ids[1], ids[0]], "newest first");
        assert.equal(all.next_cursor, null);
        assert.deepEqual((await store.listMedia(A, { search: "BETA", limit: 10 })).items.map((m) => m.id), [ids[1]], "alt, case-insensitive");
        assert.deepEqual((await store.listMedia(A, { search: "gamma-file", limit: 10 })).items.map((m) => m.id), [ids[2]], "filename");
        const first = await store.listMedia(A, { limit: 2 });
        assert.equal(first.items.length, 2);
        assert.ok(first.next_cursor);
        const second = await store.listMedia(A, { limit: 2, cursor: first.next_cursor! });
        assert.deepEqual([...first.items, ...second.items].map((m) => m.id), [ids[2], ids[1], ids[0]]);
        assert.equal(second.next_cursor, null);
        await assert.rejects(() => store.listMedia!(A, { limit: 2, cursor: "!!!" }), (e: { code?: string }) => e.code === "invalid_payload");
      }));

    test("updateMedia (when the store has it) sets, clears and keeps; an unknown id is null", () =>
      withStore(async (store) => {
        if (!store.saveMedia || !store.updateMedia) return;
        const m = await store.saveMedia(A, { bytes: PNG, contentType: "image/png", filename: "px.png", alt: "old" });
        const set = await store.updateMedia(A, m.id, { alt: "new", title: "A title" });
        assert.deepEqual([set?.alt, set?.title, set?.id, set?.url, set?.mime_type, set?.created_at], ["new", "A title", m.id, m.url, "image/png", m.created_at]);
        const cleared = await store.updateMedia(A, m.id, { alt: null });
        assert.equal(cleared?.alt, undefined);
        assert.equal(cleared?.title, "A title", "an absent key keeps its value");
        if (store.listMedia) {
          const listed = (await store.listMedia(A, { limit: 10 })).items.find((x) => x.id === m.id);
          assert.deepEqual([listed?.alt, listed?.title], [undefined, "A title"], "the library shows the edit");
        }
        assert.equal(await store.updateMedia(A, "0123456789abcdef", { alt: "x" }), null);
        assert.equal(await store.updateMedia(A, "../../etc/passwd", { alt: "x" }), null, "a hostile id never reaches a path");
      }));
  });
}
