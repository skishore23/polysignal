/** One admitted, isolated, no-fill paper startup. This is not a research solver or live gateway. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { StartupSourceCapture, STARTUP_METADATA_URL, currentSlotMetadataUrl, type RawCapture } from "./maker_startup_capture";
import { deriveMakerStartupInputs, type BridgeStreamItem } from "./maker_startup_source_bridge";
import { createIsolatedMaker, installStartupSink, newIsolatedStartupDatabase,
  type StartupClock, type StartupContract } from "./maker_quote_startup";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const sha = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function check(ok: unknown, reason: string): asserts ok { if (!ok) throw Error("paper_startup:" + reason); }
export const RUN_PROTOCOL = {
  schema: "CODEX_PAPER_STARTUP_PROTOCOL_V6", evidence: "PUBLIC_DEVELOPMENT_INPUTS_ONLY",
  metadataRecipe: "CURRENT_FIVE_MINUTE_SLOT_BY_DOCUMENTED_SLUG",
  metadataUrlTemplate: "https://gamma-api.polymarket.com/markets/slug/btc-updown-5m-{slotStartSeconds}",
  versions: ["v1", "v2"], maxReads: 4,
  perReadBodyBytes: 2097152, maxBodyBytes: 8388608, maxMessages: 20000, maxWallMs: 300000,
  byteScope: "application response/message bodies; framing and TLS/network bytes unknown",
  sourceReceipt: "delivered application event; OS/TLS/parser buffer arrival unknown",
  sampling: "actual monotonic interval >=1000ms; positive remainder rearm; no synthetic/catch-up samples",
  receiptJournal: "ordered append-only JSONL; geometric summary checkpoints; terminal exact replay verification",
  account: { cashUSDC: "10", shares: "0", pending: "0", paperProfile: "OWNER_6_USDC", perOrderUSDC: "6", totalLossUSDC: "6", exposureUSDC: "6", quoteSizing: "original configured target, rounded downward only" },
  fills: false, liveOrders: false, reconnect: false, retries: false, redirects: false,
  outcome: "original first outcome; preserve label and choose IDs by explicit protocol version",
  stop: "first risk-valid quote, market close, source failure, or original finite limit",
} as const;
const ENTRY_INPUTS = [
  "scripts/research/maker_paper_startup.ts", "scripts/research/maker_startup_capture.ts",
  "scripts/research/maker_startup_source_bridge.ts", "scripts/research/maker_quote_startup.ts",
  "tests/maker/fixtures/startup-canonical-schema.sql", "configs/worker.json",
  "apps/worker/src/maker/MakerLoop.ts", "apps/worker/src/maker/quoteSizing.ts", "apps/worker/src/belief/BeliefEngine.ts",
  "apps/worker/src/belief/MicrostructureBeliefProvider.ts", "apps/worker/src/regime/RegimeGate.ts",
  "apps/worker/src/trading/MarketProfile.ts", "packages/features/src/featureEngine.ts",
  "data/markov_regime.json", "data/strategy_regime_report.json", "data/regime_manifest.json",
  "apps/worker/src/config.ts", "apps/worker/src/utils/TaskScheduler.ts",
  "apps/worker/src/observability/ReachabilityTrace.ts", "package.json", "pnpm-lock.yaml", "tsconfig.base.json",
] as const;
function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? sourceFiles(dir + "/" + e.name) : e.isFile() && /\.(?:ts|js|json)$/.test(e.name) ? [dir + "/" + e.name] : []);
}
export const REQUIRED_INPUTS: string[] = [...new Set([...ENTRY_INPUTS,
  ...["packages/data/src", "packages/utils/src", "packages/book/src", "packages/features/src", "packages/storage/src",
    "apps/worker/src/trading", "apps/worker/src/belief", "apps/worker/src/regime"].flatMap(sourceFiles)])].sort();
export function inputHashes() { return Object.fromEntries(REQUIRED_INPUTS.map(p => [p, sha(readFileSync(path.join(ROOT, p)))])); }
type Selected = { market_id: string; condition_id: string; slug: string; protocol_version: "v1" | "v2";
  start_utc_ms: number; end_utc_ms: number; question: string; rules: string;
  outcomes: { label: "Yes" | "No" | "Up" | "Down"; token_id: string }[]; raw_row_index: number; semantic_admission: false };
export type MetadataSelection = { status: "STRUCTURAL_METADATA_ONLY" | "NO_ELIGIBLE_MARKET_IN_THIS_RESPONSE";
  selected: Selected | null; raw_body_sha256: string; quote_phase_admitted: false; rejected: unknown[] };
function array(x: unknown): any[] { const a = typeof x === "string" ? JSON.parse(x) : x; check(Array.isArray(a), "array"); return a; }
function utc(x: unknown): number {
  check(typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(x), "explicit_utc");
  const fraction = /\.(\d+)Z$/.exec(x)?.[1];
  check(!fraction || !/[1-9]/.test(fraction.slice(3)), "submillisecond_time");
  const t = Date.parse(x); check(Number.isSafeInteger(t), "utc_time"); return t;
}
/** Structural first-page selection only; no claim about all markets or live order eligibility. */
export function selectCurrentBtcMarket(capture: Pick<RawCapture, "raw" | "at" | "url">): MetadataSelection {
  const direct = /^https:\/\/gamma-api\.polymarket\.com\/markets\/slug\/btc-updown-5m-(\d{10})$/.exec(capture.url);
  check(capture.url === STARTUP_METADATA_URL || direct, "metadata_url");
  const decoded: any = JSON.parse(capture.raw);
  if (direct) {
    const slot = Number(direct[1]) * 1000;
    check(capture.url === currentSlotMetadataUrl(slot) && slot <= capture.at.utc
      && capture.at.utc <= slot + 240000, "current_slot_receipt");
    check(decoded && typeof decoded === "object" && !Array.isArray(decoded)
      && decoded.slug === "btc-updown-5m-" + direct[1], "exact_slug_object");
  }
  const rows: unknown = direct ? [decoded] : decoded;
  check(Array.isArray(rows) && rows.length <= 100, "one_page_schema");
  const candidates: Selected[] = [], rejected: unknown[] = [];
  rows.forEach((r: any, i: number) => {
    try {
      check(r && typeof r === "object" && !Array.isArray(r), "row");
      for (const [k, v] of Object.entries({ active: true, closed: false, archived: false, acceptingOrders: true, negRisk: false }))
        check(r[k] === v, "market_status:" + k);
      check(typeof r.id === "string" && /^\d+$/.test(r.id) && typeof r.conditionId === "string"
        && /^0x[0-9a-fA-F]{64}$/.test(r.conditionId) && typeof r.slug === "string"
        && /^btc-updown-5m-\d{10}$/.test(r.slug), "market_identity");
      check(r.version === "v1" || r.version === "v2", "explicit_market_version");
      const start = utc(r.eventStartTime), end = utc(r.endDate);
      check(start === Number(r.slug.slice(-10)) * 1000 && end - start === 300000
        && start <= capture.at.utc && capture.at.utc <= end - 60000, "current_five_minute_window");
      check(typeof r.question === "string" && r.question.trim() && typeof r.description === "string" && r.description.trim(), "original_rules");
      const labels = array(r.outcomes);
      const ids = r.version === "v2" ? r.positionIds : array(r.clobTokenIds);
      check(Array.isArray(ids) && ids.length === 2 && labels.length === 2 && ids[0] !== ids[1]
        && ["Yes,No", "No,Yes", "Up,Down", "Down,Up"].includes(labels.join(",")), "outcomes");
    check(ids.every((x: unknown) => typeof x === "string" && /^(0|[1-9]\d{0,79})$/.test(x)
        && BigInt(x) < (1n << 256n)), "original_asset_ids");
      candidates.push({ market_id: r.id, condition_id: r.conditionId, slug: r.slug, protocol_version: r.version,
        start_utc_ms: start, end_utc_ms: end, question: r.question, rules: r.description,
        outcomes: labels.map((label, j) => ({ label, token_id: ids[j] })), raw_row_index: i, semantic_admission: false });
    } catch (e) { rejected.push({ row_index: i, reason: String(e) }); }
  });
  for (const key of ["market_id", "condition_id", "slug"] as const)
    check(new Set(candidates.map(c => c[key])).size === candidates.length, "ambiguous_metadata:" + key);
  const all = candidates.flatMap(c => c.outcomes.map(x => x.token_id));
  check(new Set(all).size === all.length, "ambiguous_asset_mapping");
  candidates.sort((a, b) => a.end_utc_ms - b.end_utc_ms || a.market_id.localeCompare(b.market_id));
  return { status: candidates.length ? "STRUCTURAL_METADATA_ONLY" : "NO_ELIGIBLE_MARKET_IN_THIS_RESPONSE",
    selected: candidates[0] ?? null, raw_body_sha256: sha(capture.raw), quote_phase_admitted: false, rejected };
}

