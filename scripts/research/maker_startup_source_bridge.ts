/** Pure decoding of retained public inputs for one isolated maker tick. */
import { createHash } from "node:crypto";
import { BookStore } from "../../packages/book/src/index";
import { FeatureEngine } from "../../packages/features/src/featureEngine";
import type { StartupClock } from "./maker_quote_startup";

export type BridgeHttpCapture = { url: string; raw: string; at: StartupClock };
export type BridgeStreamItem =
  | { kind: "frame"; raw: string; at: StartupClock }
  | { kind: "sample" | "disconnect"; at: StartupClock };
export type MakerStartupSourceInput = {
  gamma: BridgeHttpCapture;
  selection: unknown; // Output of maker_metadata_phase_a.select on these exact bytes.
  clobMarket: BridgeHttpCapture;
  clobBook: BridgeHttpCapture;
  tokenFee?: BridgeHttpCapture;
  stream: readonly BridgeStreamItem[];
  decision: StartupClock;
  originalLabel: "Yes" | "No" | "Up" | "Down";
  topKLevels: number; // Same setting as the worker's FeatureEngine.
};

const gammaUrl = "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=endDate&ascending=true";
// Venue limit-order precision table and pinned @polymarket/clob-client 5.2.1 agree for the four supported ticks.
const lotSource = "https://docs.polymarket.com/trading/place-orders#calculate-the-order-amounts";
const makerFeeSource = "https://docs.polymarket.com/trading/fees";
const clob = "https://clob.polymarket.com";
const scale = 1_000_000_000n;
const maxAssetId = (1n << 256n) - 1n;
const digest = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");
function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error("maker_source:" + reason);
}
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "object_required");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  const a = typeof value === "string" ? JSON.parse(value) : value;
  check(Array.isArray(a), "array_required");
  return a;
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
function read(capture: BridgeHttpCapture, expected: string): unknown {
  check(capture.url === expected, "receipt_url");
  return JSON.parse(capture.raw);
}
function original(input: MakerStartupSourceInput) {
  const receipt = object(input.selection);
  check(receipt.raw_body_sha256 === digest(input.gamma.raw) && receipt.status === "STRUCTURAL_METADATA_ONLY"
    && receipt.quote_phase_admitted === false, "gamma_selection_binding");
  const s = object(receipt.selected);
  check(Number.isInteger(s.raw_row_index) && s.semantic_admission === false, "gamma_selection_shape");
  let row: Record<string, unknown>;
  if (input.gamma.url === gammaUrl) {
    const page = read(input.gamma, gammaUrl);
    check(Array.isArray(page) && page.length <= 100, "gamma_selection_shape");
    row = object(page[s.raw_row_index as number]);
  } else {
    // The admission binds the exact slot before the request. The bridge binds that
    // route, the raw object and its projected row without re-serializing the receipt.
    const slotSeconds = Math.floor(input.gamma.at.utc / 300_000) * 300;
    const slotSlug = "btc-updown-5m-" + slotSeconds;
    const slotUrl = "https://gamma-api.polymarket.com/markets/slug/" + slotSlug;
    check(s.raw_row_index === 0, "gamma_slot_row_index");
    row = object(read(input.gamma, slotUrl));
    check(row.slug === slotSlug, "gamma_slot_slug");
  }
  const protocolVersion = row.version;
  check(protocolVersion === "v1" || protocolVersion === "v2", "unsupported_gamma_market_version");
  if (s.protocol_version !== undefined) check(s.protocol_version === protocolVersion, "selection_version");
  const market = string(row.id), condition = string(row.conditionId), slug = string(row.slug);
  check(/^\d+$/.test(market) && /^0x[0-9a-fA-F]{64}$/.test(condition) && /^btc-updown-5m-\d{10}$/.test(slug)
    && market === s.market_id && condition === s.condition_id && slug === s.slug, "gamma_identity");
  check(row.active === true && row.closed === false && row.archived === false && row.acceptingOrders === true
    && row.negRisk === false, "gamma_market_status");
  const question = string(row.question), rules = string(row.description);
  const start = Date.parse(string(row.eventStartTime)), end = Date.parse(string(row.endDate));
  check(start === Number(slug.slice(-10)) * 1000 && end - start === 300_000 && start === s.start_utc_ms
    && end === s.end_utc_ms && input.gamma.at.utc >= start && input.gamma.at.utc <= end - 60_000
    && input.decision.utc < end && question === s.question && rules === s.rules, "gamma_window_or_rules");
  if (protocolVersion === "v2") check(Array.isArray(row.positionIds), "v2_position_ids_required");
  const tokens = protocolVersion === "v2" ? array(row.positionIds) : array(row.clobTokenIds);
  const labels = array(row.outcomes), selected = array(s.outcomes);
  check(tokens.length === 2 && labels.length === 2 && selected.length === 2
    && tokens[0] !== tokens[1] && (["Yes,No", "No,Yes", "Up,Down", "Down,Up"].includes(labels.join(","))),
    "original_outcomes");
  const outcomes = labels.map((l, i) => {
    const label = string(l), token = string(tokens[i]);
    const claimed = object(selected[i]);
    check(/^(0|[1-9]\d{0,77})$/.test(token) && BigInt(token) <= maxAssetId
      && claimed.label === label && claimed.token_id === token, "original_outcome_mapping");
    return { label, token };
  });
  const outcome = outcomes.find(x => x.label === input.originalLabel);
  check(outcome, "original_label_absent");
  check(typeof row.orderMinSize === "number" && typeof row.orderPriceMinTickSize === "number", "gamma_trading_constraints");
  if (protocolVersion === "v2") check(row.enableOrderBook === true, "gamma_order_book_disabled");
  if (row.feesEnabled != null) check(typeof row.feesEnabled === "boolean", "gamma_fee_enabled");
  const schedule = row.feeSchedule == null ? null : object(row.feeSchedule);
  if (schedule) check(typeof schedule.takerOnly === "boolean", "gamma_fee_schedule");
  return { market, condition, slug, question, rules, start, end, outcomes, token: outcome.token,
    protocolVersion: protocolVersion as "v1" | "v2", minimumNotional: decimal(row.orderMinSize).text,
    minimumTick: decimal(row.orderPriceMinTickSize).text, feesEnabled: row.feesEnabled ?? null,
    feeSchedule: schedule ? {rate: decimal(schedule.rate).text, exponent: decimal(schedule.exponent).n,
      takerOnly: schedule.takerOnly === true, rebateRate: schedule.rebateRate == null ? null : decimal(schedule.rebateRate).text} : null,
    label: outcome.label, volume: row.volume == null ? null : decimal(row.volume).n,
    liquidity: row.liquidity == null ? null : decimal(row.liquidity).n };
}
function feeRate(capture: BridgeHttpCapture, token: string): number {
  const row = object(read(capture, clob + "/fee-rate?token_id=" + token));
  if (row.token_id !== undefined) check(row.token_id === token, "fee_token");
  // Official GET /fee-rate response requires integer base_fee, in bps.
  const bps = row.base_fee;
  check(typeof bps === "number" && Number.isSafeInteger(bps) && bps >= 0
    && (row.fee_rate_bps === undefined || decimal(row.fee_rate_bps).n === bps), "fee_rate_schema");
  return bps;
}
function venueTime(value: unknown, receiveUtc: number) {
  check(typeof value === "string" && /^\d{13}$/.test(value), "venue_timestamp");
  const t = Number(value);
  check(t <= receiveUtc, "future_venue_time");
  return t;
}

