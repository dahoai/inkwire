import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { FileStore, GitHubStore, MemoryStore } from "../src/index.js";
import { runStoreContract } from "../src/testing.js";
import { TOKEN, fakeGitHub } from "./fake-github.js";

runStoreContract({
  name: "MemoryStore",
  describe,
  test,
  create: async () => ({ store: new MemoryStore() }),
});

runStoreContract({
  name: "FileStore",
  scoped: false,
  opaqueIds: false,
  describe,
  test,
  create: async () => {
    const root = mkdtempSync(path.join(tmpdir(), "inkwire-contract-"));
    return { store: new FileStore({ root, mediaUrlBase: "https://site.test/media" }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
  },
});

runStoreContract({
  name: "GitHubStore (fake GitHub)",
  scoped: false,
  opaqueIds: false,
  describe,
  test,
  create: async () => {
    const gh = fakeGitHub();
    return {
      store: new GitHubStore({ owner: "acme", repo: "site", branch: "main", dir: "content", token: TOKEN, mediaUrlBase: "https://site.test/media", fetch: gh.fetchFn }),
    };
  },
});
