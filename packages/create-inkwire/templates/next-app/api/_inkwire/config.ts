// Shared wiring for the Inkwire receiver routes: keys, config, store, and the response mapper.
// All of it comes from environment variables (see the README). FileStore keeps entries as markdown
// files under INKWIRE_ROOT (default ./content), so hand-written files there show up as entries.
// On hosts with a read-only filesystem (Vercel, Netlify) set INKWIRE_GITHUB_REPO + INKWIRE_GITHUB_TOKEN
// and entries are committed through the GitHub API instead.

// <inkwire:shared> (identical in the Next.js receiver; `create-inkwire`'s sync script keeps them equal)
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import {
  FileStore,
  GitHubStore,
  InkwireError,
  MemoryStore,
  parseApiKeys,
  type ApiKey,
  type ContentStore,
  type FetchedMedia,
  type InkwireConfig,
} from "inkwire-receiver-core";

// --- Fetching an image by URL, for POST /api/media {url}. Public http(s) hosts only: every address the
// name resolves to must be public, the connection is pinned to the address we checked (no DNS
// rebinding between check and connect), redirects are re-checked, and the size is capped as it streams.

function ipv4Bytes(ip: string): number[] | null {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  const b = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return b.every((n) => n >= 0 && n <= 255) ? b : null;
}

function ipv6Bytes(ip: string): number[] | null {
  let s = ip.split("%")[0].toLowerCase();
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = ipv4Bytes(tail[1]);
    if (!v4) return null;
    s = s.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    out.push(n >> 8, n & 255);
  }
  return out.length === 16 ? out : null;
}

function publicV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-net, private, loopback, multicast/reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function isPublicAddress(ip: string): boolean {
  const v4 = ipv4Bytes(ip);
  if (v4) return publicV4(v4);
  const v6 = ipv6Bytes(ip);
  if (!v6) return false;
  const embedded = (i: number) => v6.slice(i, i + 4);
  if (v6.slice(0, 10).every((x) => x === 0) && v6[10] === 255 && v6[11] === 255) return publicV4(embedded(12)); // ::ffff:a.b.c.d
  if (v6.slice(0, 12).every((x) => x === 0)) return false; // ::, ::1, IPv4-compatible
  if (v6[0] === 0x00 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b && v6.slice(4, 12).every((x) => x === 0)) {
    return publicV4(embedded(12)); // NAT64 64:ff9b::/96
  }
  if ((v6[0] & 0xe0) !== 0x20) return false; // only global unicast 2000::/3
  if (v6[0] === 0x20 && v6[1] === 0x02) return false; // 6to4
  if (v6[0] === 0x20 && v6[1] === 0x01 && (v6[2] === 0x00 || (v6[2] === 0x0d && v6[3] === 0xb8))) return false; // teredo, documentation
  return true;
}

const MEDIA_HOPS = 3;
const MEDIA_TIMEOUT_MS = 10_000;

async function pinHost(host: string): Promise<{ address: string; family: number }> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) {
    if (!isPublicAddress(bare)) throw new InkwireError("invalid_payload", "that image URL points at a private address");
    return { address: bare, family: net.isIP(bare) };
  }
  let found: { address: string; family: number }[];
  try {
    found = await dns.promises.lookup(bare, { all: true });
  } catch {
    throw new InkwireError("invalid_payload", `could not resolve ${bare}`);
  }
  if (found.length === 0 || found.some((f) => !isPublicAddress(f.address))) {
    throw new InkwireError("invalid_payload", "that image URL points at a private address");
  }
  return found[0];
}

export async function fetchPublicImage(rawUrl: string, maxBytes: number): Promise<FetchedMedia> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new InkwireError("invalid_payload", "the image URL is not a valid URL");
  }
  for (let hop = 0; hop <= MEDIA_HOPS; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new InkwireError("invalid_payload", "the image URL must be http or https");
    }
    if (url.username || url.password) throw new InkwireError("invalid_payload", "the image URL must not carry credentials");
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    if (port !== "80" && port !== "443") throw new InkwireError("invalid_payload", "the image URL must use port 80 or 443");
    const pinned = await pinHost(url.hostname);
    const lib = url.protocol === "https:" ? https : http;
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { accept: "image/*", "user-agent": "inkwire-receiver" },
          // The only address this connection may use is the one just checked.
          lookup: ((_h: string, o: unknown, cb: (...a: unknown[]) => void) =>
            (o as { all?: boolean })?.all
              ? cb(null, [{ address: pinned.address, family: pinned.family }])
              : cb(null, pinned.address, pinned.family)) as never,
        },
        resolve,
      );
      req.setTimeout(MEDIA_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
      req.on("error", () => reject(new InkwireError("invalid_payload", "could not fetch the image URL")));
      req.end();
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      try {
        url = new URL(res.headers.location, url);
      } catch {
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
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of res) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) {
          res.destroy();
          throw tooLarge();
        }
        chunks.push(chunk as Buffer);
      }
    } catch (e) {
      if (e instanceof InkwireError) throw e;
      throw new InkwireError("invalid_payload", "could not read the image URL");
    }
    let filename: string | undefined;
    try {
      filename = decodeURIComponent(url.pathname.split("/").pop() ?? "") || undefined;
    } catch {}
    return { bytes: Buffer.concat(chunks), contentType: res.headers["content-type"]?.split(";")[0].trim(), filename };
  }
  throw new InkwireError("invalid_payload", "the image URL redirects too many times");
}

// --- Environment -> keys, config and store.

