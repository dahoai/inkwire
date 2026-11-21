// GET /api/content/{id}/revisions: the entry's past versions, newest first (also after a delete).
import { handleRevisions } from "inkwire-receiver-core";
import { getInkwire, toResponse } from "../../../_inkwire/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { keys, store } = getInkwire();
  return toResponse(await handleRevisions({ authHeader: req.headers.get("authorization"), id, keys, store }));
}
