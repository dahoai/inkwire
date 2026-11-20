// `npm run conformance`: runs the built express receiver (dist/server.js) through the shared runner.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runConformance } from "./harness.mjs";

const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { code, output } = await runConformance({ command: process.execPath, args: ["dist/server.js"], cwd });
process.stdout.write(output);
process.exit(code);
