import { getShadowKpiMultiHorizon } from "../../../../lib/shadowKpi";
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
  const walletIdParam = url.searchParams.get("walletId");
  const walletId = walletIdParam ? Number(walletIdParam) : null;
  const lane = url.searchParams.get("lane") ?? undefined;
  const bucket = url.searchParams.get("bucket") ?? undefined;

  try {
    const { sqlite } = getDb();
    const result = getShadowKpiMultiHorizon(sqlite, {
      walletId,
      windowHours,
      lane: lane === "policy_v0" ? "policy_v0" : undefined,
      bucket: bucket === "spread_200p" ? "spread_200p" : undefined
    });
    return Response.json(result, { headers: NO_CACHE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: message, horizons: [], windowHours, updatedAt: Date.now() },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}
