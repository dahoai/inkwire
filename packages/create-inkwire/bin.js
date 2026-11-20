#!/usr/bin/env node
// create-inkwire: add an Inkwire receiver to an existing site in one command.
// Detects the framework, writes the receiver files, generates the keys, prints what to do next.
// Never prompts (safe in CI); never overwrites a file or a key that is already there.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = JSON.parse(readFileSync(path.join(HERE, "package.json"), "utf8"));
const DEFAULT_CORE_SPEC = "^0.3.0";
const INSTALL_URL = "https://github.com/dahoai/inkwire/blob/master/INSTALL.md";

const HELP = `create-inkwire ${SELF.version}

Usage: npx create-inkwire [options]   (run inside your project)

  --framework <next|express|fastapi>  Skip detection (default: read package.json / pyproject / requirements)
  --root <dir>                        Where content lives as markdown files (default ./content)
  --site-url <url>                    The public address of the site (default http://localhost:3000)
  --dir <dir>                         The project directory (default: the current one)
  --yes                               Accepted for scripts; create-inkwire never prompts
  --no-install                        Do not run the package manager
  --core-spec <spec>                  Version or path of inkwire-receiver-core to depend on (default ${DEFAULT_CORE_SPEC})
  --force                             Overwrite receiver files that already exist
  -h, --help | -v, --version
`;

const VALUE_FLAGS = new Set(["framework", "root", "site-url", "dir", "core-spec"]);
const BOOL_FLAGS = new Set(["yes", "y", "no-install", "force", "help", "h", "version", "v"]);

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--?([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) {
      out._.push(a);
      continue;
    }
    const [, name, inline] = m;
    if (VALUE_FLAGS.has(name)) {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
      out[name] = v;
    } else if (BOOL_FLAGS.has(name)) out[name] = true;
    else throw new Error(`unknown option ${a} (see --help)`);
  }
  return out;
}

const readText = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const isDir = (d) => {
  try {
    return statSync(d).isDirectory();
  } catch {
    return false;
  }
};
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : [f];
  });

export function detectFramework(dir) {
  const pkg = readJson(path.join(dir, "package.json"));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps.next) return "next";
  if (deps.express) return "express";
  for (const marker of ["pyproject.toml", "requirements.txt"]) {
    if (/fastapi/i.test(readText(path.join(dir, marker)) ?? "")) return "fastapi";
  }
  return null;
}

function packageManager(dir) {
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(dir, "bun.lock")) || existsSync(path.join(dir, "bun.lockb"))) return "bun";
  return "npm";
}

