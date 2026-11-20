// `npm run conformance`: starts the test server on a free port, runs the shared black-box runner
// against it, stops the server, and exits with the runner's status.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInkwireServer } from "./conformance-server.mjs";

const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../conformance/runner.mjs");
const { server, listen } = createInkwireServer();
const base = await listen();
console.log(`conformance server on ${base}`);

const child = spawn(process.execPath, [runner], {
  stdio: "inherit",
  env: { ...process.env, BASE_URL: base, API_KEY: "dev-key", READONLY_KEY: "audit-key" },
});
child.on("exit", (code) => {
  server.close();
  process.exit(code ?? 1);
});
