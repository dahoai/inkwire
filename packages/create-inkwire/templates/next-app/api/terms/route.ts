// GET /api/terms: the tags and categories the entries use, with counts.
import { handleTerms } from "inkwire-receiver-core";
import { getInkwire, toResponse } from "../_inkwire/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { keys, store } = getInkwire();
  return toResponse(await handleTerms({ authHeader: req.headers.get("authorization"), query: new URL(req.url).searchParams, keys, store }));
}
