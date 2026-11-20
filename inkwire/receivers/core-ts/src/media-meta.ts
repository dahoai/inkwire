import type { StoredMedia } from "./store.js";

/** The sidecar next to a stored image: `<hex>-<filename>.meta.json`. File-backed stores share it. */
export interface MediaMeta {
  alt?: string;
  title?: string;
  content_type: string;
  created_at: string;
}

/** A media id is 16 hex characters; the file is `<id>-<filename>`. Anything else never touches a path. */
export const MEDIA_ID_RE = /^[0-9a-f]{16}$/;
export const MEDIA_FILE_RE = /^([0-9a-f]{16})-(.+)$/;
export const META_SUFFIX = ".meta.json";

const BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

export function mimeForName(name: string): string {
  return BY_EXT[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export function serializeMeta(m: MediaMeta): string {
  const out: Record<string, unknown> = { content_type: m.content_type, created_at: m.created_at };
  if (m.alt !== undefined) out.alt = m.alt;
  if (m.title !== undefined) out.title = m.title;
  return JSON.stringify(out);
}

/** Reads a sidecar; a missing or unreadable one falls back to what the file name and its time say. */
export function parseMeta(raw: string | null, name: string, fallbackCreatedAt: string): MediaMeta {
  let j: Record<string, unknown> = {};
  if (raw) {
    try {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) j = v as Record<string, unknown>;
    } catch {}
  }
  const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const created = s(j.created_at);
  return {
    ...(s(j.alt) !== undefined ? { alt: s(j.alt)! } : {}),
    ...(s(j.title) !== undefined ? { title: s(j.title)! } : {}),
    content_type: s(j.content_type) ?? mimeForName(name),
    created_at: created && !Number.isNaN(Date.parse(created)) ? created : fallbackCreatedAt,
  };
}

export function toMedia(id: string, url: string, m: MediaMeta): StoredMedia {
  return {
    id,
    url,
    ...(m.alt !== undefined ? { alt: m.alt } : {}),
    ...(m.title !== undefined ? { title: m.title } : {}),
    mime_type: m.content_type,
    created_at: m.created_at,
  };
}

/** Applies a PATCH to a sidecar: a string sets, null clears, absent keeps. */
export function patchMeta(m: MediaMeta, patch: { alt?: string | null; title?: string | null }): MediaMeta {
  const next: MediaMeta = { content_type: m.content_type, created_at: m.created_at };
  const alt = patch.alt === undefined ? m.alt : (patch.alt ?? undefined);
  const title = patch.title === undefined ? m.title : (patch.title ?? undefined);
  if (alt !== undefined && alt !== "") next.alt = alt;
  if (title !== undefined && title !== "") next.title = title;
  return next;
}
