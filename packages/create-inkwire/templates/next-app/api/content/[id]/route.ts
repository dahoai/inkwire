// GET/PATCH/DELETE /api/content/{id}: read one (with an ETag), edit with If-Match, delete.
import { handleDelete, handleGet, handlePatch } from "inkwire-receiver-core";
import { getInkwire, toResponse, tooLarge } from "../../_inkwire/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const { keys, store } = getInkwire();
  return toResponse(await handleGet({ authHeader: req.headers.get("authorization"), id, keys, store }));
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const { keys, store, config } = getInkwire();
  const refused = tooLarge(req, config.limits?.markdown_bytes ?? 1_000_000);
  if (refused) return refused;
  return toResponse(
    await handlePatch({
      authHeader: req.headers.get("authorization"),
      id,
      rawBody: await req.text(),
      query: new URL(req.url).searchParams,
      ifMatchHeader: req.headers.get("if-match"),
      keys,
      store,
      config,
    }),
  );
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const { keys, store, config } = getInkwire();
  return toResponse(await handleDelete({ authHeader: req.headers.get("authorization"), id, ifMatchHeader: req.headers.get("if-match"), keys, store, config }));
}
