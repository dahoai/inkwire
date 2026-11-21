// Starts a receiver as a child process, runs the shared black-box conformance runner against it, stops it.
// Used by this package, the Next.js receiver and create-inkwire's end-to-end test.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUNNER = path.resolve(HERE, "../../../conformance/runner.mjs");
export const MEDIA_STUB = path.join(HERE, "media-stub.cjs");

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitFor(url, headers, ms = 90_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url, { headers });
      if (r.status < 500) return;
    } catch {}
    if (Date.now() > until) throw new Error(`receiver did not come up at ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * `projectEnv`: the receiver reads its own env file (keys, root, site url); pass the keys it generated in `keys`.
 * `checks({ base, key })` runs after the runner while the receiver is still up; a throw fails the run.
 * @param {{ command: string, args: string[], cwd: string, env?: Record<string,string>, port?: number,
 *   projectEnv?: boolean, keys?: { full: string, ro: string }, checks?: (c: { base: string, key: string }) => Promise<string|void> }} o
 * @returns {Promise<{ code: number, output: string }>} the runner's exit code and its output
 */
export async function runConformance({ command, args, cwd, env = {}, port, projectEnv = false, keys = { full: "dev-key", ro: "audit-key" }, checks }) {
  port ??= await freePort();
  const root = mkdtempSync(path.join(tmpdir(), "inkwire-conf-"));
  const childEnv = {
    ...process.env,
    PORT: String(port),
    ...(projectEnv ? {} : { INKWIRE_API_KEYS: `${keys.full},${keys.ro}:ro`, INKWIRE_ROOT: root, INKWIRE_SITE_URL: `http://127.0.0.1:${port}` }),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${MEDIA_STUB}`.trim(),
    ...env,
  };
  const server = spawn(command, args.map((a) => a.replace("{port}", String(port))), { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${base}/api/inkwire`, { authorization: `Bearer ${keys.full}` });
    const out = await new Promise((resolve) => {
      const runner = spawn(process.execPath, [RUNNER], {
        // `checks` inspect what the suite wrote (a throwaway directory): keep it until they ran.
        env: { ...process.env, BASE_URL: base, API_KEY: keys.full, READONLY_KEY: keys.ro, ...(checks ? { KEEP: "1" } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      runner.stdout.on("data", (d) => (output += d));
      runner.stderr.on("data", (d) => (output += d));
      runner.on("exit", (code) => resolve({ code: code ?? 1, output }));
    });
    if (out.code === 0 && checks) {
      try {
        const more = await checks({ base, key: keys.full });
        if (more) out.output += more;
      } catch (e) {
        return { code: 1, output: `${out.output}\ncheck failed: ${e.message}\n--- receiver log ---\n${serverLog}` };
      }
    }
    return out;
  } catch (e) {
    return { code: 1, output: `${e.message}\n--- receiver log ---\n${serverLog}` };
  } finally {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  }
}
