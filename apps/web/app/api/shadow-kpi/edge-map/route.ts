import { getShadowKpiEdgeMap } from "../../../../lib/shadowKpi";
import { getDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache"
} as const;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const windowHours = Math.min(168, Math.max(1, Number(url.searchParams.get("windowHours") ?? 24)));
  try {
    const { sqlite } = getDb();
    const { cells, updatedAt } = getShadowKpiEdgeMap(sqlite, { windowHours });
    return Response.json({ cells, updatedAt }, { headers: NO_CACHE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { cells: [], updatedAt: Date.now(), error: message },
      { status: 200, headers: NO_CACHE_HEADERS }
    );
  }
}
