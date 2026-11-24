/** Incremental, slot-local interpretation of the same observations as the frozen startup decoder. */
import { createHash } from "node:crypto";
import { BookStore } from "../../packages/book/src/index";
import { FeatureEngine } from "../../packages/features/src/featureEngine";
import type { StartupClock } from "./maker_quote_startup";
import { deriveMakerStartupInputs, type MakerStartupSourceInput, type BridgeStreamItem } from "./maker_startup_source_bridge";

type Derived = ReturnType<typeof deriveMakerStartupInputs>;
export type OperatingSourceMetadata = Omit<MakerStartupSourceInput, "stream">;
export const OPERATING_TICK_SIZE_RESYNC = "maker_source:validated_tick_size_change";
export const OPERATING_BACKDATED_DELTA_RESYNC = "maker_source:validated_backdated_delta";
const scale = 1_000_000_000n;
// https://docs.polymarket.com/trading/place-orders#calculate-the-order-amounts
// An announced grid can require new metadata even when the pinned decoder
// does not yet support quoting on that grid.
const documentedTickUnits = new Set([100_000_000n, 10_000_000n, 5_000_000n, 2_500_000n, 1_000_000n, 100_000n]);
const digest = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");

function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error("maker_source:" + reason);
}
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "object_required");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  check(typeof value === "string" && value.trim().length > 0, "string_required");
  return value;
}
function decimal(value: unknown, wireString = false): { text: string; units: bigint; n: number } {
  check(typeof value === "string" || (!wireString && typeof value === "number"), "decimal_type");
  const text = String(value);
  check(/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(text), "decimal_format");
  const [whole, fraction = ""] = text.split(".");
  const units = BigInt(whole!) * scale + BigInt(fraction.padEnd(9, "0"));
  const n = Number(text);
  check(Number.isFinite(n) && n <= Number.MAX_SAFE_INTEGER, "numeric_range");
  return { units, n, text };
}
function ordered(before: StartupClock, after: StartupClock) {
  for (const c of [before, after]) {
    check(Number.isSafeInteger(c.utc) && c.utc >= 0 && Number.isFinite(c.mono) && c.mono >= 0, "clock");
  }
  const utc = after.utc - before.utc, mono = after.mono - before.mono;
  check(utc >= 0 && mono >= 0 && Math.abs(utc - mono) <= 100, "causal_clocks");
}
function venueTime(value: unknown, receiveUtc: number) {
  check(typeof value === "string" && /^\d{13}$/.test(value), "venue_timestamp");
  const t = Number(value);
  check(t <= receiveUtc, "future_venue_time");
  return t;
}
function sourceJson<T>(decode: () => T): T {
  try { return decode(); }
  catch (error) { if (error instanceof SyntaxError) throw Error("maker_source:malformed_json"); throw error; }
}

