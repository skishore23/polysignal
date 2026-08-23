import { Suspense } from "react";
import { getDb } from "../../lib/db";
import { wallets as walletsTable } from "@polysignal/storage";
import { getMakerPositions, getTakerPositions } from "../../lib/queries";
import { parseWalletMarketFilterJson } from "@polysignal/utils";
import type { ShadowPositionRow, ShadowClosedPositionRow } from "../../lib/queries";
import { PositionsPageClient } from "./positions-client";

export const dynamic = "force-dynamic";

type PositionsPageProps = {
  searchParams?: Promise<{ walletId?: string | string[] }>;
};

export default async function PositionsPage(props: PositionsPageProps) {
  const searchParams = (await (props.searchParams ?? Promise.resolve({}))) as {
    walletId?: string | string[];
  };
  const { db } = getDb();

  const walletsRaw = db.select().from(walletsTable).all();

  const wallets = walletsRaw.map((w) => ({
    id: w.id,
    name: w.name,
    makerEnabled: w.makerEnabled ?? 0,
    startingBalance: w.startingBalance,
    sizeMultiplier: w.sizeMultiplier,
    maxOpenPositions: w.maxOpenPositions,
    minConfidence: w.minConfidence,
    minEdge: w.minEdge,
    autoOpenLimit: w.autoOpenLimit,
    autoTradeEnabled: w.autoTradeEnabled,
    makerQuoteSize: w.makerQuoteSize,
    makerQuoteWidthBps: w.makerQuoteWidthBps,
    makerMinSpread: w.makerMinSpread,
    makerMaxSpread: w.makerMaxSpread,
    makerMinDepth: w.makerMinDepth,
    makerInventoryMaxAbs: w.makerInventoryMaxAbs,
    makerInventorySkewBps: w.makerInventorySkewBps,
    maxDailyLossUsd: w.maxDailyLossUsd,
    maxDrawdownPct: w.maxDrawdownPct,
    cooldownMinutes: w.cooldownMinutes,
    marketAllowlist: w.marketAllowlist ?? "",
    marketFilterJson: w.marketFilterJson ?? null,
    marketFilter: (() => {
      const parsed = parseWalletMarketFilterJson(w.marketFilterJson ?? null);
      return parsed.ok ? parsed.value : null;
    })(),
    defaultStopLossPct: w.defaultStopLossPct,
    defaultTakeProfitPct: w.defaultTakeProfitPct,
    defaultMaxLossAbs: w.defaultMaxLossAbs,
    defaultMaxHoldSec: w.defaultMaxHoldSec
  }));

  const walletIdRaw = Array.isArray(searchParams.walletId)
    ? searchParams.walletId[0]
    : searchParams.walletId;
  const walletIdParam = walletIdRaw ? Number(walletIdRaw) : null;
  const walletId = walletIdParam && Number.isFinite(walletIdParam)
    ? walletIdParam
    : wallets[0]?.id ?? null;

  const activeWallet = wallets.find((w) => w.id === walletId) ?? null;

  let initialOpenPositions: ShadowPositionRow[] = [];
  let initialClosedPositions: ShadowClosedPositionRow[] = [];
  let initialMode: "maker" | "taker" | null = null;

  if (walletId != null && activeWallet) {
    if (activeWallet.makerEnabled === 1) {
      const makerPositions = getMakerPositions(walletId);
      initialOpenPositions = makerPositions.map((mp) => ({
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
      initialMode = "maker";
    } else {
      const taker = getTakerPositions(walletId);
      initialOpenPositions = taker.open;
      initialClosedPositions = taker.closed;
      initialMode = "taker";
    }
  }

  return (
    <div className="p-4 md:p-6 lg:p-10 max-w-8xl space-y-8 overflow-x-hidden">
      <Suspense fallback={<div className="text-neon-blue font-mono text-[10px] animate-pulse uppercase tracking-widest">Loading wallets...</div>}>
        <PositionsPageClient
          initialWallets={wallets}
          initialWalletId={walletId}
          initialMode={initialMode}
          initialOpenPositions={initialOpenPositions}
          initialClosedPositions={initialClosedPositions}
        />
      </Suspense>
    </div>
  );
}
