// Serves uploaded images from the FileStore's media folder, at /inkwire-media/<file>.
// (INKWIRE_MEDIA_URL_BASE must keep that path; with the GitHub store, uploads are served elsewhere.)
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { getInkwire } from "../../api/_inkwire/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const dir = getInkwire().mediaDir;
  const notFound = () => new Response("not found", { status: 404 });
  if (!dir) return notFound();
  const root = resolve(dir);
  const target = resolve(root, ...path);
  const type = TYPES[target.slice(target.lastIndexOf(".")).toLowerCase()];
  if (!target.startsWith(root + sep) || !type) return notFound(); // outside the folder, or not an image (e.g. a .meta.json sidecar)
  try {
    const data = await readFile(target);
    return new Response(new Uint8Array(data), {
      headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
    });
  } catch {
    return notFound();
  }
}
