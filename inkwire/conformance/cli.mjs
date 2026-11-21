#!/usr/bin/env node
// inkwire-conformance <url> --key <full key> [--readonly-key <key>] [--seo]
// Runs the black-box Inkwire v1 suite against a live receiver. Exit code 0 only if nothing failed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: inkwire-conformance <url> --key <full key> [--readonly-key <key>] [--seo [--sitemap]] [--keep]

  <url>             where the receiver lives, e.g. https://site.example (the suite calls <url>/api/inkwire ...)
  --key             an API key that can read and write (or set API_KEY)
  --readonly-key    a read-only key (":ro"); enables the 403 cases (or set READONLY_KEY)
  --seo             also check the public page of a published entry (SEO Profile 1), its old
                    address after a slug change (redirects) and its hreflang (translations)
  --sitemap         with --seo: check the site's /sitemap.xml (or SITEMAP_URL) lists the entries
  --keep            leave the entries the suite created (it deletes them by default)

The suite writes entries and uploads an image. It deletes the entries when it is done (--keep skips that);
an uploaded image cannot be removed through the protocol, so prefer a staging site. A receiver that rate-limits
(429) is waited out, not failed.`;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes("-h") || args.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
const flagValues = new Set(["--key", "--readonly-key"].flatMap((f) => (args.includes(f) ? [args[args.indexOf(f) + 1]] : [])));
const url = args.find((a) => !a.startsWith("--") && !flagValues.has(a)) ?? process.env.BASE_URL;
const key = opt("--key") ?? process.env.API_KEY;
const ro = opt("--readonly-key") ?? process.env.READONLY_KEY;
if (!url || !key) {
  console.error(USAGE);
  process.exit(2);
}
const env = { ...process.env, BASE_URL: url, API_KEY: key, ...(args.includes("--keep") ? { KEEP: "1" } : {}), ...(args.includes("--sitemap") ? { SITEMAP: "1" } : {}), ...(ro ? { READONLY_KEY: ro } : {}) };
const run = (file) => spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], { env, stdio: "inherit" }).status ?? 1;

let code = run("./runner.mjs");
if (args.includes("--seo")) code = run("./seo-runner.mjs") || code;
process.exit(code);
