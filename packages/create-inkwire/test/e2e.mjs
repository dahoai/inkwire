// End to end: for each fixture project, run the real `create-inkwire`, install, boot the site, and run the shared
// black-box conformance runner against it, with the keys and settings create-inkwire itself wrote.
//
//   node test/e2e.mjs [next] [express-esm] [express-ts] [express-cjs]      (default: all)
//
// Needs the registry (installs next/express/tsx into a temp dir) and `inkwire-receiver-core` built
// in ../../inkwire/receivers/core-ts (npm install && npm run build there). Never touches the network otherwise.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, runConformance } from "../../../inkwire/receivers/node-express/test/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "../bin.js");
const CORE = path.resolve(HERE, "../../../inkwire/receivers/core-ts");
const RECEIVERS = path.resolve(HERE, "../../../inkwire/receivers");
const SEO_RUNNER = path.resolve(HERE, "../../../inkwire/conformance/seo-runner.mjs");
const example = (rel) => readFileSync(path.join(RECEIVERS, rel), "utf8");
if (!existsSync(path.join(CORE, "dist/index.js"))) {
  console.error(`build the core first: (cd ${CORE} && npm install && npm run build)`);
  process.exit(2);
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const put = (dir, files) => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), typeof content === "function" ? content() : typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  }
};

const EXPRESS_DEPS = { dependencies: { express: "^5.0.0" } };
const TS_DEPS = { devDependencies: { typescript: "^5.5.0", tsx: "^4.19.0", "@types/node": "^22.5.0", "@types/express": "^5.0.0" } };

