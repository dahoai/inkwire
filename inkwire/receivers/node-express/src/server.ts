// Standalone reference receiver: `npm start`, then point the conformance runner at it.
// Reads .env from the working directory when there is one (Node 20.12+).
import express from "express";
import { createInkwireRouter } from "./inkwire-router.js";

try {
  process.loadEnvFile?.();
} catch {
  // no .env: the environment is enough
}

const app = express();
app.disable("x-powered-by");
app.use(createInkwireRouter());

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`inkwire express receiver on :${port}`));
