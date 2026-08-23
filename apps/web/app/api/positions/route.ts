import { getDb } from "../../../lib/db";
import { getMakerPositions, getTakerPositions } from "../../../lib/queries";
import type { ShadowPositionRow, ShadowClosedPositionRow } from "../../../lib/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const { sqlite } = getDb();
  const url = new URL(request.url);
  const walletIdParam = url.searchParams.get("walletId");
  const walletId = walletIdParam ? Number(walletIdParam) : null;

  if (walletId == null || !Number.isFinite(walletId)) {
    return Response.json({ mode: null, open: [], closed: [] });
  }

  const walletRow = sqlite
    .prepare("SELECT maker_enabled as makerEnabled FROM wallets WHERE id = ?")
    .get(walletId) as { makerEnabled?: number } | undefined;
  const makerEnabled = (walletRow?.makerEnabled ?? 0) === 1;

  if (makerEnabled) {
    const makerPositions = getMakerPositions(walletId);
    const open: ShadowPositionRow[] = makerPositions.map((mp) => ({
      id: `${mp.walletId}:${mp.tokenId}`,
      walletId: mp.walletId,
      walletName: mp.walletName,
      tokenId: mp.tokenId,
      marketId: mp.marketId,
      question: mp.question,
      outcome: mp.outcome,
      side: mp.side,
      size: Math.abs(mp.position),
      entryPrice: mp.avgEntry,
      mid: mp.mid,
      realized: mp.realized,
      unrealized: mp.unrealized,
      tsOpen: mp.ts,
      kind: "maker"
    }));
    return Response.json({ mode: "maker", open, closed: [] as ShadowClosedPositionRow[] });
  }

  const taker = getTakerPositions(walletId);
  return Response.json({ mode: "taker", open: taker.open, closed: taker.closed });
}
