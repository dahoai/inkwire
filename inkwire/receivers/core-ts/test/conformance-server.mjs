// Test-only HTTP server: mounts the core's handlers on node:http over a FileStore in a temp dir.
// Run by `npm run conformance` (test/run-conformance.mjs). Needs `npm run build` first.
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FileStore,
  discoveryBody,
  handleDelete,
  handleDiscovery,
  handleGet,
  handleList,
  handleMedia,
  handleMediaList,
  handleMediaUpdate,
  handleTerms,
  handlePatch,
  handleUpsert,
  parseApiKeys,
} from "../dist/index.js";

// A 1x1 PNG, served for the one URL the conformance case asks for. Stands in for an SSRF-guarded fetch.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function createInkwireServer({ root = mkdtempSync(path.join(tmpdir(), "inkwire-")), port = 0 } = {}) {
  const keys = parseApiKeys(process.env.INKWIRE_API_KEYS ?? "dev-key,audit-key:ro");
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  const config = {
    site: { name: "Conformance", url: "https://conformance.test" },
    kinds: ["post", "page"],
    limits: { markdown_bytes: 100_000, media_bytes: 1_000_000 },
    async fetchMedia(url) {
      if (url === "https://example.test/imgs/ok.png") return { bytes: PNG, contentType: "image/png", filename: "ok.png" };
      throw new Error("no network in tests");
    },
  };
  const store = new FileStore({ root, mediaUrlBase: "http://127.0.0.1/media" });

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const authHeader = req.headers.authorization;
    const common = { authHeader, keys };
    let out;
    const m = /^\/api\/content\/([^/]+)$/.exec(url.pathname);
    const mm = /^\/api\/media\/([^/]+)$/.exec(url.pathname);
    const id = m ? decodeURIComponent(m[1]) : null;
    const text = rawBody.toString("utf8");
    if (url.pathname === "/api/inkwire" && req.method === "GET") out = await handleDiscovery({ ...common, config, store });
    else if (url.pathname === "/api/content" && req.method === "POST") out = await handleUpsert({ ...common, rawBody: text, store, config });
    else if (url.pathname === "/api/content" && req.method === "GET") out = await handleList({ ...common, query: url.searchParams, store, config });
    else if (id && req.method === "GET") out = await handleGet({ ...common, id, store });
    else if (id && req.method === "PATCH")
      out = await handlePatch({ ...common, id, rawBody: text, ifMatchHeader: req.headers["if-match"], store, config });
    else if (id && req.method === "DELETE") out = await handleDelete({ ...common, id, ifMatchHeader: req.headers["if-match"], store });
    else if (url.pathname === "/api/terms" && req.method === "GET") out = await handleTerms({ ...common, query: url.searchParams, store });
    else if (url.pathname === "/api/media" && req.method === "GET") out = await handleMediaList({ ...common, query: url.searchParams, store });
    else if (mm && req.method === "PATCH") out = await handleMediaUpdate({ ...common, id: decodeURIComponent(mm[1]), rawBody: text, store });
    else if (url.pathname === "/api/media" && req.method === "POST")
      out = await handleMedia({ ...common, contentType: req.headers["content-type"], rawBody, config, store });
    else
      out = {
        status: 404,
        headers: { "Inkwire-Version": "1", "Content-Type": "application/json" },
        body: { error: { code: "not_found", message: "unknown endpoint" } },
      };
    res.writeHead(out.status, out.headers);
    res.end(JSON.stringify(out.body));
  });
  return { server, root, listen: () => new Promise((r) => server.listen(port, "127.0.0.1", () => r(origin()))) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { listen } = createInkwireServer({ port: Number(process.env.PORT ?? 0) });
  console.log(`listening ${await listen()}`);
}
