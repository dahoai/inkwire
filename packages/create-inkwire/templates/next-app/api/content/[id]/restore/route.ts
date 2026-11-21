// POST /api/content/{id}/restore {revision}: make the entry what it was at that revision (undo).
import { handleRestore } from "inkwire-receiver-core";
import { getInkwire, toResponse, tooLarge } from "../../../_inkwire/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { keys, store, config } = getInkwire();
  const refused = tooLarge(req, 4096);
  if (refused) return refused;
  return toResponse(
    await handleRestore({
      authHeader: req.headers.get("authorization"),
      id,
      rawBody: await req.text(),
      ifMatchHeader: req.headers.get("if-match"),
      keys,
      store,
      config,
    }),
  );
}
