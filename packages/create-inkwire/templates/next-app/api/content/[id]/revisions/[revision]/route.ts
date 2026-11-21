// GET /api/content/{id}/revisions/{revision}: one past version in full.
import { handleRevision } from "inkwire-receiver-core";
import { getInkwire, toResponse } from "../../../../_inkwire/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; revision: string }> }) {
  const { id, revision } = await ctx.params;
  const { keys, store } = getInkwire();
  return toResponse(await handleRevision({ authHeader: req.headers.get("authorization"), id, revision, keys, store }));
}
