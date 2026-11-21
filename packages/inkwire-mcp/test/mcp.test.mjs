// Drives the real CLI over stdio with the MCP SDK's client, against the reference receiver
// (core-ts's test server over a file store). Needs core-ts built: (cd inkwire/receivers/core-ts && npm run build).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "../bin.js");
const { createInkwireServer } = await import(path.resolve(HERE, "../../../inkwire/receivers/core-ts/test/conformance-server.mjs"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function connect(site, key) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, site], env: { ...process.env, INKWIRE_KEY: key }, stderr: "pipe" }));
  return client;
}
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const body = res.content[0].text;
  return { error: res.isError === true, body, json: res.isError ? null : JSON.parse(body) };
};

describe("inkwire-mcp against a full receiver", () => {
  let receiver, site, client, ro;
  before(async () => {
    receiver = createInkwireServer();
    site = await receiver.listen();
    client = await connect(site, "dev-key");
    ro = await connect(site, "audit-key");
  });
  after(async () => {
    await client?.close();
    await ro?.close();
    receiver?.server.close();
  });

  test("offers one tool per feature the site advertises", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["create", "delete", "get", "list", "list_images", "site", "terms", "update", "update_image", "upload_image"]);
    const create = (await client.listTools()).tools.find((t) => t.name === "create");
    assert.deepEqual(create.inputSchema.properties.kind.enum, ["post", "page"], "kinds come from discovery");
  });

  test("create, preview an edit (nothing written), apply it, delete", async () => {
    const created = await call(client, "create", { title: "Pricing", markdown: "# Pricing\n\nOur plans start at $10.\n", kind: "page" });
    assert.equal(created.error, false, created.body);
    assert.equal(created.json.status, "draft", "new entries start as drafts");
    const { id } = created.json;

    const preview = await call(client, "update", {
      id,
      edits: [{ find: "start at $10", replace: "start at $12" }],
      seo: { description: "Plans from $12 a month." },
      dry_run: true,
    });
    assert.equal(preview.error, false, preview.body);
    assert.deepEqual(preview.json.changes.markdown, { edits: [{ before: "start at $10", after: "start at $12" }] });
    assert.equal(preview.json.changes["seo.description"].after, "Plans from $12 a month.");
    assert.match((await call(client, "get", { id })).json.markdown, /\$10/, "a dry run writes nothing");

    const applied = await call(client, "update", { id, edits: [{ find: "start at $10", replace: "start at $12" }], seo: { description: "Plans from $12 a month." } });
    assert.equal(applied.error, false, applied.body);
    const now = (await call(client, "get", { id })).json;
    assert.match(now.markdown, /start at \$12/);
    assert.equal(now.seo.description, "Plans from $12 a month.");

    const again = await call(client, "update", { id, edits: [{ find: "start at $10", replace: "x" }] });
    assert.equal(again.error, true);
    assert.match(again.body, /^edit_not_found: .*Copy `find` exactly/);

    const listed = await call(client, "list", { search: "Pricing" });
    assert.ok(listed.json.items.some((i) => i.id === id));

    assert.equal((await call(client, "delete", { id })).error, false);
    assert.match((await call(client, "get", { id })).body, /^not_found/);
  });

  test("a future published_at schedules only where the site says it can", async () => {
    // The test receiver does not advertise `schedule`: publishing in the future would publish now.
    const res = await call(client, "create", { title: "Later", markdown: "Soon.", status: "published", published_at: "2999-01-01T00:00:00Z" });
    assert.equal(res.error, true);
    assert.match(res.body, /does not schedule/);
  });

  test("images: upload a local file, list it, set its alt text", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "inkwire-mcp-"));
    const file = path.join(dir, "dot.png");
    writeFileSync(file, PNG);
    const up = await call(client, "upload_image", { file, alt: "A white dot" });
    assert.equal(up.error, false, up.body);
    assert.equal(up.json.mime_type, "image/png");
    const listed = await call(client, "list_images", {});
    assert.ok(listed.json.items.some((m) => m.id === up.json.id));
    const changed = await call(client, "update_image", { id: up.json.id, alt: "A single white pixel" });
    assert.equal(changed.json.alt, "A single white pixel");
    assert.match((await call(client, "upload_image", { file: path.join(dir, "notes.txt"), alt: "x" })).body, /not an image/);
  });

  test("a read-only key reads, and every write says why it failed", async () => {
    assert.equal((await call(ro, "list", {})).error, false);
    const res = await call(ro, "create", { title: "Nope", markdown: "x" });
    assert.equal(res.error, true);
    assert.match(res.body, /^forbidden: .*read-only/);
  });
});

test("a receiver without discovery gets only site and create (upsert-only, post only)", async () => {
  const bare = createHttpServer((req, res) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "unknown endpoint" } }));
  });
  await new Promise((r) => bare.listen(0, "127.0.0.1", r));
  const client = await connect(`http://127.0.0.1:${bare.address().port}`, "k");
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ["create", "site"]);
  } finally {
    await client.close();
    bare.close();
  }
});

test("a wrong key stops at startup with a message on stderr", async () => {
  const receiver = createInkwireServer();
  const site = await receiver.listen();
  try {
    // Async: the receiver runs in this process, so a blocking spawn would never get an answer.
    const out = await new Promise((resolve) =>
      execFile(process.execPath, [BIN, site, "--key", "wrong"], { timeout: 20_000 }, (err, stdout, stderr) =>
        resolve({ status: err?.code ?? 0, stdout, stderr })),
    );
    assert.equal(out.status, 1);
    assert.match(out.stderr, /did not answer discovery: unauthorized/);
    assert.equal(out.stdout, "", "stdout stays clean for the MCP channel");
  } finally {
    receiver.server.close();
  }
});
