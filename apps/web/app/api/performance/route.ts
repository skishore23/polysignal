import { getPerformanceMetrics } from "../../../lib/performance";
import { getDb } from "../../../lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const { sqlite } = getDb();
    const url = new URL(req.url);
    const walletIdParam = url.searchParams.get("walletId");
    const walletId = walletIdParam ? Number(walletIdParam) : null;
    return Response.json(getPerformanceMetrics(sqlite, walletId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
