import { getDefaultTokenIdForMarket, getMarketDetail } from "../../../lib/queries";
import { MarketDetail } from "../../../components/MarketDetail";

export default async function MarketPage({
  params,
  searchParams
}: {
  params: { id: string };
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const routeId = params.id;
  const queryTokenId = typeof token === "string" && token.length > 0 ? token : null;
  let tokenId = queryTokenId ?? routeId;
  let detail = tokenId ? getMarketDetail(tokenId) : null;

  // Backward-compatible fallback: links may use /market/:marketId without ?token.
  if (!detail?.meta && queryTokenId == null) {
    const fallbackTokenId = getDefaultTokenIdForMarket(routeId);
    if (fallbackTokenId != null && fallbackTokenId !== tokenId) {
      tokenId = fallbackTokenId;
      detail = getMarketDetail(tokenId);
    }
  }

  if (!detail?.meta) {
    return (
      <div className="p-4 md:p-6 lg:p-10 max-w-8xl">
        <div className="border border-border/40 bg-card/30 p-6">
          <h2 className="text-lg font-bold tracking-tight">Market not found</h2>
          <p className="text-sm text-muted-foreground font-mono">
            Use a valid token id (or market id with at least one token) in the URL.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-10 max-w-8xl space-y-8">
      <MarketDetail
      tokenId={detail.meta.tokenId}
      marketId={detail.meta.marketId}
      slug={detail.meta.slug}
      question={detail.meta.question}
      outcome={detail.meta.outcome}
      initialFeatures={detail.features.map((f) => ({
        ts: f.ts,
        mid: f.mid,
        obi: f.obi,
        micropriceMinusMid: f.micropriceMinusMid,
        spread: f.spread,
        accel1m: f.accel1m,
        skew30m: f.skew30m,
        entropy30m: f.entropy30m
      }))}
      initialDecisions={detail.decisions}
    />
    </div>
  );
}
