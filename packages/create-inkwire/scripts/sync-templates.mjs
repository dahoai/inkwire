// Keeps `templates/` (what create-inkwire copies into a site) identical to the two reference receivers,
// and keeps the shared block (fetch guard + env -> store wiring) identical between them.
//
//   node scripts/sync-templates.mjs           rewrite
//   node scripts/sync-templates.mjs --check   exit 1 if anything is stale (run by `npm test`)
//
// Source of truth: ../../inkwire/receivers/node-express/src/inkwire-router.ts for the shared block and the
// Express receiver; ../../inkwire/receivers/nextjs/app/** for the Next.js receiver.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const RECEIVERS = path.resolve(PKG, "../../inkwire/receivers");
const EXPRESS = path.join(RECEIVERS, "node-express/src/inkwire-router.ts");
const NEXT_APP = path.join(RECEIVERS, "nextjs/app");
const NEXT_CONFIG = path.join(NEXT_APP, "api/_inkwire/config.ts");
const OUT = path.join(PKG, "templates");
const check = process.argv.includes("--check");

const SHARED = /\/\/ <inkwire:shared>[\s\S]*?\/\/ <\/inkwire:shared>\n/;
const stale = [];
const write = (file, text) => {
  const same = existsSync(file) && readFileSync(file, "utf8") === text;
  if (same) return;
  if (check) return stale.push(path.relative(PKG, file));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const express = readFileSync(EXPRESS, "utf8");
const shared = express.match(SHARED)?.[0];
if (!shared) throw new Error("no <inkwire:shared> block in the express receiver");

// 1. The Next.js config carries a copy of the shared block.
const config = readFileSync(NEXT_CONFIG, "utf8");
if (!SHARED.test(config)) throw new Error("no <inkwire:shared> block in the nextjs config");
const nextConfig = config.replace(SHARED, () => shared);
if (nextConfig !== config) {
  if (check) stale.push(path.relative(PKG, NEXT_CONFIG) + " (shared block)");
  else writeFileSync(NEXT_CONFIG, nextConfig);
}

// 2. Templates: Next.js app files are copied as they are.
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : [f];
  });
for (const f of walk(NEXT_APP)) write(path.join(OUT, "next-app", path.relative(NEXT_APP, f)), readFileSync(f, "utf8"));

// 3. Templates: Express as TypeScript, and as plain ESM JavaScript (ts.transpileModule: types removed, nothing else touched).
const BANNER = "// Added by create-inkwire (https://github.com/dahoai/inkwire). Safe to edit; re-running create-inkwire will not overwrite it.\n";
write(path.join(OUT, "express/inkwire-router.ts"), BANNER + express);
const ts = createRequire(import.meta.url)("typescript");
const js = ts.transpileModule(express, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: false, newLine: ts.NewLineKind.LineFeed },
}).outputText;
write(path.join(OUT, "express/inkwire-router.mjs"), BANNER + js);

// 4. INSTALL.md embeds the two verified page examples verbatim, so the docs cannot drift from them.
const INSTALL = path.resolve(PKG, "../../INSTALL.md");
if (existsSync(INSTALL)) {
  const doc = readFileSync(INSTALL, "utf8");
  const next = doc.replace(
    /(<!-- inkwire:example (\S+) -->\n)```(\w+)\n[\s\S]*?```\n(<!-- \/inkwire:example -->)/g,
    (_, open, rel, lang, close) => {
      const source = readFileSync(path.resolve(PKG, "../..", rel), "utf8");
      return `${open}\`\`\`${lang}\n${source.replace(/\n*$/, "\n")}\`\`\`\n${close}`;
    },
  );
  if (next !== doc) {
    if (check) stale.push("INSTALL.md (embedded examples)");
    else writeFileSync(INSTALL, next);
  }
}

if (!check) {
  // drop template files the receivers no longer have
  const want = new Set([...walk(NEXT_APP).map((f) => path.join(OUT, "next-app", path.relative(NEXT_APP, f))), path.join(OUT, "express/inkwire-router.ts"), path.join(OUT, "express/inkwire-router.mjs")]);
  for (const f of walk(OUT)) if (!want.has(f)) rmSync(f);
}
if (check && stale.length) {
  console.error("create-inkwire templates are stale; run `node scripts/sync-templates.mjs`:\n  " + stale.join("\n  "));
  process.exit(1);
}
console.log(check ? "templates are in sync" : "templates synced");
