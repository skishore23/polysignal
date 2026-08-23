import { getShadowKpiTimeTrend } from "../../../../lib/shadowKpi";
import { getDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache"
} as const;

const HORIZON_MS_MAP: Record<string, number> = {
  "5m": 300_000,
  "10m": 600_000,
  "20m": 1_200_000
};

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const horizonParam = url.searchParams.get("horizonMs") ?? url.searchParams.get("horizon") ?? "10m";
  const horizonMs =
    (HORIZON_MS_MAP[horizonParam] ?? (Number(horizonParam) || 600_000));
  const walletIdParam = url.searchParams.get("walletId");
  const walletId = walletIdParam ? Number(walletIdParam) : null;
  const lane = url.searchParams.get("lane") ?? undefined;
  const bucket = url.searchParams.get("bucket") ?? undefined;

  try {
    const { sqlite } = getDb();
    const result = getShadowKpiTimeTrend(sqlite, {
      walletId,
      horizonMs,
      lane: lane === "policy_v0" ? "policy_v0" : undefined,
      bucket: bucket === "spread_200p" ? "spread_200p" : undefined
    });
    return Response.json(result, { headers: NO_CACHE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: message, windows: [], horizonMs, updatedAt: Date.now() },
      { status: 500, headers: NO_CACHE_HEADERS }
    );
  }
}
