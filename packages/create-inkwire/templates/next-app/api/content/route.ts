// POST /api/content: create or upsert one entry. GET /api/content: list with filters and a cursor.
import { handleList, handleUpsert } from "inkwire-receiver-core";
import { getInkwire, toResponse, tooLarge } from "../_inkwire/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { keys, store, config } = getInkwire();
  const refused = tooLarge(req, config.limits?.markdown_bytes ?? 1_000_000);
  if (refused) return refused;
  return toResponse(await handleUpsert({ authHeader: req.headers.get("authorization"), rawBody: await req.text(), keys, store, config }));
}

export async function GET(req: Request) {
  const { keys, store, config } = getInkwire();
  return toResponse(await handleList({ authHeader: req.headers.get("authorization"), query: new URL(req.url).searchParams, keys, store, config }));
}