export function deriveMakerStartupInputs(input: MakerStartupSourceInput) {
  ordered(input.gamma.at, input.clobMarket.at);
  ordered(input.clobMarket.at, input.clobBook.at);
  ordered(input.gamma.at, input.decision);
  check(input.decision.mono - input.gamma.at.mono <= 300000, "capture_window");
  check(Number.isSafeInteger(input.topKLevels) && input.topKLevels > 0, "feature_depth");
  const identity = original(input);
  const { market, condition, slug, token } = identity;
  const v2 = identity.protocolVersion === "v2";
  const m = object(read(input.clobMarket, clob + (v2 ? "/clob-markets/" : "/markets/") + condition));
  if (!v2) {
    check(m.condition_id === condition && m.market_slug === slug && m.question === identity.question
      && m.description === identity.rules, "clob_market_identity_or_rules");
    check(m.active === true && m.closed === false && m.archived === false && m.accepting_orders === true
      && m.enable_order_book === true && m.neg_risk === false, "clob_market_status");
  } else if (m.condition_id !== undefined) check(m.condition_id === condition, "clob_market_identity_or_rules");
  const rawMembers = v2 ? m.t : m.tokens;
  check(Array.isArray(rawMembers) && rawMembers.length === 2, "clob_tokens");
  const members = rawMembers.map(object);
  check(identity.outcomes.every(o => members.some(x =>
    v2 ? x.o === o.label && x.t === o.token : x.outcome === o.label && x.token_id === o.token)), "clob_token_mapping");
  if (v2) check(typeof m.mts === "number" && typeof m.mos === "number", "v2_clob_trading_constraints");
  const tick = decimal(v2 ? m.mts : m.minimum_tick_size);
  const marketMinimum = decimal(v2 ? m.mos : m.minimum_order_size);
  const minimum = decimal(identity.minimumNotional);
  const supportedTick = [100000000n, 10000000n, 1000000n, 100000n].includes(tick.units)
    || (v2 && tick.units === 5000000n);
  check(supportedTick && minimum.units > 0n && marketMinimum.units > 0n
    && tick.units === decimal(identity.minimumTick).units, "tick_or_minimum");
  const rest = object(read(input.clobBook, clob + "/book?token_id=" + token));
  check(v2 ? rest.version === "v2" : rest.version === undefined, "unsupported_book_version");
  const minimumShares = decimal(rest.min_order_size, true);
  check(decimal(rest.tick_size, true).units === tick.units && minimumShares.units > 0n
    && rest.neg_risk === false, "book_market_limits");
  // Compact mos is labeled only "minimum order size". Both explicitly sourced bounds cover
  // it in either unit only when it exceeds neither. Preserve unresolved metadata otherwise.
  const minimumUnitUnresolved = marketMinimum.units > minimumShares.units || marketMinimum.units > minimum.units;
  const curve = v2 && m.fd != null ? object(m.fd) : null;
  if (curve) check(typeof curve.to === "boolean", "v2_fee_curve");
  const clobFeeCurve = curve ? { rate: decimal(curve.r).text, exponent: decimal(curve.e).n, takerOnly: curve.to === true } : null;
  if (identity.feeSchedule && clobFeeCurve) check(decimal(identity.feeSchedule.rate).units === decimal(clobFeeCurve.rate).units
    && identity.feeSchedule.exponent === clobFeeCurve.exponent && identity.feeSchedule.takerOnly === clobFeeCurve.takerOnly,
    "conflicting_fee_curves");
  const orderAgeSeconds = v2 && m.oas != null ? m.oas : null;
  check(orderAgeSeconds === null || (typeof orderAgeSeconds === "number" && Number.isSafeInteger(orderAgeSeconds)
    && orderAgeSeconds >= 0), "clob_minimum_order_age");
  const store = new BookStore();
  const engine = new FeatureEngine(store, { topKLevels: input.topKLevels, returnWindowSec: 10,
    volWindowSec: 1800, sampleIntervalSec: 1 });
  const price = (v: unknown) => {
    const p = decimal(v, true);
    check(p.units > 0n && p.units < scale && p.units % tick.units === 0n, "price_grid");
    return p;
  };
  function snapshot(row: Record<string, unknown>, at: StartupClock, raw: string) {
    check(row.asset_id === token && row.market === condition, "book_identity");
    if (row.version !== undefined) check(v2 && row.version === "v2", "unsupported_book_version");
    const venueUtc = venueTime(row.timestamp, at.utc);
    const levels = (values: unknown) => {
      check(Array.isArray(values) && values.length > 0, "empty_book_side");
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
    store.upsertSnapshot({ tokenId: token, marketId: market, hash, bids, asks, ts: venueUtc, recvTsMs: at.utc });
    const book = store.getBook(token)!;
    check(book.bids[0]!.price < book.asks[0]!.price, "crossed_book");
    return { token, bid: String(book.bids[0]!.price), ask: String(book.asks[0]!.price), tick: tick.text,
      minimum: minimum.text, minimumUnit: "USDC_NOTIONAL" as const, minimumShares: minimumShares.text,
      marketMinimum: marketMinimum.text, lot: "0.01", lotSource, receipt: at, venueUtc, rawSha256: digest(raw), venueHash: hash };
  }
  let book = snapshot(rest, input.clobBook.at, input.clobBook.raw);
  let previous = input.clobBook.at;
  if (input.tokenFee) { ordered(previous, input.tokenFee.at); previous = input.tokenFee.at; }
  const feeRateBps = input.tokenFee ? feeRate(input.tokenFee, token) : null;
  function baseFee(v: unknown) {
    if (v == null) return null;
    check(typeof v === "number" && Number.isSafeInteger(v) && v >= 0, "market_base_fee");
    return v;
  }
  const makerBaseFee = baseFee(v2 ? m.mbf : m.maker_base_fee);
  const takerBaseFee = baseFee(v2 ? m.tbf : m.taker_base_fee);
  const trades: { token: string; market: string; side: "BUY" | "SELL"; price: number; size: number;
    receipt: StartupClock; venueUtc: number; transactionHash: string | null; rawSha256: string }[] = [];
  const seenTrades = new Set<string>();
  let feature: ReturnType<FeatureEngine["compute"]> | null = null;
  let lastSample: StartupClock | null = null;
  let sampledBook: typeof book | null = null;
  let valid = true;
  const fresh = (at: StartupClock) => valid && at.utc - book.receipt.utc <= 1000 && at.mono - book.receipt.mono <= 1000
    && book.receipt.utc - book.venueUtc <= 1000 && at.utc - book.venueUtc <= 1000;
  for (const item of input.stream) {
    ordered(previous, item.at);
    ordered(input.gamma.at, item.at);
    previous = item.at;
    if (item.kind === "disconnect") throw Error("maker_source:stream_disconnected");
    if (item.kind === "sample") {
      if (lastSample) check(item.at.mono - lastSample.mono >= 1000 && item.at.utc > lastSample.utc, "sample_cadence");
      lastSample = item.at;
      if (fresh(item.at)) { feature = engine.compute(token, market, item.at.utc); sampledBook = book; }
      continue;
    }
    check(item.kind === "frame", "unknown_stream_item");
    if (item.raw === "PONG") continue;
    const frame: unknown = JSON.parse(item.raw);
    const messages = Array.isArray(frame) ? frame : [frame];
    check(messages.length > 0, "empty_frame");
    for (const message of messages) {
      const e = object(message);
      check(e.market === condition, "frame_market");
      if (e.event_type === "book") {
        const next = snapshot(e, item.at, item.raw);
        check(next.venueUtc >= book.venueUtc, "backdated_book");
        book = next; valid = true;
      } else if (e.event_type === "price_change") {
        // An unverified delta can never advance a book or refresh its age.
        valid = false;
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
        seenTrades.add(key);
        trades.push({ token, market, side: e.side, price: p.n, size: size.n, receipt: item.at,
          venueUtc, transactionHash: typeof tx === "string" ? tx : null, rawSha256: digest(item.raw) });
      } else throw Error("maker_source:unsupported_stream_event:" + String(e.event_type));
    }
  }
  ordered(previous, input.decision);
  const missing: string[] = [];
  if (!fresh(input.decision)) missing.push("FRESH_AUTHORITATIVE_ORIGINAL_BOOK");
  if (!feature || sampledBook !== book || input.decision.utc - feature.ts > 1000) missing.push("CURRENT_CANONICAL_FEATURE_SAMPLE");
  if (feature?.vol30m == null) missing.push("OBSERVED_VOLATILITY_HISTORY");
  if (trades.length === 0) missing.push("OBSERVED_ORIGINAL_TOKEN_TRADE_FLOW");
  if (feeRateBps === null) missing.push("ORIGINAL_TOKEN_FEE_RATE_BPS");
  const takerOnly = identity.feeSchedule?.takerOnly ?? clobFeeCurve?.takerOnly ?? null;
  const bound = (makerBaseFee === 0 || (makerBaseFee === null && takerOnly === true)) && takerOnly !== false;
  const fee = bound && feeRateBps !== null
    ? { perShareUSDC: "0", provenance: makerFeeSource + "; Gamma " + digest(input.gamma.raw)
      + "; CLOB " + digest(input.clobMarket.raw) + "; token fee " + digest(input.tokenFee!.raw) }
    : null;
  if (minimumUnitUnresolved) missing.push("CLOB_MINIMUM_ORDER_SIZE_UNIT_UNRESOLVED");
  if (orderAgeSeconds !== null && orderAgeSeconds > 0) missing.push("POSITIVE_MINIMUM_ORDER_AGE_APPLICABILITY");
  if (!fee) missing.push("POST_ONLY_MAKER_FEE_BOUND");
  if (identity.volume === null || identity.liquidity === null) missing.push("OBSERVED_MARKET_VOLUME_AND_LIQUIDITY");
  return { identity, book, feature, trades, fee, feeRateBps, makerBaseFee, takerBaseFee, clobFeeCurve, orderAgeSeconds, missing,
    sourceHashes: { gamma: digest(input.gamma.raw), clobMarket: digest(input.clobMarket.raw),
      clobBook: digest(input.clobBook.raw), tokenFee: input.tokenFee ? digest(input.tokenFee.raw) : null } };
}