const FIXTURES = {
  next: {
    framework: "next",
    envFile: ".env.local",
    seo: true,
    files: {
      "app/blog/[slug]/page.tsx": () => example("nextjs/examples/blog/[slug]/page.tsx"),
      "package.json": {
        name: "fixture-next", private: true,
        dependencies: { next: "^15.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
        devDependencies: { typescript: "^5.5.0", "@types/node": "^22.5.0", "@types/react": "^19.0.0" },
      },
      "app/layout.tsx": "export default function Root({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>;\n}\n",
      "app/page.tsx": "export default function Page() {\n  return <p>hello</p>;\n}\n",
    },
    prepare: (dir) => {
      const r = spawnSync("npx", ["next", "build"], { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`next build failed:\n${r.stdout}\n${r.stderr}`);
    },
    start: { command: "npx", args: ["next", "start", "-p", "{port}"] },
  },
  "express-esm": {
    framework: "express",
    envFile: ".env",
    seo: true,
    files: {
      "package.json": { name: "fixture-express-esm", private: true, type: "module", ...EXPRESS_DEPS },
      "blog.mjs": () => example("node-express/examples/blog.mjs"),
      "server.mjs": 'import express from "express";\nimport { createInkwireRouter } from "./inkwire-router.mjs";\nimport { mountBlog } from "./blog.mjs";\nconst app = express();\napp.use(createInkwireRouter());\nmountBlog(app);\napp.listen(Number(process.env.PORT));\n',
    },
    start: { command: process.execPath, args: ["--env-file=.env", "server.mjs"] },
  },
  "express-ts": {
    framework: "express",
    envFile: ".env",
    files: {
      "package.json": { name: "fixture-express-ts", private: true, type: "module", ...EXPRESS_DEPS, ...TS_DEPS },
      "tsconfig.json": { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true } },
      "server.ts": 'import express from "express";\nimport { createInkwireRouter } from "./inkwire-router.js";\nconst app = express();\napp.use(createInkwireRouter());\napp.listen(Number(process.env.PORT));\n',
    },
    prepare: (dir) => {
      const r = spawnSync("npx", ["tsc", "--noEmit"], { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`the copied TypeScript router does not typecheck in a fresh project:\n${r.stdout}${r.stderr}`);
    },
    start: { command: "npx", args: ["tsx", "--env-file=.env", "server.ts"] },
  },
  "express-cjs": {
    framework: "express",
    envFile: ".env",
    files: {
      "package.json": { name: "fixture-express-cjs", private: true, ...EXPRESS_DEPS },
      "server.js": 'const express = require("express");\nconst app = express();\nimport("./inkwire-router.mjs").then((m) => {\n  app.use(m.createInkwireRouter());\n  app.listen(Number(process.env.PORT));\n});\n',
    },
    start: { command: process.execPath, args: ["--env-file=.env", "server.js"] },
  },
};

async function one(name) {
  const f = FIXTURES[name];
  const dir = mkdtempSync(path.join(tmpdir(), `inkwire-e2e-${name}-`));
  put(dir, f.files);
  console.log(`\n=== ${name}: ${dir}`);

  const made = spawnSync(process.execPath, [BIN, "--dir", dir, "--yes", "--core-spec", `file:${CORE}`], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`create-inkwire exited ${made.status}:\n${made.stdout}\n${made.stderr}`);
  if (!new RegExp(`framework|Inkwire receiver added`).test(made.stdout)) throw new Error(`unexpected output:\n${made.stdout}`);
  const env = readFileSync(path.join(dir, f.envFile), "utf8");
  const keys = /^INKWIRE_API_KEYS=([0-9a-f]{48}),([0-9a-f]{48}):ro$/m.exec(env);
  if (!keys) throw new Error(`no keys in ${f.envFile}:\n${env}`);
  if (!made.stdout.includes(keys[1]) || !made.stdout.includes(keys[2])) throw new Error("the keys were not printed");
  f.prepare?.(dir);

  // A hand-written file that was there before Inkwire: it must show up as a first-class entry.
  put(dir, { "content/post/hand-written.md": "# A page somebody wrote by hand\n\nNo frontmatter at all.\n" });

  const checks = async ({ base, key }) => {
    const auth = { authorization: `Bearer ${key}` };
    const list = await (await fetch(`${base}/api/content?search=by%20hand`, { headers: auth })).json();
    if (!list.items?.some((i) => i.id === "post.hand-written" && i.external_id === null)) throw new Error(`hand-written file not listed: ${JSON.stringify(list)}`);
    const fd = new FormData();
    fd.append("file", new Blob([PNG], { type: "image/png" }), "px.png");
    const up = await fetch(`${base}/api/media`, { method: "POST", headers: auth, body: fd });
    if (up.status !== 200) throw new Error(`upload answered ${up.status}`);
    const { url } = await up.json();
    const served = await fetch(base + new URL(url).pathname);
    if (served.status !== 200 || served.headers.get("content-type") !== "image/png") throw new Error(`uploaded image not served at ${url} (${served.status})`);
    if (!Buffer.from(await served.arrayBuffer()).equals(PNG)) throw new Error("served image bytes differ");
    const sidecar = readdirSync(path.join(dir, "content/media")).find((n) => n.endsWith(".meta.json"));
    if (sidecar && (await fetch(`${base}${new URL(url).pathname.replace(/[^/]+$/, sidecar)}`)).status === 200) throw new Error("the .meta.json sidecar is publicly readable");
    if (!readdirSync(path.join(dir, "content/post")).some((n) => n !== "hand-written.md" && n.endsWith(".md"))) throw new Error("published entries are not files under content/post");
    let more = "extra checks: hand-written file listed, upload stored and served, sidecar private, entries are files\n";
    if (f.seo) {
      const seo = spawnSync(process.execPath, [SEO_RUNNER], { env: { ...process.env, BASE_URL: base, API_KEY: key }, encoding: "utf8" });
      if (seo.status !== 0) throw new Error(`SEO rendering conformance failed:\n${seo.stdout}${seo.stderr}`);
      more += `seo-runner: ${seo.stdout.trim().split("\n").join(" | ")}\n`;
    }
    return more;
  };

  const port = await freePort();
  const runEnv = f.seo ? { INKWIRE_SITE_URL: `http://127.0.0.1:${port}`, INKWIRE_URL_TEMPLATE: "{site}/blog/{slug}" } : {};

  const { code, output } = await runConformance({
    ...f.start, cwd: dir, port, env: runEnv, projectEnv: true, keys: { full: keys[1], ro: keys[2] }, checks,
  });
  console.log(output.split("\n").filter((l) => !l.startsWith("PASS ")).join("\n"));
  return code === 0 && /\b56 passed, 0 skipped, 0 failed/.test(output);
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(FIXTURES);
let allOk = true;
for (const name of wanted) {
  if (!FIXTURES[name]) {
    console.error(`unknown fixture ${name}`);
    process.exit(2);
  }
  let ok = false;
  try {
    ok = await one(name);
  } catch (e) {
    console.error(e.message);
  }
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  allOk &&= ok;
}
process.exit(allOk ? 0 : 1);