/** Bind the four original capture receipts once. Callers enforce transport/frontier custody. */
export function createOperatingSourceState(
  input: OperatingSourceMetadata,
  limits: { maxTradesPerSlot?: number } = {},
) {
  const { maxTradesPerSlot } = limits;
  if (maxTradesPerSlot !== undefined) {
    check(Number.isSafeInteger(maxTradesPerSlot) && maxTradesPerSlot > 0, "invalid_trade_capacity");
  }
  const initialRestShape = object(sourceJson(() => JSON.parse(input.clobBook.raw)));
  check(Array.isArray(initialRestShape.bids) && Array.isArray(initialRestShape.asks), "book_side_schema");
  string(initialRestShape.hash);
  const initialTick=decimal(initialRestShape.tick_size,true).units;
  check(initialTick>0n,"snapshot_tick_context");
  for(const side of [initialRestShape.bids,initialRestShape.asks]){
    const seen=new Set<bigint>();
    for(const raw of side){const level=object(raw),p=decimal(level.price,true),q=decimal(level.size,true);
      check(p.units>0n && p.units<scale && p.units%initialTick===0n,"price_grid");
      check(q.units>0n && !seen.has(p.units),"duplicate_or_empty_level");seen.add(p.units);}
  }
  const base = sourceJson(() => deriveMakerStartupInputs({ ...input, stream: [] }, {
    classifyRestTickMismatch: true, classifyInitialSnapshotUnavailable: true,
  }));
  const { identity } = base;
  const { token, market, condition } = identity;
  const v2 = identity.protocolVersion === "v2";
  const tick = decimal(base.book.tick, true);
  const gammaClock = { ...input.gamma.at };
  let previous = { ...(input.tokenFee?.at ?? input.clobBook.at) };
  // Retain only the changing book, feature buffers and witnessed trades. The old
  // decoder already checked every REST level and the immutable market/fee bindings.
  const rest = JSON.parse(input.clobBook.raw);
  const levels = (side: {price: string; size: string}[]) =>
    side.map(({ price, size }) => ({ price: Number(price), size: Number(size) }));
  const store = new BookStore();
  store.upsertSnapshot({ tokenId: token, marketId: market, hash: rest.hash, bids: levels(rest.bids),
    asks: levels(rest.asks), ts: base.book.venueUtc, recvTsMs: base.book.receipt.utc });
  const engine = new FeatureEngine(store, { topKLevels: input.topKLevels, returnWindowSec: 10,
    volWindowSec: 1800, sampleIntervalSec: 1 });
  let book = { ...base.book, receipt: { ...base.book.receipt } };
  const tradeState: Derived["trades"] = [];
  const seenTrades = new Set<string>();
  let feature: Derived["feature"] = null;
  let lastSample: StartupClock | null = null;
  let sampledBook: typeof book | null = null;
  let streamAnchored = false;
  let bookInvalidation: string | null = null;
  let lastSelectedVenueUtc = book.venueUtc;
  let maxTradeVenueUtc = 0;
  let failure: Error | null = null;
  const price = (v: unknown) => {
    const p = decimal(v, true);
    check(p.units > 0n && p.units < scale && p.units % tick.units === 0n, "price_grid");
    return p;
  };
  function parseSnapshot(row: Record<string, unknown>, at: StartupClock, raw: string, singleton: boolean) {
    check(row.asset_id === token && row.market === condition, "book_identity");
    if (row.version !== undefined) check(v2 && row.version === "v2", "unsupported_book_version");
    if (row.tick_size !== undefined) check(decimal(row.tick_size, true).units === tick.units, "snapshot_tick_context");
    const venueUtc = venueTime(row.timestamp, at.utc);
    check(Array.isArray(row.bids) && Array.isArray(row.asks),"book_side_schema");
    const levels = (values: unknown) => {
      check(Array.isArray(values), "book_side_schema");
      const seen = new Set<bigint>();
      return values.map(v => {
        const level = object(v), p = price(level.price), size = decimal(level.size, true);
        check(!seen.has(p.units) && size.units > 0n, "duplicate_or_empty_level");
        seen.add(p.units);
        return { price: p.n, size: size.n };
      });
    };
    const bids = levels(row.bids), asks = levels(row.asks);
    const hash = string(row.hash);
    check(bids.length > 0 && asks.length > 0, singleton ? "empty_book_side" : "empty_book_mixed_frame");
    const bid = bids.reduce((best, level) => Math.max(best, level.price), 0);
    const ask = asks.reduce((best, level) => Math.min(best, level.price), 1);
    check(bid < ask, "crossed_book");
    const rawSha256 = digest(raw);
    const observation = { ...base.book, bid: String(bid), ask: String(ask), receipt: at, venueUtc,
      rawSha256, anchorSha256: rawSha256, venueHash: hash };
    return { observation, snapshot: { tokenId: token, marketId: market, hash, bids, asks, ts: venueUtc, recvTsMs: at.utc } };
  }
  function applyPriceChange(e: Record<string, unknown>, at: StartupClock, raw: string, singleton: boolean) {
    if (!Array.isArray(e.price_changes) || !e.price_changes.length) {
      bookInvalidation = "MISSING_PRICE_CHANGE_MEMBERS";
      return;
    }
    const venueUtc = venueTime(e.timestamp, at.utc);
    const backdated = venueUtc < lastSelectedVenueUtc;
    const members = e.price_changes.map(value => {
      const c = object(value);
      check(identity.outcomes.some(o => o.token === c.asset_id), "delta_asset");
      check(c.side === "BUY" || c.side === "SELL", "delta_side");
      const p = decimal(c.price, true), q = decimal(c.size, true);
      const bestBid = decimal(c.best_bid, true), bestAsk = decimal(c.best_ask, true);
      check(p.units > 0n && p.units < scale && bestBid.units <= scale && bestAsk.units <= scale, "delta_price_domain");
      string(c.hash); // Per-change hash is opaque. It is never substituted for a full book hash.
      const onGrid = c.asset_id !== token && !backdated || (p.units % tick.units === 0n
        && bestBid.units % tick.units === 0n && bestAsk.units % tick.units === 0n);
      if (c.asset_id === token) check(onGrid, "delta_price_grid");
      return { selected: c.asset_id === token, side: c.side === "BUY" ? "bids" as const : "asks" as const,
        price: p.n, size: q.n, bestBid: bestBid.n, bestAsk: bestAsk.n, onGrid };
    });
    const selected = members.filter(c => c.selected);
    if (!selected.length) return;
    if (e.tick_size !== undefined) check(decimal(e.tick_size, true).units === tick.units, "delta_tick_context");
    check(venueUtc >= identity.start, "delta_before_market");
    if (backdated) {
      check(singleton, "backdated_delta_mixed_frame");
      const keys = selected.map(c => c.side + ":" + c.price);
      check(new Set(keys).size === keys.length, "backdated_delta_duplicate_level");
      const first = selected[0]!;
      check(members.every(c => c.onGrid), "backdated_delta_member_grid");
      check(members.every(c => c.bestBid < c.bestAsk)
        && selected.every(c => c.bestBid === first.bestBid && c.bestAsk === first.bestAsk), "backdated_delta_bbo");
      // A stale change has no matching historical book here. Its BBO cannot
      // certify depth against the newer book. Stop before touching either state.
      throw new Error(OPERATING_BACKDATED_DELTA_RESYNC);
    }
    lastSelectedVenueUtc = venueUtc;
    if (!streamAnchored) { bookInvalidation = "WS_SNAPSHOT_REQUIRED_BEFORE_DELTA"; return; }
    if (bookInvalidation !== null) return; // Only a complete later snapshot repairs a broken chain.
    const keys = selected.map(c => c.side + ":" + c.price);
    if (new Set(keys).size !== keys.length) { bookInvalidation = "AMBIGUOUS_REPEATED_DELTA_LEVEL"; return; }

    // Each price/side receives its new aggregate size; zero removes the level. Do not
    // expose a partially applied message or infer selected depth from sibling prices.
    for (const c of selected) {
      store.applyDelta({tokenId: token, side: c.side, price: c.price, size: c.size, ts: venueUtc, recvTsMs: at.utc});
    }
    const { bestBid, bestAsk } = store.bestBidAsk(token);
    if (!bestBid || !bestAsk || bestBid.price >= bestAsk.price
      || selected.some(c => c.bestBid !== bestBid.price || c.bestAsk !== bestAsk.price)) {
      bookInvalidation = "DELTA_BEST_BOOK_MISMATCH";
      return;
    }
    book = { ...book, bid: String(bestBid.price), ask: String(bestAsk.price), receipt: at,
      venueUtc, rawSha256: digest(raw), venueHash: null };
  }
  const fresh = (at: StartupClock) => bookInvalidation === null && at.utc - book.receipt.utc <= 1000 && at.mono - book.receipt.mono <= 1000
    && book.receipt.utc - book.venueUtc <= 1000 && at.utc - book.venueUtc <= 1000;
  const observedMissing = new Set(["FRESH_AUTHORITATIVE_ORIGINAL_BOOK", "CURRENT_CANONICAL_FEATURE_SAMPLE",
    "OBSERVED_VOLATILITY_HISTORY", "OBSERVED_ORIGINAL_TOKEN_TRADE_FLOW"]);
  const staticMissing = base.missing.filter(reason => !observedMissing.has(reason));

  function validateSlotClock(at: StartupClock) {
    ordered(gammaClock, at);
    check(at.mono - gammaClock.mono <= 300_000, "capture_window");
    check(at.utc < identity.end, "gamma_window_or_rules");
  }

  function applyItem(item: BridgeStreamItem) {
    ordered(previous, item.at);
    validateSlotClock(item.at);
    previous = item.at;
    if (item.kind === "disconnect") throw Error("maker_source:stream_disconnected");
    if (item.kind === "sample") {
      if (lastSample) check(item.at.mono - lastSample.mono >= 1000 && item.at.utc > lastSample.utc, "sample_cadence");
      lastSample = item.at;
      if (fresh(item.at)) { feature = engine.compute(token, market, item.at.utc); sampledBook = book; }
      return;
    }
    check(item.kind === "frame", "unknown_stream_item");
    if (item.raw === "PONG") return;
    const frame: unknown = JSON.parse(item.raw);
    const messages = Array.isArray(frame) ? frame : [frame];
    check(messages.length > 0, "empty_frame");
    for (const message of messages) {
      const e = object(message);
      check(e.market === condition, "frame_market");
      if (e.event_type === "book") {
        const next = parseSnapshot(e, item.at, item.raw, messages.length === 1);
        if (next.observation.venueUtc < lastSelectedVenueUtc) {
          bookInvalidation = "BACKDATED_FULL_SNAPSHOT";
          continue;
        }
        store.upsertSnapshot(next.snapshot);
        book = next.observation;
        streamAnchored = true; bookInvalidation = null; lastSelectedVenueUtc = book.venueUtc;
      } else if (e.event_type === "price_change") {
        applyPriceChange(e, item.at, item.raw, messages.length === 1);
      } else if (e.event_type === "tick_size_change") {
        // Raw market channel schema in https://docs.polymarket.com/market-data/realtime-data
        check(messages.length === 1, "tick_change_mixed_frame");
        check(e.asset_id === token, "tick_change_asset");
        const venueUtc = venueTime(e.timestamp, item.at.utc);
        check(venueUtc >= Math.max(identity.start, lastSelectedVenueUtc, maxTradeVenueUtc), "backdated_tick_change");
        const oldTick = decimal(e.old_tick_size, true), newTick = decimal(e.new_tick_size, true);
        check(oldTick.units === tick.units, "tick_change_old_grid");
        check(newTick.units !== oldTick.units && documentedTickUnits.has(newTick.units), "tick_change_new_grid");
        // End this decoder epoch. Only the caller's fresh receipts can bind a new grid.
        throw new Error(OPERATING_TICK_SIZE_RESYNC);
      } else if (e.event_type === "last_trade_price") {
        check(e.asset_id === token && (e.side === "BUY" || e.side === "SELL"), "trade_identity_or_side");
        const venueUtc = venueTime(e.timestamp, item.at.utc);
        check(venueUtc >= identity.start, "trade_before_market");
        const p = price(e.price), size = decimal(e.size, true);
        check(size.units > 0n, "empty_trade");
        const tx = e.transaction_hash;
        check(tx === undefined || (typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx)), "trade_transaction_hash");
        const key = JSON.stringify([token, venueUtc, e.side, p.units.toString(), size.units.toString(), tx ?? null]);
        check(!seenTrades.has(key), "ambiguous_duplicate_trade");
        check(maxTradesPerSlot === undefined || tradeState.length < maxTradesPerSlot, "trade_capacity");
        seenTrades.add(key);
        maxTradeVenueUtc = Math.max(maxTradeVenueUtc, venueUtc);
        tradeState.push({ token, market, side: e.side, price: p.n, size: size.n, receipt: item.at,
          venueUtc, transactionHash: typeof tx === "string" ? tx : null, rawSha256: digest(item.raw) });
      } else throw Error("maker_source:unsupported_stream_event:" + String(e.event_type));
    }
  }

  function validateRead(decision: StartupClock) {
    if (failure) throw failure;
    validateSlotClock(decision);
    ordered(previous, decision);
  }

  return {
    process(event: BridgeStreamItem): void {
      if (failure) throw failure;
      try {
        // The caller may reuse its clock object; state owns its received clocks.
        applyItem({ ...event, at: { ...event.at } });
      } catch (error) {
        // A later member can fail after an earlier member of the same raw frame.
        // Never expose or resume that partially consumed prefix.
        failure = error instanceof Error ? error : new Error(String(error));
        throw failure;
      }
    },
    /** Frame/watchdog read. Its cost is independent of trade or feature history. */
    bookStatus(decision: StartupClock) {
      validateRead(decision);
      return { book: { ...book, receipt: { ...book.receipt } }, bookInvalidation, fresh: fresh(decision) };
    },
    snapshot(decision: StartupClock): Derived {
      validateRead(decision);
      const missing: string[] = [];
      if (!fresh(decision)) missing.push("FRESH_AUTHORITATIVE_ORIGINAL_BOOK");
      if (!feature || sampledBook !== book || decision.utc - feature.ts > 1000) missing.push("CURRENT_CANONICAL_FEATURE_SAMPLE");
      if (feature?.vol30m == null) missing.push("OBSERVED_VOLATILITY_HISTORY");
      if (tradeState.length === 0) missing.push("OBSERVED_ORIGINAL_TOKEN_TRADE_FLOW");
      // No consumer may mutate the basis of a later observation. Copy witnesses,
      // never historical frame bytes, maps or feature buffers.
      return structuredClone({ ...base, book, bookInvalidation, feature, trades: tradeState,
        missing: [...missing, ...staticMissing] });
    },
  };
}
