import { createHash } from "node:crypto";

export const TOKEN = "ghp_SECRET_TOKEN_123";
export const API = "https://api.github.com/repos/acme/site";

export interface Call {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body?: any;
}

/** A tiny in-memory GitHub: contents GET/PUT/DELETE and the recursive tree, with real blob shas. */
export function fakeGitHub(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const calls: Call[] = [];
  const sha = (text: string) => createHash("sha1").update(`blob ${text.length}\0${text}`).digest("hex");
  const hooks: { fail?: (c: Call) => Response | undefined; truncated?: boolean; network?: boolean } = {};

  const fetchFn: typeof fetch = async (input, init) => {
    if (hooks.network) throw new Error(`socket hang up ${TOKEN}`);
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname.replace("/repos/acme/site", "")),
      query: url.search,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const injected = hooks.fail?.(call);
    if (injected) return injected;
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (call.path.startsWith("/contents/")) {
      const p = call.path.slice("/contents/".length);
      if (call.method === "GET") {
        const text = files.get(p);
        return text === undefined ? json({ message: "Not Found" }, 404) : json({ type: "file", path: p, sha: sha(text), encoding: "base64", content: Buffer.from(text).toString("base64") });
      }
      if (call.method === "PUT") {
        const existing = files.get(p);
        if (existing !== undefined && call.body.sha !== sha(existing)) return json({ message: "sha mismatch" }, 409);
        if (existing === undefined && call.body.sha) return json({ message: "sha supplied for a new file" }, 422);
        const text = Buffer.from(call.body.content, "base64").toString("utf8");
        files.set(p, text);
        return json({ content: { sha: sha(text), path: p } }, existing === undefined ? 201 : 200);
      }
      if (call.method === "DELETE") {
        const existing = files.get(p);
        if (existing === undefined) return json({ message: "Not Found" }, 404);
        if (call.body.sha !== sha(existing)) return json({ message: "sha mismatch" }, 409);
        files.delete(p);
        return json({ commit: {} });
      }
    }
    if (call.path.startsWith("/git/trees/") && call.method === "GET") {
      return json({
        truncated: hooks.truncated ?? false,
        tree: [...files].map(([path, text]) => ({ path, type: "blob", sha: sha(text) })).concat([{ path: "content/post", type: "tree", sha: "t" }]),
      });
    }
    return json({ message: "unexpected" }, 500);
  };
  return { files, calls, fetchFn, hooks, sha };
}

