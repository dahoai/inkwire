// PATCH /api/media/{id}: set or clear an uploaded image's alt text and title.
import { handleMediaUpdate } from "inkwire-receiver-core";
import { getInkwire, toResponse, tooLarge } from "../../_inkwire/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const { keys, store } = getInkwire();
  const refused = tooLarge(req, 100_000);
  if (refused) return refused;
  return toResponse(await handleMediaUpdate({ authHeader: req.headers.get("authorization"), id, rawBody: await req.text(), keys, store }));
}