type Admission = { schema: "CODEX_PAPER_STARTUP_ADMISSION_V6"; executionAdmitted: true;
  inputMode: "CURRENT_PUBLIC_CAPTURE" | "OFFLINE_FIXTURE"; runName: string; notBeforeUtcMs: number; expiresUtcMs: number;
  marketStartUtcMs?: number; metadataUrl?: string;
  protocolSha256: string; inputSha256: Record<string, string>; reviewFile: string; reviewSha256: string };
export function validateAdmission(a: Admission, now: StartupClock, offlineInjection = false) {
  check(a.schema === "CODEX_PAPER_STARTUP_ADMISSION_V6" && a.executionAdmitted === true, "independent_admission_required");
  check(["CURRENT_PUBLIC_CAPTURE", "OFFLINE_FIXTURE"].includes(a.inputMode)
    && (!offlineInjection || a.inputMode === "OFFLINE_FIXTURE"), "test_transport_in_live_evidence");
  check(/^maker-startup-[a-zA-Z0-9_-]{1,80}$/.test(a.runName), "run_identity");
  check(Number.isSafeInteger(a.notBeforeUtcMs) && Number.isSafeInteger(a.expiresUtcMs)
    && a.notBeforeUtcMs <= now.utc && now.utc < a.expiresUtcMs
    && a.expiresUtcMs - a.notBeforeUtcMs > 0 && a.expiresUtcMs - a.notBeforeUtcMs <= RUN_PROTOCOL.maxWallMs, "frozen_window");
  if (a.inputMode === "CURRENT_PUBLIC_CAPTURE")
    check(Number.isSafeInteger(a.marketStartUtcMs) && a.marketStartUtcMs === Math.floor(a.notBeforeUtcMs / 300000) * 300000
      && a.metadataUrl === currentSlotMetadataUrl(a.marketStartUtcMs!)
      && a.notBeforeUtcMs <= a.marketStartUtcMs! + 240000 && a.expiresUtcMs <= a.marketStartUtcMs! + 300000,
      "frozen_current_slot");
  check(a.protocolSha256 === sha(json(RUN_PROTOCOL)), "frozen_protocol");
  const hashes = inputHashes();
  check(Object.keys(a.inputSha256).length === REQUIRED_INPUTS.length
    && REQUIRED_INPUTS.every(p => a.inputSha256[p] === hashes[p]), "frozen_sources");
  const raw = readFileSync(a.reviewFile);
  check(sha(raw) === a.reviewSha256, "review_hash");
  const review = JSON.parse(raw.toString("utf8"));
  check(review.decision === "APPROVE_BOUNDED_PAPER_STARTUP_RUN"
    && review.runName === a.runName && review.inputMode === a.inputMode
    && review.protocolSha256 === a.protocolSha256 && review.inputSha256
    && REQUIRED_INPUTS.every(p => review.inputSha256[p] === hashes[p]), "review_source_or_scope");
}

