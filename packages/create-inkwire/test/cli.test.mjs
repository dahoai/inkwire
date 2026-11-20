import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { detectFramework, parseArgs, run } from "../bin.js";

const project = (files = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "create-inkwire-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  }
  return dir;
};
const go = (dir, ...flags) => {
  const out = [];
  const err = [];
  const code = run(["--dir", dir, "--no-install", "--yes", ...flags], { log: (s) => out.push(s), warn: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};
const read = (dir, f) => readFileSync(path.join(dir, f), "utf8");
const keysIn = (text) => /^INKWIRE_API_KEYS=([0-9a-f]{48}),([0-9a-f]{48}):ro$/m.exec(text)?.slice(1);

describe("arguments", () => {
  it("parses flags with a separate or inline value", () => {
    assert.deepEqual(parseArgs(["--framework", "next", "--root=./docs", "--yes"]), { _: [], framework: "next", root: "./docs", yes: true });
  });
  it("rejects unknown options and missing values", () => {
    assert.throws(() => parseArgs(["--wat"]), /unknown option/);
    assert.throws(() => parseArgs(["--framework"]), /needs a value/);
    assert.throws(() => parseArgs(["--framework", "--yes"]), /needs a value/);
  });
});

describe("detection", () => {
  it("next beats express; fastapi is read from pyproject or requirements", () => {
    assert.equal(detectFramework(project({ "package.json": { dependencies: { next: "15", express: "5" } } })), "next");
    assert.equal(detectFramework(project({ "package.json": { devDependencies: { express: "5" } } })), "express");
    assert.equal(detectFramework(project({ "requirements.txt": "FastAPI==0.115\nuvicorn" })), "fastapi");
    assert.equal(detectFramework(project({ "pyproject.toml": 'dependencies = ["fastapi>=0.115"]' })), "fastapi");
    assert.equal(detectFramework(project({ "package.json": { dependencies: { react: "19" } } })), null);
  });
});

describe("next", () => {
  const next = () => project({ "package.json": { name: "site", dependencies: { next: "^15.0.0" } }, ".gitignore": "node_modules\n" });

  it("writes the routes, the dependency, the content folder, the keys and the gitignore line", () => {
    const dir = next();
    const r = go(dir);
    assert.equal(r.code, 0, r.err);
    for (const f of ["app/api/_inkwire/config.ts", "app/api/content/route.ts", "app/api/content/[id]/route.ts", "app/api/media/route.ts", "app/api/inkwire/route.ts", "app/inkwire-media/[...path]/route.ts"]) {
      assert.ok(existsSync(path.join(dir, f)), f);
    }
    assert.ok(existsSync(path.join(dir, "content/.gitkeep")));
    assert.equal(JSON.parse(read(dir, "package.json")).dependencies["inkwire-receiver-core"], "^0.3.0");
    const env = read(dir, ".env.local");
    const keys = keysIn(env);
    assert.ok(keys && keys[0] !== keys[1]);
    assert.match(env, /INKWIRE_SITE_URL=http:\/\/localhost:3000/);
    assert.match(read(dir, ".gitignore"), /^\.env\.local$/m);
    assert.ok(r.out.includes(keys[0]) && r.out.includes(keys[1]), "keys are printed");
    assert.match(r.out, /INSTALL\.md/);
    assert.match(r.out, /Anaella/);
  });

  it("uses src/app when the project has a src folder", () => {
    const dir = project({ "package.json": { dependencies: { next: "15" } }, "src/app/page.tsx": "export default () => null\n" });
    go(dir);
    assert.ok(existsSync(path.join(dir, "src/app/api/content/route.ts")));
    assert.equal(existsSync(path.join(dir, "app")), false);
  });

  it("running it twice keeps the keys, the files and the env file as they were", () => {
    const dir = next();
    go(dir);
    const env = read(dir, ".env.local");
    const [fullKey] = keysIn(env);
    writeFileSync(path.join(dir, "app/api/content/route.ts"), "// mine\n");
    const again = go(dir);
    assert.equal(again.code, 0);
    assert.equal(read(dir, ".env.local"), env);
    assert.equal(read(dir, "app/api/content/route.ts"), "// mine\n");
    assert.match(again.out, /already there/);
    assert.equal(again.out.includes(fullKey), false, "an existing key is never printed again");
    go(dir, "--force");
    assert.notEqual(read(dir, "app/api/content/route.ts"), "// mine\n");
  });

  it("appends to an existing .env.local without touching what is in it, and never overwrites keys", () => {
    const dir = project({ "package.json": { dependencies: { next: "15" } }, ".env.local": "DATABASE_URL=x", ".gitignore": ".env*\n" });
    go(dir);
    const env = read(dir, ".env.local");
    assert.ok(env.startsWith("DATABASE_URL=x\n"));
    assert.ok(keysIn(env));
    assert.equal(read(dir, ".gitignore"), ".env*\n");
    const mine = project({ "package.json": { dependencies: { next: "15" } }, ".env.local": "INKWIRE_API_KEYS=mine\n" });
    const r = go(mine);
    assert.equal(read(mine, ".env.local"), "INKWIRE_API_KEYS=mine\n");
    assert.match(r.out, /already defines INKWIRE_API_KEYS/);
  });

  it("honours --root, --site-url and --core-spec, and keeps the package.json indentation", () => {
    const dir = project({ "package.json": '{\n\t"name": "t",\n\t"dependencies": {\n\t\t"next": "15"\n\t}\n}\n' });
    go(dir, "--root", "./posts", "--site-url", "https://s.test/", "--core-spec", "file:../core");
    assert.ok(existsSync(path.join(dir, "posts/.gitkeep")));
    const env = read(dir, ".env.local");
    assert.match(env, /INKWIRE_ROOT=\.\/posts/);
    assert.match(env, /INKWIRE_SITE_URL=https:\/\/s\.test$/m);
    const pkg = read(dir, "package.json");
    assert.match(pkg, /^\t"dependencies"/m);
    assert.equal(JSON.parse(pkg).dependencies["inkwire-receiver-core"], "file:../core");
  });
});

describe("express", () => {
  it("plain CommonJS gets the .mjs router and a dynamic-import wiring line", () => {
    const dir = project({ "package.json": { dependencies: { express: "^5.0.0" } } });
    const r = go(dir);
    assert.ok(existsSync(path.join(dir, "inkwire-router.mjs")));
    assert.match(r.out, /import\("\.\/inkwire-router\.mjs"\)/);
    assert.ok(keysIn(read(dir, ".env")));
  });
  it("an ESM project imports the .mjs router; a TypeScript one gets the .ts router", () => {
    const esm = project({ "package.json": { type: "module", dependencies: { express: "5" } } });
    assert.match(go(esm).out, /import \{ createInkwireRouter \} from "\.\/inkwire-router\.mjs"/);
    const ts = project({ "package.json": { type: "module", dependencies: { express: "5" } }, "tsconfig.json": "{}", "src/index.ts": "" });
    const r = go(ts);
    assert.ok(existsSync(path.join(ts, "src/inkwire-router.ts")));
    assert.match(r.out, /from "\.\/inkwire-router\.js"/);
  });
});

describe("other outcomes", () => {
  it("fastapi prints manual steps and writes nothing", () => {
    const dir = project({ "requirements.txt": "fastapi\n" });
    const r = go(dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /pip install "inkwire-receiver-core\[fastapi\]"/);
    assert.match(r.out, /uvicorn inkwire_receiver\.app:create_app --factory/);
    assert.equal(existsSync(path.join(dir, ".env")), false);
  });
  it("an unrecognised project exits non-zero with a clear message", () => {
    const r = go(project({ "package.json": { dependencies: { react: "19" } } }));
    assert.equal(r.code, 1);
    assert.match(r.err, /Could not tell which framework/);
    assert.match(r.err, /--framework/);
  });
  it("a bad --framework or a missing package.json is refused", () => {
    assert.equal(go(project(), "--framework", "rails").code, 1);
    const r = go(project(), "--framework", "next");
    assert.equal(r.code, 1);
    assert.match(r.err, /No package\.json/);
  });
});
