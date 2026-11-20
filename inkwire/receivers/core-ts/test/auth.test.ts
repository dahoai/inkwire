import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseApiKeys, authorize, requireWrite } from "../src/auth.js";
import { InkwireError } from "../src/errors.js";

describe("auth", () => {
  it("parseApiKeys trims, skips empties, and marks :ro keys", () => {
    const keys = parseApiKeys("  dev-key , audit-key:ro , , another-key  ");
    assert.deepEqual(keys, [
      { key: "dev-key", ro: false, scope: "default" },
      { key: "audit-key", ro: true, scope: "default" },
      { key: "another-key", ro: false, scope: "default" },
    ]);
  });

  it("authorize accepts matching full key and ro key", () => {
    const keys = parseApiKeys("dev-key,audit-key:ro");
    const authed1 = authorize("Bearer dev-key", keys);
    assert.equal(authed1.key, "dev-key");
    assert.equal(authed1.ro, false);

    const authed2 = authorize("Bearer audit-key", keys);
    assert.equal(authed2.key, "audit-key");
    assert.equal(authed2.ro, true);
  });

  it("authorize throws 401 on missing or wrong key", () => {
    const keys = parseApiKeys("dev-key,audit-key:ro");
    assert.throws(() => authorize(undefined, keys), (err: any) => err instanceof InkwireError && err.code === "unauthorized");
    assert.throws(() => authorize("Bearer wrong-key", keys), (err: any) => err instanceof InkwireError && err.code === "unauthorized");
    assert.throws(() => authorize("Basic dXNlcjpwYXNz", keys), (err: any) => err instanceof InkwireError && err.code === "unauthorized");
  });

  it("requireWrite passes for full key and throws 403 for ro key", () => {
    const keys = parseApiKeys("dev-key,audit-key:ro");
    const full = authorize("Bearer dev-key", keys);
    const ro = authorize("Bearer audit-key", keys);

    assert.doesNotThrow(() => requireWrite(full));
    assert.throws(() => requireWrite(ro), (err: any) => err instanceof InkwireError && err.code === "forbidden");
  });
});
