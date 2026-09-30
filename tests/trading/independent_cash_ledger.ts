/** Test-only event ledger. It shares no position/accounting code with runtime. */
export type CashEvent =
  | {
      id: string;
      sequence: number;
      kind: "FILL";
      token: string;
      side: "BUY" | "SELL";
      shares: number;
      price: number;
      feeAsset: "CASH" | "SHARES";
      feeAmount: number;
    }
  | { id: string; sequence: number; kind: "SETTLEMENT"; token: string; payout: 0 | 1 }
  | { id: string; sequence: number; kind: "TRANSFER"; amount: number };

export const reconcileEvents = (events: CashEvent[], marks: Record<string, number>) => {
  const positions = new Map<string, { shares: number; basis: number }>();
  const seen = new Set<string>();
  let cash = 0;
  let transfers = 0;
  let grossRealized = 0;
  let cashFees = 0;
  let duplicates = 0;

  for (const event of [...events].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))) {
    if (seen.has(event.id)) {
      duplicates += 1;
      continue;
    }
    seen.add(event.id);
    if (event.kind === "TRANSFER") {
      if (!Number.isFinite(event.amount)) throw new Error("INVALID_TRANSFER");
      cash += event.amount;
      transfers += event.amount;
      continue;
    }
    const position = positions.get(event.token) ?? { shares: 0, basis: 0 };
    if (event.kind === "SETTLEMENT") {
      cash += position.shares * event.payout;
      grossRealized += position.shares * (event.payout - position.basis);
      positions.set(event.token, { shares: 0, basis: 0 });
      continue;
    }
    if (
      !Number.isFinite(event.shares) ||
      event.shares <= 0 ||
      !Number.isFinite(event.price) ||
      event.price <= 0 ||
      event.price >= 1 ||
      !Number.isFinite(event.feeAmount) ||
      event.feeAmount < 0
    )
      throw new Error("INVALID_FILL");
    if (event.side === "BUY") {
      const netShares = event.shares - (event.feeAsset === "SHARES" ? event.feeAmount : 0);
      if (netShares <= 0) throw new Error("INVALID_SHARE_FEE");
      const cashPaid = event.shares * event.price + (event.feeAsset === "CASH" ? event.feeAmount : 0);
      cash -= cashPaid;
      if (event.feeAsset === "CASH") cashFees += event.feeAmount;
      const newShares = position.shares + netShares;
      // Cash fees are accounted once through cash, not again in inventory basis.
      const newBasis = (position.shares * position.basis + event.shares * event.price) / newShares;
      positions.set(event.token, { shares: newShares, basis: newBasis });
    } else {
      if (event.feeAsset === "SHARES" || event.shares > position.shares + 1e-12)
        throw new Error("UNSUPPORTED_SHORT_OR_FEE");
      cash += event.shares * event.price - event.feeAmount;
      cashFees += event.feeAmount;
      grossRealized += event.shares * (event.price - position.basis);
      const remaining = position.shares - event.shares;
      positions.set(event.token, {
        shares: remaining,
        basis: remaining > 1e-12 ? position.basis : 0
      });
    }
  }

  let equity = cash - transfers;
  for (const [token, position] of positions) {
    if (position.shares <= 1e-12) continue;
    const mark = marks[token];
    if (mark == null || !Number.isFinite(mark) || mark < 0 || mark > 1) {
      return { cash, transfers, positions, grossRealized, cashFees, netPnl: null, duplicates };
    }
    equity += position.shares * mark;
  }
  return { cash, transfers, positions, grossRealized, cashFees, netPnl: equity, duplicates };
};
