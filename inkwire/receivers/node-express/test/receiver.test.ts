import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import dns from "node:dns";
import { EventEmitter } from "node:events";
import http from "node:http";
import { Readable } from "node:stream";
import express from "express";
import { buildReceiver, createInkwireRouter, fetchPublicImage, isPublicAddress } from "../src/inkwire-router.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const KEY = { authorization: "Bearer k-full" };

const servers: { close(): void }[] = [];
after(() => servers.forEach((s) => s.close()));

async function boot(env: Record<string, string> = {}, pre?: (app: express.Express) => void) {
  const root = mkdtempSync(path.join(tmpdir(), "inkwire-exp-"));
  const app = express();
  pre?.(app);
  app.use(createInkwireRouter({ INKWIRE_API_KEYS: "k-full,k-ro:ro", INKWIRE_ROOT: root, INKWIRE_MEDIA_LIMIT_BYTES: "2000", INKWIRE_MARKDOWN_LIMIT_BYTES: "2000", ...env }));
  const server = app.listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, root };
}
const post = (url: string, body: unknown, headers: Record<string, string> = KEY) =>
  fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const entry = (n: string) => ({ external_id: n, title: `T ${n}`, markdown: "# Hi", status: "published" });

describe("routes", () => {
  it("publishes, reads back and lists through the express adapter", async () => {
    const { base } = await boot();
    const r = await post(`${base}/api/content`, entry("a"));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("inkwire-version"), "1");
    const made = await r.json();
    assert.equal(made.kind, "post");
    assert.equal(made.url, `http://localhost:3000/post/${made.slug}`);
    const got = await fetch(`${base}/api/content/${made.id}`, { headers: KEY });
    assert.equal(got.status, 200);
    assert.ok(got.headers.get("etag"));
    const list = await (await fetch(`${base}/api/content?external_id=a`, { headers: KEY })).json();
    assert.equal(list.items.length, 1);
  });

  it("answers in the Inkwire shape for unknown /api paths, bad JSON, oversize bodies and missing auth", async () => {
    const { base } = await boot();
    const unknown = await fetch(`${base}/api/nope`, { headers: KEY });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, "not_found");

    const bad = await post(`${base}/api/content`, "{not json");
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, "invalid_payload");

    const big = await post(`${base}/api/content`, { ...entry("big"), markdown: "x".repeat(200_000) });
    assert.equal(big.status, 413);
    assert.equal((await big.json()).error.code, "too_large");

    const noauth = await post(`${base}/api/content`, entry("n"), {});
    assert.equal(noauth.status, 401);
    const ro = await post(`${base}/api/content`, entry("ro"), { authorization: "Bearer k-ro" });
    assert.equal(ro.status, 403);
  });

  it("works when the host app already runs express.json() before the router", async () => {
    const { base } = await boot({}, (app) => app.use(express.json()));
    const r = await post(`${base}/api/content`, entry("parsed"));
    assert.equal(r.status, 200);
    const patch = await fetch(`${base}/api/content/${(await r.json()).id}`, {
      method: "PATCH",
      headers: { ...KEY, "content-type": "application/json" },
      body: JSON.stringify({ title: "Changed" }),
    });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).title, "Changed");
  });

  it("stores an upload, serves it at the url it returns, and keeps the sidecar private", async () => {
    const { base, root } = await boot({ INKWIRE_SITE_URL: "http://127.0.0.1:1" });
    const fd = new FormData();
    fd.append("file", new Blob([PNG], { type: "image/png" }), "px.png");
    fd.append("alt", "a pixel");
    const up = await fetch(`${base}/api/media`, { method: "POST", headers: KEY, body: fd });
    assert.equal(up.status, 200);
    const media = await up.json();
    assert.equal(media.alt, "a pixel");
    assert.ok(media.url.startsWith("http://127.0.0.1:1/inkwire-media/"));
    const name = new URL(media.url).pathname.replace("/inkwire-media/", "");
    const served = await fetch(`${base}/inkwire-media/${name}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
    const sidecar = readdirSync(path.join(root, "media")).find((f) => f.endsWith(".meta.json"));
    assert.ok(sidecar);
    assert.equal((await fetch(`${base}/inkwire-media/${sidecar}`)).status, 404);
  });

  it("uses INKWIRE_URL_TEMPLATE for the public address of an entry", async () => {
    const { base } = await boot({ INKWIRE_URL_TEMPLATE: "https://site.test/blog/{slug}" });
    const made = await (await post(`${base}/api/content`, entry("tpl"))).json();
    assert.equal(made.url, `https://site.test/blog/${made.slug}`);
  });

  it("advertises only the kinds and limits it was configured with", async () => {
    const { base } = await boot({ INKWIRE_KINDS: "post, note", INKWIRE_SITE_NAME: "Mine" });
    const d = await (await fetch(`${base}/api/inkwire`, { headers: KEY })).json();
    assert.deepEqual(d.kinds, ["post", "note"]);
    assert.equal(d.site.name, "Mine");
    assert.equal(d.limits.media_bytes, 2000);
    assert.ok(d.features.includes("media"));
  });
});

