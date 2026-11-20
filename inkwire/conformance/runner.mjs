import { readFileSync } from "node:fs";

// Black-box conformance runner for Inkwire receivers.
//
//   BASE_URL=http://localhost:4000 API_KEY=dev-key [READONLY_KEY=audit-key] node runner.mjs
//
// The runner reads GET /api/inkwire (discovery) and runs only the cases for the features the
// receiver advertises. A receiver without discovery is treated as upsert-only. Every API
// response must carry `Inkwire-Version: 1`. Cases fill `{{run}}` (unique per invocation) so a
// re-run against a persistent store never collides with the previous one.

const BASE = (process.env.BASE_URL ?? "").replace(/\/$/, "");
const KEY = process.env.API_KEY;
if (!BASE || !KEY) { console.error("Set BASE_URL and API_KEY"); process.exit(2); }
const RO_KEY = process.env.READONLY_KEY ?? null;
const RUN = "r" + Date.now().toString(36);
const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url)));

const vars = { run: RUN };
const etags = {};

const pathGet = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
function resolve(t) {
  if (typeof t !== "string") return t;
  return t.replace(/\{\{([^}]+)\}\}/g, (_, k) =>
    k.startsWith("etag:") ? (etags[k.slice(5)] ?? `{{${k}}}`) : (pathGet(vars, k) ?? `{{${k}}}`));
}
function resolveDeep(x) {
  if (Array.isArray(x)) return x.map(resolveDeep);
  if (x && typeof x === "object") {
    if (typeof x.$overLimit === "string") return "x".repeat((limits[x.$overLimit] ?? 100000) + 1);
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, resolveDeep(v)]));
  }
  return resolve(x);
}

async function call(method, endpoint, opts = {}) {
  const { auth = true, body, rawBody, multipart, headers = {}, captureBodyAs, captureEtagAs } = opts;
  const h = {};
  if (auth === true) h.authorization = `Bearer ${KEY}`;
  else if (auth === "ro") h.authorization = `Bearer ${RO_KEY}`;
  else if (auth) h.authorization = `Bearer ${resolve(auth)}`;
  Object.assign(h, resolveDeep(headers));
  let payload;
  if (multipart) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(multipart.fields ?? {})) fd.append(k, resolve(v));
    if (multipart.file) {
      fd.append(
        multipart.file.field ?? "file",
        new Blob([Buffer.from(multipart.file.base64 ?? "", "base64")], { type: multipart.file.contentType }),
        multipart.file.filename,
      );
    }
    payload = fd;
  } else if (rawBody !== undefined) {
    payload = resolve(rawBody);
  } else if (body !== undefined) {
    payload = JSON.stringify(resolveDeep(body));
    h["content-type"] = "application/json";
  }
  const res = await fetch(BASE + resolve(endpoint), { method, headers: h, body: payload });
  let json = null;
  try { json = await res.json(); } catch {}
  const etag = res.headers.get("etag");
  if (captureEtagAs && etag) etags[captureEtagAs] = etag;
  if (captureBodyAs) vars[captureBodyAs] = json;
  return { res, json, etag };
}

// --- discovery ---
let features = ["upsert"], kinds = ["post"], limits = {};
const d = await call("GET", "/api/inkwire");
if (d.res.status === 200 && d.json?.inkwire === 1) {
  features = Array.isArray(d.json.features) ? d.json.features : features;
  kinds = Array.isArray(d.json.kinds) ? d.json.kinds : kinds;
  limits = d.json.limits ?? {};
  console.log(`discovery: features=[${features}] kinds=[${kinds}]`);
} else {
  console.log("discovery: none (404 or not conformant) — treating as upsert-only");
}

const has = (...needed) => needed.every((f) => features.includes(f));
let passed = 0, skipped = 0, failed = 0;

function gate(c) {
  if (c.feature && !has(c.feature)) return `no ${c.feature} feature`;
  if ((c.requiresFeatures ?? []).some((f) => !has(f))) return `missing ${c.requiresFeatures.filter((f) => !features.includes(f))}`;
  if ((c.requiresKinds ?? []).some((k) => !kinds.includes(k))) return `no kind ${c.requiresKinds.filter((k) => !kinds.includes(k))}`;
  if ((c.notKinds ?? []).some((k) => kinds.includes(k))) return `holds kind ${c.notKinds.filter((k) => kinds.includes(k))}`;
  if (c.requiresLimit && limits[c.requiresLimit] === undefined) return `no ${c.requiresLimit} limit`;
  if (c.auth === "ro" && !RO_KEY) return "no READONLY_KEY";
  return null;
}

function check(c, { res, json, etag }) {
  const e = c.expect ?? {};
  const problems = [];
  if (res.status !== e.status) problems.push(`status ${res.status}!=${e.status}`);
  if (res.headers.get("inkwire-version") !== "1") problems.push("missing Inkwire-Version:1");
  if (e.errorCode && json?.error?.code !== e.errorCode) problems.push(`code ${json?.error?.code}!=${e.errorCode}`);
  if (e.errorCode && !(typeof json?.error?.message === "string" && json.error.message.length > 0)) {
    problems.push("error.message missing or empty");
  }
  for (const [k, v] of Object.entries(e.json ?? {})) if (json?.[k] !== resolve(v)) problems.push(`${k} ${JSON.stringify(json?.[k])}!=${JSON.stringify(v)}`);
  for (const [p, rawWant] of Object.entries(e.path ?? {})) {
    const want = resolve(rawWant);
    const got = pathGet(json ?? {}, p);
    if (want === "present" && (got === undefined || got === null)) problems.push(`${p} missing`);
    else if (want === "absent" && got !== undefined && got !== null) problems.push(`${p} present`);
    else if (want !== "present" && want !== "absent" && got !== want) problems.push(`${p} ${JSON.stringify(got)}!=${JSON.stringify(want)}`);
  }
  if (e.hasUrl && !json?.url) problems.push("no url");
  if (e.hasSlug && !json?.slug) problems.push("no slug");
  if (e.hasEtag && !etag) problems.push("no ETag header");
  if (e.absentEtag && etag) problems.push("unexpected ETag header");
  return problems;
}

for (const c of cases) {
  const why = gate(c);
  if (why) { skipped++; console.log(`SKIP ${c.name}: ${why}`); continue; }
  try {
    for (const step of c.setup ?? []) {
      if (step.sleepMs) { await new Promise((r) => setTimeout(r, step.sleepMs)); continue; }
      const s = await call(step.method ?? "POST", step.endpoint ?? "/api/content", step);
      if (s.res.status !== (step.expect?.status ?? 200)) {
        throw new Error(`setup "${step.name ?? "?"}" -> ${s.res.status}`);
      }
    }
    const r = await call(c.method ?? "POST", c.endpoint ?? "/api/content", c);
    const problems = check(c, r);
    if (problems.length) { failed++; console.log(`FAIL ${c.name}: ${problems.join(", ")}`); }
    else { passed++; console.log(`PASS ${c.name}`); }
  } catch (err) { failed++; console.log(`FAIL ${c.name}: ${err.message}`); }
}

console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
