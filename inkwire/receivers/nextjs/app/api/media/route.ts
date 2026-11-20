// GET /api/media: list the uploaded images. POST /api/media: upload an image (multipart: file + optional alt) or JSON {url, alt} to fetch.
// The core parses the raw multipart body itself, so this route hands over the bytes as they came.
import { handleMedia, handleMediaList } from "inkwire-receiver-core";
import { getInkwire, toResponse, tooLarge } from "../_inkwire/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { keys, store, config } = getInkwire();
  const refused = tooLarge(req, config.limits?.media_bytes ?? 10_000_000);
  if (refused) return refused;
  return toResponse(
    await handleMedia({
      authHeader: req.headers.get("authorization"),
      contentType: req.headers.get("content-type"),
      rawBody: Buffer.from(await req.arrayBuffer()),
      keys,
      store,
      config,
    }),
  );
}

export async function GET(req: Request) {
  const { keys, store } = getInkwire();
  return toResponse(await handleMediaList({ authHeader: req.headers.get("authorization"), query: new URL(req.url).searchParams, keys, store }));
}