describe("environment", () => {
  it("refuses a half-configured GitHub store instead of silently writing to disk", () => {
    assert.throws(() => buildReceiver({ INKWIRE_API_KEYS: "k", INKWIRE_GITHUB_TOKEN: "t" }), /must be set together/);
    assert.throws(() => buildReceiver({ INKWIRE_API_KEYS: "k", INKWIRE_GITHUB_REPO: "a/b" }), /must be set together/);
    assert.throws(() => buildReceiver({ INKWIRE_API_KEYS: "k", INKWIRE_GITHUB_REPO: "ab", INKWIRE_GITHUB_TOKEN: "t" }), /owner\/name/);
  });

  it("GitHub store: media is off until INKWIRE_MEDIA_URL_BASE is a public absolute address", () => {
    const base = { INKWIRE_API_KEYS: "k", INKWIRE_GITHUB_REPO: "o/r", INKWIRE_GITHUB_TOKEN: "t" };
    const off = buildReceiver(base);
    assert.equal(off.config.features?.includes("media"), false);
    assert.equal(off.store.saveMedia, undefined);
    assert.equal(off.mediaDir, null);
    const on = buildReceiver({ ...base, INKWIRE_MEDIA_URL_BASE: "https://cdn.example.com/m" });
    assert.equal(on.config.features?.includes("media"), true);
    assert.equal(typeof on.store.saveMedia, "function");
  });

  it("falls back to sane limits for junk numbers and defaults the kinds", () => {
    const r = buildReceiver({ INKWIRE_API_KEYS: "k", INKWIRE_MEDIA_LIMIT_BYTES: "abc", INKWIRE_MARKDOWN_LIMIT_BYTES: "-5" });
    assert.deepEqual(r.config.limits, { markdown_bytes: 1_000_000, media_bytes: 10_000_000 });
    assert.deepEqual(r.config.kinds, ["post", "page"]);
  });
});

describe("the fetch-by-url guard", () => {
  const cases: [string, boolean][] = [
    ["8.8.8.8", true],
    ["93.184.216.34", true],
    ["2606:4700:4700::1111", true],
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.16.0.1", false],
    ["172.32.0.1", true],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["::1", false],
    ["::", false],
    ["fe80::1", false],
    ["fc00::1", false],
    ["fd12:3456::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:7f00:1", false],
    ["::ffff:8.8.8.8", true],
    ["64:ff9b::7f00:1", false],
    ["2002:7f00:1::1", false],
    ["2001:db8::1", false],
    ["not-an-ip", false],
    ["1.2.3", false],
  ];
  for (const [ip, expected] of cases) {
    it(`${ip} is ${expected ? "public" : "refused"}`, () => assert.equal(isPublicAddress(ip), expected));
  }

  const refuses = async (url: string, why: RegExp) =>
    assert.rejects(fetchPublicImage(url, 1000), (e: Error) => {
      assert.match(e.message, why);
      return true;
    });
  it("refuses loopback, private, link-local and literal-IPv6 targets before connecting", async () => {
    await refuses("http://127.0.0.1/x.png", /private/);
    await refuses("http://localhost/x.png", /private/);
    await refuses("http://169.254.169.254/latest/meta-data", /private/);
    await refuses("http://[::1]/x.png", /private/);
    await refuses("http://[::ffff:10.0.0.1]/x.png", /private/);
    await refuses("http://2130706433/x.png", /private/); // decimal 127.0.0.1, normalised by URL
  });
  it("refuses non-http schemes, credentials, odd ports and junk", async () => {
    await refuses("file:///etc/passwd", /http or https/);
    await refuses("ftp://example.com/x.png", /http or https/);
    await refuses("http://user:pw@example.com/x.png", /credentials/);
    await refuses("http://example.com:22/x.png", /port 80 or 443/);
    await refuses("not a url", /not a valid URL/);
  });
});