/** package.json with one added dependency, keeping the file's indentation. Returns false when already there. */
function addDependency(dir, name, spec) {
  const file = path.join(dir, "package.json");
  const raw = readText(file);
  if (raw === null) return false;
  const pkg = JSON.parse(raw);
  if (pkg.dependencies?.[name] || pkg.devDependencies?.[name]) return false;
  const indent = /^\t/m.test(raw) ? "\t" : (/^( +)"/m.exec(raw)?.[1].length ?? 2);
  pkg.dependencies = Object.fromEntries(Object.entries({ ...(pkg.dependencies ?? {}), [name]: spec }).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file, JSON.stringify(pkg, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
  return true;
}

/** Appends to an env file; leaves it alone when it already defines INKWIRE_API_KEYS. */
function appendEnv(file, lines) {
  const existing = readText(file) ?? "";
  if (/^\s*INKWIRE_API_KEYS\s*=/m.test(existing)) return false;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : existing.length > 0 ? "\n" : "";
  writeFileSync(file, existing + prefix + lines.join("\n") + "\n");
  return true;
}

/** Makes sure git will not pick up the env file that now holds the keys. */
function ignoreInGit(dir, name) {
  const file = path.join(dir, ".gitignore");
  const text = readText(file) ?? "";
  const covered = text.split(/\r?\n/).some((l) => {
    const t = l.trim();
    return t === name || t === `/${name}` || t === ".env*" || t === ".env.*" || t === "*.local" || (name === ".env.local" && t === ".env.local");
  });
  if (covered) return false;
  writeFileSync(file, text + (text && !text.endsWith("\n") ? "\n" : "") + `${name}\n`);
  return true;
}

function copyTemplate(from, to, force) {
  if (existsSync(to) && !force) return "exists";
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
  return "written";
}

export function run(argv, { log = (s) => process.stdout.write(s + "\n"), warn = (s) => process.stderr.write(s + "\n") } = {}) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    log(HELP);
    return 0;
  }
  if (args.version || args.v) {
    log(SELF.version);
    return 0;
  }

  const dir = path.resolve(args.dir ?? ".");
  if (!isDir(dir)) {
    warn(`${dir} is not a directory`);
    return 1;
  }
  const framework = args.framework ?? detectFramework(dir);
  if (!framework) {
    warn(
      "Could not tell which framework this is: no next or express in package.json, and no fastapi in pyproject.toml or requirements.txt.\n" +
        "Run it from your project folder, or choose one: npx create-inkwire --framework next|express|fastapi",
    );
    return 1;
  }
  if (!["next", "express", "fastapi"].includes(framework)) {
    warn(`Unknown framework "${framework}". Use next, express or fastapi.`);
    return 1;
  }
  if (framework === "fastapi") {
    log(
      "FastAPI: there is no generator for it yet; the steps are manual.\n\n" +
        "  1. pip install \"inkwire-receiver-core[fastapi]\" uvicorn\n" +
        "  2. Environment: INKWIRE_API_KEYS=<full key>,<read-only key>:ro  INKWIRE_KINDS=post,page  INKWIRE_ROOT=./content\n" +
        "     INKWIRE_SITE_URL=https://your-site  INKWIRE_URL_TEMPLATE={site}/blog/{slug}\n" +
        "     Make the keys with: python3 -c \"import secrets; print(secrets.token_hex(24))\"\n" +
        "  3. Run the receiver (all routes, file store, media): uvicorn inkwire_receiver.app:create_app --factory\n" +
        "  4. Check GET /api/inkwire with the key as a Bearer token.\n\n" +
        `Full walk-through: ${INSTALL_URL}`,
    );
    return 0;
  }

  const root = args.root ?? "./content";
  const siteUrl = (args["site-url"] ?? "http://localhost:3000").replace(/\/+$/, "");
  const coreSpec = args["core-spec"] ?? DEFAULT_CORE_SPEC;
  const force = Boolean(args.force);
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg) {
    warn(`No package.json in ${dir}: run this from the root of your ${framework === "next" ? "Next.js" : "Express"} project.`);
    return 1;
  }

  const written = [];
  const kept = [];
  const note = (rel, state) => (state === "written" ? written : kept).push(rel);
  let wiring = "";
  let envFile;

  if (framework === "next") {
    const appDir = isDir(path.join(dir, "src", "app")) || (isDir(path.join(dir, "src")) && !isDir(path.join(dir, "app"))) ? path.join("src", "app") : "app";
    const tpl = path.join(HERE, "templates", "next-app");
    for (const abs of walk(tpl)) {
      const rel = path.join(appDir, path.relative(tpl, abs));
      note(rel, copyTemplate(abs, path.join(dir, rel), force));
    }
    envFile = ".env.local";
  } else {
    const ts = existsSync(path.join(dir, "tsconfig.json"));
    const esm = pkg.type === "module";
    const where = isDir(path.join(dir, "src")) ? "src" : ".";
    const file = ts ? "inkwire-router.ts" : "inkwire-router.mjs";
    const rel = path.join(where, file);
    note(rel, copyTemplate(path.join(HERE, "templates", "express", file), path.join(dir, rel), force));
    const from = "./"; // relative to a file next to the router; adjust if your app file lives elsewhere
    if (ts) {
      const spec = `${from}inkwire-router${esm ? ".js" : ""}`;
      wiring =
        `  import { createInkwireRouter } from "${spec}"\n  app.use(createInkwireRouter())\n` +
        (esm ? "" : "  (Node 22.12+ is needed to load the ESM-only inkwire-receiver-core from CommonJS output; or set \"type\": \"module\".)\n");
    } else if (esm) {
      wiring = `  import { createInkwireRouter } from "${from}inkwire-router.mjs"\n  app.use(createInkwireRouter())\n`;
    } else {
      wiring = `  // CommonJS app: load the ESM file with a dynamic import\n  import("${from}inkwire-router.mjs").then((m) => app.use(m.createInkwireRouter()))\n`;
    }
    wiring += "  (Mount it before your own 404 handler. Load .env with `node --env-file=.env` or dotenv.)\n";
    envFile = ".env";
  }

  mkdirSync(path.join(dir, root), { recursive: true });
  const keep = path.join(dir, root, ".gitkeep");
  if (!existsSync(keep)) writeFileSync(keep, "");

  const depAdded = addDependency(dir, "inkwire-receiver-core", coreSpec);

  const fullKey = randomBytes(24).toString("hex");
  const roKey = randomBytes(24).toString("hex");
  const envWritten = appendEnv(path.join(dir, envFile), [
    "# Inkwire: the first key may read and write, the :ro key may only read.",
    `INKWIRE_API_KEYS=${fullKey},${roKey}:ro`,
    "# The public address of this site; set it to the real one before you deploy.",
    `INKWIRE_SITE_URL=${siteUrl}`,
    `INKWIRE_ROOT=${root}`,
  ]);
  const gitignored = envWritten ? ignoreInGit(dir, envFile) : false;

  log("\nInkwire receiver added.\n");
  for (const f of written) log(`  + ${f}`);
  for (const f of kept) log(`  = ${f} (already there; left as it is, use --force to replace)`);
  log(`  + ${root}/ (entries live here as markdown files)`);
  if (depAdded) log(`  + inkwire-receiver-core in package.json (${coreSpec})`);
  if (envWritten) {
    log(`  + ${envFile} (INKWIRE_API_KEYS, INKWIRE_SITE_URL, INKWIRE_ROOT)`);
    if (gitignored) log(`  + ${envFile} added to .gitignore`);
  } else {
    log(`  = ${envFile} already defines INKWIRE_API_KEYS; keys left as they are`);
  }
  if (wiring) log(`\nWire it in, where you create your Express app:\n${wiring}`);

  if (!args["no-install"] && depAdded) {
    const pm = packageManager(dir);
    log(`Installing (${pm} install)...`);
    const r = spawnSync(pm, ["install"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0) warn(`${pm} install failed: run it yourself, then restart your dev server.`);
  }

  if (envWritten) {
    log(
      `\nKeys (shown once; also in ${envFile}):\n` +
        `  full key       ${fullKey}\n` +
        `  read-only key  ${roKey}\n` +
        "\nNext:\n" +
        `  1. Set INKWIRE_SITE_URL in ${envFile} to this site's real address, then (re)start the site.\n` +
        `  2. Check it: curl -H "Authorization: Bearer ${fullKey}" ${siteUrl}/api/inkwire\n` +
        `  3. In Anaella, connect an Inkwire site: address ${siteUrl}, key = the full key above.\n` +
        `  4. Make the site render what you publish (SEO tags, a /<kind>/<slug> page): ${INSTALL_URL}\n`,
    );
  } else {
    log(`\nNext: connect the site in Anaella with its address and your full key. Rendering notes: ${INSTALL_URL}\n`);
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  }
}
