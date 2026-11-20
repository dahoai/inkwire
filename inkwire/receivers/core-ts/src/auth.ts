import { timingSafeEqual } from "node:crypto";
import { InkwireError } from "./errors.js";

/**
 * A key the receiver accepts. `ro` keys may call every GET and get 403 on anything that writes.
 * `scope` is what stores partition content by: every key parsed together belongs to one site and
 * shares one scope, so a read-only audit key sees what the full key wrote. A multi-tenant adapter
 * builds its own `ApiKey` objects with a per-site scope.
 */
export interface ApiKey {
  key: string;
  ro: boolean;
  scope: string;
}

export const DEFAULT_SCOPE = "default";

/** "dev-key,audit-key:ro" -> keys. Trims, skips empties; a key may contain ":" only as the trailing ":ro". */
export function parseApiKeys(raw: string | undefined | null, scope = DEFAULT_SCOPE): ApiKey[] {
  const out: ApiKey[] = [];
  for (const part of (raw ?? "").split(",")) {
    const item = part.trim();
    if (!item) continue;
    const ro = item.endsWith(":ro");
    const key = ro ? item.slice(0, -3).trim() : item;
    if (!key) continue;
    out.push({ key, ro, scope });
  }
  return out;
}

function eq(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Returns the matching key, or throws `unauthorized`. Compares against every key (no early exit). */
export function authorize(authHeader: string | null | undefined, keys: ApiKey[]): ApiKey {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  let match: ApiKey | undefined;
  for (const k of keys) if (token && eq(k.key, token) && !match) match = k;
  if (!match) throw new InkwireError("unauthorized", "missing or invalid API key");
  return match;
}

/** Throws `forbidden` for a read-only key. Call before any write. */
export function requireWrite(key: ApiKey) {
  if (key.ro) throw new InkwireError("forbidden", "this API key is read-only");
}
