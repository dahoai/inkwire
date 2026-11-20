// Added by create-inkwire (https://github.com/dahoai/inkwire). Safe to edit; re-running create-inkwire will not overwrite it.
// The whole Inkwire receiver as one Express router. Mount it on any Express app:
//   import { createInkwireRouter } from "./inkwire-router.js";
//   app.use(createInkwireRouter());
// Configuration is environment variables only; see the README. Express 4 or 5.
import express from "express";
import { handleDelete, handleDiscovery, handleGet, handleList, handleMedia, handlePatch, handleUpsert, } from "inkwire-receiver-core";
// <inkwire:shared> (identical in the Next.js receiver; `create-inkwire`'s sync script keeps them equal)
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { FileStore, GitHubStore, InkwireError, parseApiKeys, } from "inkwire-receiver-core";
// --- Fetching an image by URL, for POST /api/media {url}. Public http(s) hosts only: every address the
// name resolves to must be public, the connection is pinned to the address we checked (no DNS
// rebinding between check and connect), redirects are re-checked, and the size is capped as it streams.
function ipv4Bytes(ip) {
    const p = ip.split(".");
    if (p.length !== 4)
        return null;
    const b = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
    return b.every((n) => n >= 0 && n <= 255) ? b : null;
}
function ipv6Bytes(ip) {
    let s = ip.split("%")[0].toLowerCase();
    const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (tail) {
        const v4 = ipv4Bytes(tail[1]);
        if (!v4)
            return null;
        s = s.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
    }
    const halves = s.split("::");
    if (halves.length > 2)
        return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
    if (fill < 0 || (halves.length === 1 && head.length !== 8))
        return null;
    const groups = [...head, ...Array(fill).fill("0"), ...rest];
    const out = [];
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g))
            return null;
        const n = parseInt(g, 16);
        out.push(n >> 8, n & 255);
    }
    return out.length === 16 ? out : null;
}
function publicV4([a, b, c]) {
    if (a === 0 || a === 10 || a === 127 || a >= 224)
        return false; // this-net, private, loopback, multicast/reserved
    if (a === 100 && b >= 64 && b <= 127)
        return false; // carrier-grade NAT
    if (a === 169 && b === 254)
        return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31)
        return false;
    if (a === 192 && b === 168)
        return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2))
        return false;
    if (a === 198 && (b === 18 || b === 19))
        return false; // benchmarking
    if (a === 198 && b === 51 && c === 100)
        return false;
    if (a === 203 && b === 0 && c === 113)
        return false;
    return true;
}
export function isPublicAddress(ip) {
    const v4 = ipv4Bytes(ip);
    if (v4)
        return publicV4(v4);
    const v6 = ipv6Bytes(ip);
    if (!v6)
        return false;
    const embedded = (i) => v6.slice(i, i + 4);
    if (v6.slice(0, 10).every((x) => x === 0) && v6[10] === 255 && v6[11] === 255)
        return publicV4(embedded(12)); // ::ffff:a.b.c.d
    if (v6.slice(0, 12).every((x) => x === 0))
        return false; // ::, ::1, IPv4-compatible
    if (v6[0] === 0x00 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b && v6.slice(4, 12).every((x) => x === 0)) {
        return publicV4(embedded(12)); // NAT64 64:ff9b::/96
    }
    if ((v6[0] & 0xe0) !== 0x20)
        return false; // only global unicast 2000::/3
    if (v6[0] === 0x20 && v6[1] === 0x02)
        return false; // 6to4
    if (v6[0] === 0x20 && v6[1] === 0x01 && (v6[2] === 0x00 || (v6[2] === 0x0d && v6[3] === 0xb8)))
        return false; // teredo, documentation
    return true;
}
const MEDIA_HOPS = 3;
const MEDIA_TIMEOUT_MS = 10_000;
async function pinHost(host) {
    const bare = host.replace(/^\[|\]$/g, "");
    if (net.isIP(bare)) {
        if (!isPublicAddress(bare))
            throw new InkwireError("invalid_payload", "that image URL points at a private address");
        return { address: bare, family: net.isIP(bare) };
    }
    let found;
    try {
        found = await dns.promises.lookup(bare, { all: true });
    }
    catch {
        throw new InkwireError("invalid_payload", `could not resolve ${bare}`);
    }
    if (found.length === 0 || found.some((f) => !isPublicAddress(f.address))) {
        throw new InkwireError("invalid_payload", "that image URL points at a private address");
    }
    return found[0];
}
export async function fetchPublicImage(rawUrl, maxBytes) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        throw new InkwireError("invalid_payload", "the image URL is not a valid URL");
    }
    for (let hop = 0; hop <= MEDIA_HOPS; hop++) {
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new InkwireError("invalid_payload", "the image URL must be http or https");
        }
        if (url.username || url.password)
            throw new InkwireError("invalid_payload", "the image URL must not carry credentials");
        const port = url.port || (url.protocol === "https:" ? "443" : "80");
        if (port !== "80" && port !== "443")
            throw new InkwireError("invalid_payload", "the image URL must use port 80 or 443");
        const pinned = await pinHost(url.hostname);
        const lib = url.protocol === "https:" ? https : http;
        const res = await new Promise((resolve, reject) => {
            const req = lib.request({
                protocol: url.protocol,
                hostname: url.hostname.replace(/^\[|\]$/g, ""),
                port,
                path: `${url.pathname}${url.search}`,
                method: "GET",
                headers: { accept: "image/*", "user-agent": "inkwire-receiver" },
                // The only address this connection may use is the one just checked.
                lookup: ((_h, o, cb) => o?.all
                    ? cb(null, [{ address: pinned.address, family: pinned.family }])
                    : cb(null, pinned.address, pinned.family)),
            }, resolve);
            req.setTimeout(MEDIA_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
            req.on("error", () => reject(new InkwireError("invalid_payload", "could not fetch the image URL")));
            req.end();
        });
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            try {
                url = new URL(res.headers.location, url);
            }
            catch {
                throw new InkwireError("invalid_payload", "the image URL redirects to an invalid address");
            }
            continue;
        }
        if (status !== 200) {
            res.resume();
            throw new InkwireError("invalid_payload", `the image URL answered ${status}`);
        }
        const tooLarge = () => new InkwireError("too_large", `the image is over the limit (media_bytes ${maxBytes})`);
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy();
            throw tooLarge();
        }
        const chunks = [];
        let size = 0;
        try {
            for await (const chunk of res) {
                size += chunk.length;
                if (size > maxBytes) {
                    res.destroy();
                    throw tooLarge();
                }
                chunks.push(chunk);
            }
        }
        catch (e) {
            if (e instanceof InkwireError)
                throw e;
            throw new InkwireError("invalid_payload", "could not read the image URL");
        }
        let filename;
        try {
            filename = decodeURIComponent(url.pathname.split("/").pop() ?? "") || undefined;
        }
        catch { }
        return { bytes: Buffer.concat(chunks), contentType: res.headers["content-type"]?.split(";")[0].trim(), filename };
    }
    throw new InkwireError("invalid_payload", "the image URL redirects too many times");
}
const num = (v, d) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export function buildReceiver(env = process.env) {
    const keys = parseApiKeys(env.INKWIRE_API_KEYS);
    if (keys.length === 0)
        console.warn("[inkwire] INKWIRE_API_KEYS is empty: every request will be refused (401)");
    const siteUrl = (env.INKWIRE_SITE_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/+$/, "");
    const markdownBytes = num(env.INKWIRE_MARKDOWN_LIMIT_BYTES, 1_000_000);
    const mediaBytes = num(env.INKWIRE_MEDIA_LIMIT_BYTES, 10_000_000);
    const mediaBaseRaw = env.INKWIRE_MEDIA_URL_BASE ?? "/inkwire-media";
    const mediaIsAbsolute = /^https?:\/\//.test(mediaBaseRaw);
    const mediaUrlBase = (mediaIsAbsolute ? mediaBaseRaw : siteUrl + (mediaBaseRaw.startsWith("/") ? "" : "/") + mediaBaseRaw).replace(/\/+$/, "");
    const template = env.INKWIRE_URL_TEMPLATE; // e.g. https://site.com/blog/{slug}
    const urlFor = (e) => template ? template.replace("{kind}", e.kind).replace("{slug}", e.slug) : `${siteUrl}/${e.kind}/${e.slug}`;
    const repo = env.INKWIRE_GITHUB_REPO;
    const token = env.INKWIRE_GITHUB_TOKEN;
    if (Boolean(repo) !== Boolean(token)) {
        throw new Error("INKWIRE_GITHUB_REPO (owner/name) and INKWIRE_GITHUB_TOKEN must be set together");
    }
    let store;
    let mediaDir = null;
    let media = true;
    if (repo && token) {
        const [owner, name] = repo.split("/");
        if (!owner || !name)
            throw new Error("INKWIRE_GITHUB_REPO must look like owner/name");
        const github = new GitHubStore({
            owner,
            repo: name,
            branch: env.INKWIRE_GITHUB_BRANCH ?? "main",
            dir: env.INKWIRE_GITHUB_DIR ?? "content",
            token,
            mediaUrlBase,
            urlFor,
        });
        // Uploads are committed to <dir>/media; they are only useful when that folder is served at a
        // public address, which this receiver cannot know unless INKWIRE_MEDIA_URL_BASE is absolute.
        media = mediaIsAbsolute;
        store = media ? github : new Proxy(github, { get: (t, p) => (p === "saveMedia" ? undefined : Reflect.get(t, p)) });
    }
    else {
        const root = path.resolve(env.INKWIRE_ROOT ?? "./content");
        mediaDir = path.join(root, "media");
        store = new FileStore({ root, mediaUrlBase, urlFor });
    }
    const config = {
        site: { name: env.INKWIRE_SITE_NAME ?? "This site", url: siteUrl },
        kinds: (env.INKWIRE_KINDS ?? "post,page")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        limits: { markdown_bytes: markdownBytes, media_bytes: mediaBytes },
        features: ["upsert", "list", "get", "update", "delete", ...(media ? ["media"] : [])],
        ...(media ? { fetchMedia: (url) => fetchPublicImage(url, mediaBytes) } : {}),
    };
    let mediaPath = null;
    if (mediaDir) {
        try {
            mediaPath = new URL(mediaUrlBase).pathname.replace(/\/+$/, "") || null;
        }
        catch { }
    }
    return { keys, config, store, mediaDir, mediaPath };
}
const shape = (status, code, message) => ({
    status,
    headers: { "Inkwire-Version": "1", "Content-Type": "application/json" },
    body: { error: { code, message } },
});
/** The body as the core wants it: raw bytes. An app-level express.json() may have parsed it already. */
function bodyOf(req) {
    const b = req.body;
    if (Buffer.isBuffer(b))
        return b;
    if (typeof b === "string")
        return b;
    if (b && typeof b === "object" && Object.keys(b).length > 0)
        return JSON.stringify(b);
    return "";
}
export function createInkwireRouter(env = process.env) {
    const { keys, config, store, mediaDir, mediaPath } = buildReceiver(env);
    const limits = { markdown: config.limits?.markdown_bytes ?? 1_000_000, media: config.limits?.media_bytes ?? 10_000_000 };
    const jsonBody = express.raw({ type: () => true, limit: limits.markdown + 65_536 });
    const mediaBody = express.raw({ type: () => true, limit: limits.media + 65_536 });
    const router = express.Router();
    const send = (res, r) => res.status(r.status).set(r.headers).send(JSON.stringify(r.body));
    const authHeader = (req) => req.header("authorization");
    const idOf = (req) => {
        const v = req.params.id;
        return Array.isArray(v) ? v.join("/") : v;
    };
    const run = (fn) => async (req, res, next) => {
        try {
            send(res, await fn(req));
        }
        catch (e) {
            next(e);
        }
    };
    // Everything below is served by `inkwire-receiver-core`; this file only moves HTTP in and out.
    router.get("/api/inkwire", run((req) => handleDiscovery({ authHeader: authHeader(req), keys, config })));
    router.post("/api/content", jsonBody, run((req) => handleUpsert({ authHeader: authHeader(req), rawBody: bodyOf(req), keys, store, config })));
    router.get("/api/content", run((req) => handleList({ authHeader: authHeader(req), query: new URL(req.originalUrl, "http://x").searchParams, keys, store, config })));
    router.get("/api/content/:id", run((req) => handleGet({ authHeader: authHeader(req), id: idOf(req), keys, store })));
    router.patch("/api/content/:id", jsonBody, run((req) => handlePatch({ authHeader: authHeader(req), id: idOf(req), rawBody: bodyOf(req), ifMatchHeader: req.header("if-match"), keys, store, config })));
    router.delete("/api/content/:id", run((req) => handleDelete({ authHeader: authHeader(req), id: idOf(req), ifMatchHeader: req.header("if-match"), keys, store })));
    router.post("/api/media", mediaBody, run((req) => {
        const b = bodyOf(req);
        return handleMedia({ authHeader: authHeader(req), contentType: req.header("content-type"), rawBody: b, keys, store, config });
    }));
    // Uploaded images (FileStore writes them to <root>/media). The `.meta.json` sidecars stay private.
    if (mediaDir && mediaPath) {
        router.use(mediaPath, (req, res, next) => (req.path.endsWith(".meta.json") ? res.status(404).end() : next()));
        router.use(mediaPath, express.static(mediaDir, {
            maxAge: "365d",
            immutable: true,
            dotfiles: "ignore",
            index: false,
            setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
        }));
    }
    // Unknown /api paths and every failure, in the Inkwire error shape (Express's default pages are HTML).
    router.use("/api", (_req, res) => send(res, shape(404, "not_found", "unknown endpoint")));
    router.use((err, _req, res, next) => {
        const e = err;
        if (e?.type === "entity.too.large")
            return send(res, shape(413, "too_large", "the request body is over the limit"));
        if (err instanceof InkwireError)
            return send(res, shape(err.httpStatus, err.code, err.message));
        if (e?.status && e.status >= 400 && e.status < 500)
            return send(res, shape(400, "invalid_payload", "the request body could not be read"));
        console.error("[inkwire] internal error:", err instanceof Error ? err.message : "unknown");
        if (res.headersSent)
            return next(err);
        return send(res, shape(500, "internal", "internal error"));
    });
    return router;
}