export interface Receiver {
  keys: ApiKey[];
  config: InkwireConfig;
  store: ContentStore;
  /** Where FileStore keeps uploads (null when the store is GitHub). */
  mediaDir: string | null;
  /** URL path the uploads are served under (null when media is served elsewhere). */
  mediaPath: string | null;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function buildReceiver(env: NodeJS.ProcessEnv = process.env): Receiver {
  const keys = parseApiKeys(env.INKWIRE_API_KEYS);
  if (keys.length === 0) console.warn("[inkwire] INKWIRE_API_KEYS is empty: every request will be refused (401)");
  const siteUrl = (env.INKWIRE_SITE_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/+$/, "");
  const markdownBytes = num(env.INKWIRE_MARKDOWN_LIMIT_BYTES, 1_000_000);
  const mediaBytes = num(env.INKWIRE_MEDIA_LIMIT_BYTES, 10_000_000);

  const mediaBaseRaw = env.INKWIRE_MEDIA_URL_BASE ?? "/inkwire-media";
  const mediaIsAbsolute = /^https?:\/\//.test(mediaBaseRaw);
  const mediaUrlBase = (mediaIsAbsolute ? mediaBaseRaw : siteUrl + (mediaBaseRaw.startsWith("/") ? "" : "/") + mediaBaseRaw).replace(/\/+$/, "");
  const template = env.INKWIRE_URL_TEMPLATE; // e.g. {site}/blog/{slug}  or  https://site.com/{kind}/{slug}
  const urlFor = (e: { kind: string; slug: string }) =>
    template ? template.replace("{site}", siteUrl).replace("{kind}", e.kind).replace("{slug}", e.slug) : `${siteUrl}/${e.kind}/${e.slug}`;

  const repo = env.INKWIRE_GITHUB_REPO;
  const token = env.INKWIRE_GITHUB_TOKEN;
  if (Boolean(repo) !== Boolean(token)) {
    throw new Error("INKWIRE_GITHUB_REPO (owner/name) and INKWIRE_GITHUB_TOKEN must be set together");
  }
  // INKWIRE_STORE picks the store; unset means GitHub when the repo and token are set, else files.
  const kind = (env.INKWIRE_STORE ?? (repo ? "github" : "file")).toLowerCase();
  if (kind !== "file" && kind !== "memory" && kind !== "github") {
    throw new Error(`INKWIRE_STORE must be file, memory or github (got "${env.INKWIRE_STORE}")`);
  }
  if (kind === "github" && !repo) throw new Error("INKWIRE_STORE=github needs INKWIRE_GITHUB_REPO and INKWIRE_GITHUB_TOKEN");

  let store: ContentStore;
  let mediaDir: string | null = null;
  let media = true;
  const withoutMedia = (s: ContentStore): ContentStore => new Proxy(s, { get: (t, p) => (p === "saveMedia" ? undefined : Reflect.get(t, p)) });
  if (kind === "github") {
    const [owner, name] = (repo as string).split("/");
    if (!owner || !name) throw new Error("INKWIRE_GITHUB_REPO must look like owner/name");
    const github = new GitHubStore({
      owner,
      repo: name,
      branch: env.INKWIRE_GITHUB_BRANCH ?? "main",
      dir: env.INKWIRE_GITHUB_DIR ?? "content",
      token: token as string,
      mediaUrlBase,
      urlFor,
    });
    // Uploads are committed to <dir>/media; they are only useful when that folder is served at a
    // public address, which this receiver cannot know unless INKWIRE_MEDIA_URL_BASE is absolute.
    media = mediaIsAbsolute;
    store = media ? github : withoutMedia(github);
  } else if (kind === "memory") {
    // Nothing survives a restart, and there is nowhere to serve uploads from.
    media = false;
    store = withoutMedia(new MemoryStore({ urlFor }));
  } else {
    const root = path.resolve(env.INKWIRE_ROOT ?? "./content");
    mediaDir = path.join(root, "media");
    store = new FileStore({ root, mediaUrlBase, urlFor });
  }

  const config: InkwireConfig = {
    site: { name: env.INKWIRE_SITE_NAME ?? "This site", url: siteUrl },
    kinds: (env.INKWIRE_KINDS ?? "post,page")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    limits: { markdown_bytes: markdownBytes, media_bytes: mediaBytes },
    features: ["upsert", "list", "get", "update", "delete", ...(media ? ["media"] : [])],
    ...(media ? { fetchMedia: (url: string) => fetchPublicImage(url, mediaBytes) } : {}),
  };
  let mediaPath: string | null = null;
  if (mediaDir) {
    try {
      mediaPath = new URL(mediaUrlBase).pathname.replace(/\/+$/, "") || null;
    } catch {}
  }
  return { keys, config, store, mediaDir, mediaPath };
}
// </inkwire:shared>

let built: Receiver | undefined;
/** Built on first use, so a missing env var fails the request that needs it, not `next build`. */
export function getInkwire(): Receiver {
  return (built ??= buildReceiver());
}

export function toResponse(r: { status: number; headers: Record<string, string>; body: unknown }) {
  return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
}

/** A body the declared Content-Length already puts over the limit is refused before it is read. */
export function tooLarge(req: Request, limit: number): Response | null {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit + 65_536) {
    return toResponse({
      status: 413,
      headers: { "Inkwire-Version": "1", "Content-Type": "application/json" },
      body: { error: { code: "too_large", message: "the request body is over the limit" } },
    });
  }
  return null;
}