type Derived = ReturnType<typeof deriveMakerStartupInputs>;
function upsert(db: Database.Database, table: string, row: Record<string, unknown>, key: string) {
  const keys = Object.keys(row), names = keys.join(",");
  db.prepare(`INSERT INTO ${table} (${names}) VALUES (${keys.map(() => "?").join(",")}) ON CONFLICT(${key}) DO UPDATE SET ${keys.filter(k => k !== key).map(k => `${k}=excluded.${k}`).join(",")}`)
    .run(...keys.map(k => row[k] ?? null));
}
/** All feature values come from canonical FeatureEngine and retained causal observations. */
export function syncEngineInputs(db: Database.Database, d: Derived, seen: Set<string>) {
  const i = d.identity, f = d.feature; check(f && d.feeRateBps !== null, "missing_engine_inputs");
  const ts = f.ts;
  db.transaction(() => {
    upsert(db, "markets", { id: i.market, condition_id: i.condition, slug: i.slug, question: i.question,
      active: 1, neg_risk: 0, volume: i.volume, liquidity: i.liquidity, updated_at: ts, created_at: i.start,
      minimum_tick_size: Number(d.book.tick), minimum_order_size: Number(d.book.minimumShares),
      maker_base_fee: d.makerBaseFee, taker_base_fee: d.takerBaseFee }, "id");
    for (const o of i.outcomes) upsert(db, "tokens", { id: o.token, market_id: i.market, outcome: o.label,
      updated_at: ts, fee_rate_bps: o.token === i.token ? d.feeRateBps : null }, "id");
    const columns: Record<string, string> = { ts: "ts", mid: "mid", spread: "spread", obi: "obi", microprice: "microprice",
      microprice_minus_mid: "micropriceMinusMid", bid_depth_top: "bidDepthTop", ask_depth_top: "askDepthTop",
      r10s: "r10s", r1m: "r1m", r5m: "r5m", accel_1m: "accel1m", skew_30m: "skew30m", entropy_30m: "entropy30m",
      vol30m: "vol30m", staleness_sec: "stalenessSec", best_bid: "bestBid", best_ask: "bestAsk" };
    upsert(db, "latest_features", { token_id: i.token, market_id: i.market,
      ...Object.fromEntries(Object.entries(columns).map(([col, prop]) => [col, (f as any)[prop] ?? null])), recv_ts_ms: d.book.receipt.utc }, "token_id");
    for (const t of d.trades) {
      const key = t.rawSha256 + ":" + t.venueUtc + ":" + t.token;
      if (seen.has(key)) continue;
      db.prepare("INSERT INTO clob_events(recv_ts_ms,conn_id,token_id,msg_type,payload_json) VALUES (?,?,?,?,?)")
        .run(t.receipt.utc, "isolated-startup-capture", t.token, "trade", JSON.stringify(t));
      seen.add(key);
    }
  })();
}

