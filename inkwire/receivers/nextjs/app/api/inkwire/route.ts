// GET /api/inkwire: discovery (what this receiver can do: features, kinds, limits).
import { handleDiscovery } from "inkwire-receiver-core";
import { getInkwire, toResponse } from "../_inkwire/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { keys, config, store } = getInkwire();
  return toResponse(await handleDiscovery({ authHeader: req.headers.get("authorization"), keys, config, store }));
}
