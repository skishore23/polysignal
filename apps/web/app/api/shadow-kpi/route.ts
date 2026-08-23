import { getShadowKpi } from "../../../lib/shadowKpi";
import { getDb } from "../../../lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache"
} as const;

function errorResponse(message: string, windowHours: number, horizonMs: number): Response {
  return Response.json(
    {
      status: "error" as const,
      error: { code: "SHADOW_KPI_ERROR", message },
      updatedAt: Date.now(),
      filters: { horizonMs, windowHours },
      windowHours,
      horizonMs,
      completedCycles: 0,
      evBps: null,
      evBpsCiLo: null,
      evBpsCiHi: null,
      evBps5m: null,
      evBps10m: null,
      expectedDollarsPerDay: null,
      avgTimeInInventoryMs: null,
      medianTimeInInventoryMs: null,
      p90TimeInInventoryMs: null,
      openPositionsCount: 0,
      p95DrawdownProxyBps: null,
      byBucket: [],
      ts: Date.now()
    },
    { status: 200, headers: NO_CACHE_HEADERS }
  );
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const windowHours = Math.min(168, Math.max(1, Number(url.searchParams.get("windowHours") ?? 24)));
  const horizonMsParam = url.searchParams.get("horizonMs");
  const horizonMs = horizonMsParam
    ? Math.max(30_000, Math.min(1_200_000, Number(horizonMsParam)))
    : 300_000;
  try {
    const { sqlite } = getDb();
    const walletIdParam = url.searchParams.get("walletId");
    const walletId = walletIdParam ? Number(walletIdParam) : null;
    const lane = url.searchParams.get("lane") ?? undefined;
    const bucket = url.searchParams.get("bucket") ?? undefined;
    const kpi = getShadowKpi(sqlite, {
      walletId,
      windowHours,
      horizonMs,
      lane: lane === "policy_v0" ? "policy_v0" : undefined,
      bucket: bucket === "spread_200p" ? "spread_200p" : undefined
    });
    return Response.json(kpi, { headers: NO_CACHE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(message, windowHours, horizonMs);
  }
}
