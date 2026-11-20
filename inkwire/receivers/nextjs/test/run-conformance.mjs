// `npm run conformance`: `next start` (after `next build`) through the shared black-box runner.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runConformance } from "../../node-express/test/harness.mjs";

const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 0) || undefined;
const { code, output } = await runConformance({ command: "npx", args: ["next", "start", "-p", "{port}"], cwd, port });
process.stdout.write(output);
process.exit(code);
