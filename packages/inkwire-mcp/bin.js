#!/usr/bin/env node
// inkwire-mcp <site url> [--key <key>]: an MCP server (stdio) that edits one Inkwire site.
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { capabilities } from "inkwire-client";
import { createServer } from "./server.js";

const USAGE = `Usage: inkwire-mcp <site url> [--key <key>]

  The key can also come from INKWIRE_KEY (better: it stays out of the process list), the URL from INKWIRE_URL.
  Claude Code:  claude mcp add my-site --env INKWIRE_KEY=<key> -- npx -y inkwire-mcp https://my-site.com`;

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.error(USAGE);
  process.exit(0);
}
const keyAt = args.indexOf("--key");
const key = keyAt >= 0 ? args[keyAt + 1] : process.env.INKWIRE_KEY;
const site = (args.find((a, i) => !a.startsWith("--") && !(keyAt >= 0 && i === keyAt + 1)) ?? process.env.INKWIRE_URL ?? "").replace(/\/+$/, "");
if (!site || !key) {
  console.error(USAGE);
  process.exit(2);
}

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
let caps;
try {
  caps = await capabilities(site, key, { retries: 2 });
} catch (e) {
  // stdout is the MCP channel: everything for people goes to stderr.
  console.error(`inkwire-mcp: ${site} did not answer discovery: ${e.code ?? "error"}: ${e.message}`);
  process.exit(1);
}
await createServer({ site, key, caps, version }).connect(new StdioServerTransport());