export async function runPaperStartup(admissionFile: string, test?: {
  clock: () => StartupClock; capture: StartupSourceCapture;
}) {
  const cpuStart = process.cpuUsage(), wallStart = performance.now();
  const rawAdmission = readFileSync(admissionFile), admission: Admission = JSON.parse(rawAdmission.toString("utf8"));
  const now = test?.clock ?? (() => ({ utc: Date.now(), mono: performance.now() }));
  validateAdmission(admission, now(), !!test);
  const out = path.join(ROOT, "reports/evidence", admission.runName);
  const capture = test?.capture ?? new StartupSourceCapture({ ...RUN_PROTOCOL, metadataUrl: admission.metadataUrl!,
    expiresUtcMs: admission.expiresUtcMs }, now, out);
  const sourceClock = () => { const f = capture.observationFrontier();
    return { ...now(), sourceSequence: f.sequence, sourceAvailable: f.open }; };
  writeFileSync(path.join(out, "frozen-admission.json"), rawAdmission, { flag: "wx" });
  writeFileSync(path.join(out, "frozen-protocol.json"), json(RUN_PROTOCOL), { flag: "wx" });
  const result: any = { schema: "CODEX_PAPER_STARTUP_RESULT_V6", inputMode: admission.inputMode,
    status: "STARTING", actualQuotes: 0, fills: 0, profitUSDC: null, actualAccountChargeUSD: null,
    admissionSha256: sha(rawAdmission), traces: [], startedAt: now() };
  const stream: BridgeStreamItem[] = [], seenTrades = new Set<string>();
  let db: Database.Database | null = null, sink: ReturnType<typeof installStartupSink> | null = null;
  let engine: ReturnType<typeof createIsolatedMaker> | null = null, stop = false, lastTick = -Infinity;
  const config = { ...JSON.parse(readFileSync(path.join(ROOT, "configs/worker.json"), "utf8")), executionMode: "PAPER" };
  check(config.belief?.sportsbook?.enabled === false, "external_belief_provider_forbidden");
  const log: any[] = [];
  const logger: any = Object.fromEntries(["info", "warn", "error", "debug", "trace", "fatal"].map(k => [k, (...args: unknown[]) => log.push({ level: k, args })]));
  try {
    const gamma = await capture.readMetadata(), selection = selectCurrentBtcMarket(gamma);
    writeFileSync(path.join(out, "selection.json"), json(selection));
    if (!selection.selected) { result.status = "NO_ELIGIBLE_MARKET_IN_THIS_RESPONSE"; return result; }
    const s = selection.selected, first = s.outcomes[0]!;
    capture.bindMarket({ condition: s.condition_id, token: first.token_id, protocolVersion: s.protocol_version });
    const clobMarket = await capture.readMarket(), clobBook = await capture.readBook(), tokenFee = await capture.readFee();
    const derived = (decision: StartupClock) => deriveMakerStartupInputs({ gamma, selection, clobMarket, clobBook,
      tokenFee, stream, decision, originalLabel: first.label, topKLevels: config.topN });
    const initial = derived(now());
    const permanentGaps = initial.missing.filter(x => !["OBSERVED_VOLATILITY_HISTORY", "OBSERVED_ORIGINAL_TOKEN_TRADE_FLOW",
      "CURRENT_CANONICAL_FEATURE_SAMPLE", "FRESH_AUTHORITATIVE_ORIGINAL_BOOK"].includes(x));
    if (permanentGaps.length) { result.status = "SOURCE_METADATA_INCOMPLETE"; result.missing = permanentGaps; return result; }
    if (Number(initial.book.minimum) > Number(RUN_PROTOCOL.account.perOrderUSDC)) {
      result.status = "SKIP_VENUE_NOTIONAL_MINIMUM_EXCEEDS_PAPER_CAP";
      result.constraint = { venueMinimumNotionalUSDC: initial.book.minimum, perOrderUSDC: RUN_PROTOCOL.account.perOrderUSDC, totalLossUSDC: RUN_PROTOCOL.account.totalLossUSDC };
      return result;
    }
    const termination = await capture.stream({ shouldStop: () => stop,
      onMessage: async frame => { stream.push({ kind: "frame", raw: frame.raw, at: frame.at }); },
      onSample: async at => {
        stream.push({ kind: "sample", at });
        if (at.utc >= s.end_utc_ms) { result.status = "MARKET_ENDED_WITHOUT_QUOTE"; stop = true; return; }
        // Retain the actual sample clock even when source decoding rejects it.
        const trace: any = { at, missing: null, bookInvalidation: null, featureTs: null };
        result.traces.push(trace);
        let d: Derived;
        try { d = derived(at); }
        catch (e) { trace.failure = String(e); throw e; }
        Object.assign(trace, { missing: d.missing, bookInvalidation: d.bookInvalidation, featureTs: d.feature?.ts ?? null });
        if (d.missing.length || at.mono - lastTick < 10000) return;
        const captureSha256 = sha(json({ gamma, selection, clobMarket, clobBook, tokenFee, stream }));
        const contract: StartupContract = { paperProfile: RUN_PROTOCOL.account.paperProfile, purpose: admission.inputMode === "OFFLINE_FIXTURE" ? "SYNTHETIC_OFFLINE_ENGINEERING" : "PROSPECTIVE_PAPER_ENGINEERING",
          executionDeadlineUtc: Math.min(admission.expiresUtcMs, s.end_utc_ms),
          sourceFrontier: stream.filter(x => x.kind === "frame").length,
          market: d.identity.market, condition: d.identity.condition, wallet: 1,
          tokens: d.identity.outcomes.map(o => o.token) as [string, string],
          book: { ...d.book, sourceHash: captureSha256, valid: true }, fee: d.fee,
          evidence: { admissionSha256: sha(rawAdmission), captureSha256, mode: "PUBLIC_POLYMARKET_READ_ONLY", protocolVersion: s.protocol_version } };
        if (!db) {
          db = newIsolatedStartupDatabase(path.join(out, "paper.sqlite"), readFileSync(path.join(ROOT, "tests/maker/fixtures/startup-canonical-schema.sql"), "utf8"));
          sink = installStartupSink(db, contract, sourceClock);
          db.prepare("INSERT INTO wallets(id,name,starting_balance,created_at,maker_enabled,auto_trade_enabled,maker_inventory_max_abs) VALUES (1,'Explicit synthetic paper startup',10,?,1,0,50)").run(at.utc);
          engine = createIsolatedMaker(db, config, logger);
        } else sink!.updateObservation(contract);
        syncEngineInputs(db, d, seenTrades);
        lastTick = at.mono;
        await engine!.tick();
        trace.completedAt = sourceClock();
        result.gate = engine!.getGateDiagnostics();
        const snapshot = sink!.snapshot();
        trace.orders = snapshot.orders.length; trace.rejections = [...sink!.rejections];
        if (snapshot.orders.length) {
          result.actualQuotes = snapshot.orders.length;
          result.beforeCancel = snapshot;
          result.status = admission.inputMode === "OFFLINE_FIXTURE" ? "OFFLINE_ENGINE_TRACE_ONLY" : "PAPER_QUOTE_PENDING_INDEPENDENT_VERIFICATION";
          writeFileSync(path.join(out, "source-transcript.json"), json({ gamma, selection, clobMarket, clobBook, tokenFee, stream }));
          stop = true;
        }
      } });
    result.captureTermination = termination;
    if (result.status === "STARTING") result.status = termination.reason === "message_limit"
      ? "SOURCE_MESSAGE_BUDGET_EXHAUSTED_BEFORE_QUOTE" : "PAPER_WINDOW_ENDED_WITHOUT_RISK_VALID_QUOTE";
    return result;
  } catch (e) {
    result.failure = String(e);
    result.status = result.failure.includes("stream_application_limit")
      ? "SOURCE_APPLICATION_BODY_BUDGET_EXHAUSTED_BEFORE_QUOTE" : "FAILED_CLOSED";
    return result;
  }
  finally {
    // TypeScript cannot track assignments performed in the awaited stream callbacks.
    const finalSink = sink as ReturnType<typeof installStartupSink> | null;
    const finalDb = db as Database.Database | null;
    try {
      await capture.settleCallbacks();
      if (finalSink) {
        result.guardRejections = [...finalSink.rejections];
        result.beforeCancel ??= finalSink.snapshot();
        result.terminal = finalSink.cancelAll(); result.afterCancel = finalSink.snapshot();
      }
    } catch (e) { result.status = "FAILED_TERMINAL_RECONCILIATION"; result.cleanupFailure = String(e); }
    finally {
      result.sourceLedger = capture.ledger(); result.finishedAt = now(); result.engineLogs = log;
      result.readiness = { canonicalSampleAttempts: result.traces.length,
        engineTicks: result.traces.filter((t: any) => t.completedAt).length,
        accountCreated: finalDb !== null, nextBlockingInputs: result.traces.at(-1)?.missing ?? null };
      result.captureTermination ??= result.sourceLedger.termination ?? null;
      result.sourceAccountingScope = admission.inputMode === "OFFLINE_FIXTURE" ? "AUTHORED_OFFLINE_TRANSPORT_ONLY" : "ACTUAL_CAPTURE_ATTEMPTS";
      result.physicalSourceRequests = admission.inputMode === "OFFLINE_FIXTURE" ? 0 : null;
      result.resources = { processCpuMicroseconds: process.cpuUsage(cpuStart), wallMilliseconds: performance.now() - wallStart,
        maximumRssPlatformUnits: process.resourceUsage().maxRSS, accountChargeUSD: null };
      try { writeFileSync(path.join(out, "result.json"), json(result)); }
      finally { finalDb?.close(); }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--admission") throw Error("Usage: maker_paper_startup.ts --admission <frozen-file>");
  runPaperStartup(args[1]!).then(result => { console.log(json({ status: result.status, actualQuotes: result.actualQuotes, failure: result.failure ?? null }));
    if (result.status === "FAILED_CLOSED") process.exitCode = 1; });
}