describe("the fetch-by-url guard, against a faked network", () => {
  type Reply = { status: number; headers?: Record<string, string>; body?: Buffer | Buffer[] };
  const realRequest = http.request;
  const realLookup = dns.promises.lookup;
  const seen: { host: string; path: string; pinned?: string }[] = [];

  function network(hosts: Record<string, string[]>, replies: (host: string, path: string) => Reply) {
    seen.length = 0;
    (dns.promises as { lookup: unknown }).lookup = async (host: string) => {
      if (!hosts[host]) throw new Error("ENOTFOUND");
      return hosts[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    };
    (http as { request: unknown }).request = (opts: { hostname: string; path: string; lookup: (...a: unknown[]) => void }, cb: (r: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: () => void; destroy: () => void };
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        let pinned: string | undefined;
        opts.lookup(opts.hostname, {}, (_e: unknown, address: string) => (pinned = address));
        seen.push({ host: opts.hostname, path: opts.path, pinned });
        const r = replies(opts.hostname, opts.path);
        const res = Readable.from(Array.isArray(r.body) ? r.body : [r.body ?? Buffer.alloc(0)]) as Readable & { statusCode: number; headers: Record<string, string> };
        res.statusCode = r.status;
        res.headers = r.headers ?? {};
        process.nextTick(() => cb(res));
      };
      return req;
    };
  }
  const restore = () => {
    (http as { request: unknown }).request = realRequest;
    (dns.promises as { lookup: unknown }).lookup = realLookup;
  };

  it("fetches a public host, pinning the connection to the address it checked", async () => {
    network({ "cdn.test": ["93.184.216.34"] }, () => ({ status: 200, headers: { "content-type": "image/png; charset=x" }, body: PNG }));
    try {
      const got = await fetchPublicImage("http://cdn.test/a/pic%20one.png?v=1", 1000);
      assert.deepEqual(Buffer.from(got.bytes), PNG);
      assert.equal(got.contentType, "image/png");
      assert.equal(got.filename, "pic one.png");
      assert.deepEqual(seen, [{ host: "cdn.test", path: "/a/pic%20one.png?v=1", pinned: "93.184.216.34" }]);
    } finally {
      restore();
    }
  });

  it("refuses a name when ANY of its addresses is private (DNS answers are all-or-nothing)", async () => {
    network({ "mixed.test": ["93.184.216.34", "10.0.0.5"] }, () => ({ status: 200, body: PNG }));
    try {
      await assert.rejects(fetchPublicImage("http://mixed.test/x.png", 1000), /private/);
      assert.equal(seen.length, 0);
    } finally {
      restore();
    }
  });

  it("follows redirects but re-checks every hop, and stops after three", async () => {
    network({ "a.test": ["93.184.216.34"], "b.test": ["93.184.216.35"], "evil.test": ["169.254.169.254"] }, (host, p) => {
      if (host === "a.test" && p === "/go") return { status: 302, headers: { location: "http://b.test/real.png" } };
      if (host === "a.test" && p === "/evil") return { status: 301, headers: { location: "http://evil.test/meta" } };
      if (host === "a.test" && p === "/loop") return { status: 302, headers: { location: "/loop" } };
      return { status: 200, headers: { "content-type": "image/png" }, body: PNG };
    });
    try {
      const ok = await fetchPublicImage("http://a.test/go", 1000);
      assert.equal(ok.filename, "real.png");
      await assert.rejects(fetchPublicImage("http://a.test/evil", 1000), /private/);
      await assert.rejects(fetchPublicImage("http://a.test/loop", 1000), /too many times/);
    } finally {
      restore();
    }
  });

  it("caps the size by content-length and by what actually streams, and reports other statuses", async () => {
    network({ "big.test": ["93.184.216.34"] }, (_h, p) => {
      if (p === "/declared") return { status: 200, headers: { "content-length": "999999" }, body: PNG };
      if (p === "/streamed") return { status: 200, body: [Buffer.alloc(600), Buffer.alloc(600)] };
      return { status: 404 };
    });
    try {
      await assert.rejects(fetchPublicImage("http://big.test/declared", 1000), /over the limit/);
      await assert.rejects(fetchPublicImage("http://big.test/streamed", 1000), /over the limit/);
      await assert.rejects(fetchPublicImage("http://big.test/missing", 1000), /answered 404/);
    } finally {
      restore();
    }
  });
});
