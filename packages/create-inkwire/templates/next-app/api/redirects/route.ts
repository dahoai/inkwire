// GET /api/redirects?kind=&slug=: where an old address of an entry leads now (feature `redirects`).
import { handleRedirect } from "inkwire-receiver-core";
import { getInkwire, toResponse } from "../_inkwire/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { keys, store } = getInkwire();
  return toResponse(await handleRedirect({ authHeader: req.headers.get("authorization"), query: new URL(req.url).searchParams, keys, store }));
}
