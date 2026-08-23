#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type LoopName = "maker" | "taker";
type LoopEnv = "live" | "paper" | "shadow";
type WhyIdleCode =
  | "feed_stale"
  | "no_candidates"
  | "all_filtered_wallet_eligibility"
  | "all_filtered_side_filters"
  | "all_filtered_regime_blocked"
  | "all_filtered_score_below_min"
  | "all_filtered_risk"
  | "regime_not_loaded_no_last_good"
  | "throttled_relax_cooldown"
  | "max_explore_attempts_reached"
  | "order_submit_failed";

type LoopTrace = {
  loop: LoopName;
  ts: number;
  tickId: number;
  env: LoopEnv;
  feed: {
    isFresh: boolean;
    ageSec: number | null;
    lastUpdateTs: number | null;
    freshnessThresholdSec: number;
  };
  candidates: {
    generated: number;
    afterWalletEligibility: number;
    afterSideFilters: number;
    afterRisk: number;
    afterRegime: number;
  };
  regimeLoad: {
    manifestStampWanted: string | null;
    manifestStampLoaded: string | null;
    usedLastGood: boolean;
    reasonCode: string | null;
  };
  topDecisions: Array<{
    marketId: string | null;
    tokenId: string;
    stateId: number | null;
    kind: string;
    mode: string | null;
    scoreBps: number | null;
    edgeLcbBps: number | null;
    edgeUcbBps: number | null;
    pFillLcb: number | null;
    sizeMultiplier: number | null;
    reasonCode: string;
    reasonDetail: string | null;
    filteredBy: string | null;
  }>;
  outcome: {
    placedOrders: number;
    whyIdle: {
      code: WhyIdleCode;
      detail: string;
    } | null;
  };
};

type RegimeRow = {
  walletId: number;
  kind: string;
  stateId: number | null;
  allowed: boolean;
  mode: "full" | "explore" | "blocked";
  sizeMultiplier: number;
  reasonCode: string;
  reasonDetail: string | null;
  scoreBps: number | null;
  edgeLcbBps: number | null;
  edgeUcbBps: number | null;
  pFillLcb: number | null;
};

export type ReplayInput = {
  env?: LoopEnv;
  regimeLoad?: {
    manifestStampWanted?: string | null;
    manifestStampLoaded?: string | null;
    usedLastGood?: boolean;
    reasonCode?: string | null;
  };
  regimeRows?: RegimeRow[];
  maker?: {
    feed?: {
      ageSec?: number | null;
      freshnessThresholdSec?: number | null;
      lastUpdateTs?: number | null;
    };
    candidates: Array<{
      marketId: string | null;
      tokenId: string;
      walletId: number;
      stateId: number | null;
      hasBid: boolean;
      hasAsk: boolean;
    }>;
  };
  taker?: {
    feed?: {
      ageSec?: number | null;
      freshnessThresholdSec?: number | null;
      lastUpdateTs?: number | null;
    };
    opportunities: Array<{
      marketId: string | null;
      tokenId: string;
      walletId: number;
      stateId: number | null;
      signal: "BUY" | "SELL";
      confidence: number;
      netEdgeBps: number;
    }>;
  };
};

export type ReplayTickOutput = {
  makerTrace: LoopTrace | null;
  takerTrace: (LoopTrace & { ranked: Array<{ tokenId: string; kind: string; score: number }> }) | null;
};

const parseArgs = (): Map<string, string> => {
  const out = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw || !raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      out.set(raw.slice(2, eq), raw.slice(eq + 1));
      continue;
    }
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.set(key, next);
      i += 1;
      continue;
    }
    out.set(key, "true");
  }
  return out;
};

const makeFeed = (
  now: number,
  input: { ageSec?: number | null; freshnessThresholdSec?: number | null; lastUpdateTs?: number | null } | undefined
) => {
  const ageSec = input?.ageSec ?? null;
  const threshold = Math.max(1, Number(input?.freshnessThresholdSec ?? 20));
  const lastUpdateTs = input?.lastUpdateTs ?? (ageSec != null ? now - (ageSec * 1000) : null);
  const isFresh = ageSec != null && Number.isFinite(ageSec) && ageSec <= threshold;
  return {
    isFresh,
    ageSec,
    lastUpdateTs,
    freshnessThresholdSec: threshold
  };
};

const emptyCounts = () => ({
  generated: 0,
  afterWalletEligibility: 0,
  afterSideFilters: 0,
  afterRisk: 0,
  afterRegime: 0
});

const decisionIndex = (rows: RegimeRow[]): Map<string, RegimeRow> => {
  const map = new Map<string, RegimeRow>();
  for (const row of rows) {
    map.set(`${row.walletId}|${row.kind}|${row.stateId ?? "null"}`, row);
  }
  return map;
};

const fallbackDecision = (kind: string): RegimeRow => ({
  walletId: -1,
  kind,
  stateId: null,
  allowed: true,
  mode: "explore",
  sizeMultiplier: 0.25,
  reasonCode: "sparse_explore",
  reasonDetail: "replay_default_no_row",
  scoreBps: null,
  edgeLcbBps: null,
  edgeUcbBps: null,
  pFillLcb: null
});

const whyIdle = (args: {
  feed: LoopTrace["feed"];
  placedOrders: number;
  counts: ReturnType<typeof emptyCounts>;
  reasonCounts: Map<string, number>;
  regimeReasonCode: string | null;
}): LoopTrace["outcome"]["whyIdle"] => {
  if (args.placedOrders > 0) return null;
  const reasons = Array.from(args.reasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}:${count}`)
    .join(",");
  if (!args.feed.isFresh) return { code: "feed_stale", detail: reasons || "feed_stale" };
  if (args.counts.generated === 0) return { code: "no_candidates", detail: reasons || "no_candidates" };
  if (args.counts.afterWalletEligibility === 0) {
    return { code: "all_filtered_wallet_eligibility", detail: reasons || "wallet_eligibility" };
  }
  if (args.counts.afterSideFilters === 0) {
    return { code: "all_filtered_side_filters", detail: reasons || "side_filters" };
  }
  if (args.counts.afterRegime === 0) {
    if (args.regimeReasonCode === "not_loaded_no_last_good") {
      return { code: "regime_not_loaded_no_last_good", detail: reasons || "regime_not_loaded" };
    }
    if ((args.reasonCounts.get("score_below_min") ?? 0) > 0) {
      return { code: "all_filtered_score_below_min", detail: reasons || "score_below_min" };
    }
    return { code: "all_filtered_regime_blocked", detail: reasons || "regime_blocked" };
  }
  if (args.counts.afterRisk === 0) return { code: "all_filtered_risk", detail: reasons || "risk" };
  return { code: "no_candidates", detail: reasons || "none" };
};

export const replayTick = (input: ReplayInput, now = Date.now()): ReplayTickOutput => {
  const env = input.env ?? "paper";
  const rows = input.regimeRows ?? [];
  const byKey = decisionIndex(rows);
  const load = {
    manifestStampWanted: input.regimeLoad?.manifestStampWanted ?? null,
    manifestStampLoaded: input.regimeLoad?.manifestStampLoaded ?? null,
    usedLastGood: input.regimeLoad?.usedLastGood ?? false,
    reasonCode: input.regimeLoad?.reasonCode ?? null
  };

  const makerTrace = (() => {
    if (!input.maker) return null;
    const feed = makeFeed(now, input.maker.feed);
    const counts = emptyCounts();
    const reasons = new Map<string, number>();
    const top: LoopTrace["topDecisions"] = [];

    for (const candidate of input.maker.candidates) {
      counts.afterWalletEligibility += 1;
      for (const side of ["MAKER_BID", "MAKER_ASK"] as const) {
        const enabled = side === "MAKER_BID" ? candidate.hasBid : candidate.hasAsk;
        if (!enabled) continue;
        counts.generated += 1;
        counts.afterRisk += 1;
        const row = byKey.get(`${candidate.walletId}|${side}|${candidate.stateId ?? "null"}`) ?? fallbackDecision(side);
        const filteredBy = row.allowed && row.sizeMultiplier > 0 ? null : row.reasonCode;
        if (!filteredBy) {
          counts.afterRegime += 1;
        } else {
          reasons.set(filteredBy, (reasons.get(filteredBy) ?? 0) + 1);
        }
        if (top.length < 10) {
          top.push({
            marketId: candidate.marketId,
            tokenId: candidate.tokenId,
            stateId: candidate.stateId,
            kind: side,
            mode: row.mode,
            scoreBps: row.scoreBps,
            edgeLcbBps: row.edgeLcbBps,
            edgeUcbBps: row.edgeUcbBps,
            pFillLcb: row.pFillLcb,
            sizeMultiplier: row.sizeMultiplier,
            reasonCode: row.reasonCode,
            reasonDetail: row.reasonDetail,
            filteredBy
          });
        }
      }
    }

    counts.afterSideFilters = counts.generated;
    const placedOrders = counts.afterRegime;
    return {
      loop: "maker" as const,
      ts: now,
      tickId: 1,
      env,
      feed,
      candidates: counts,
      regimeLoad: load,
      topDecisions: top,
      outcome: {
        placedOrders,
        whyIdle: whyIdle({
          feed,
          placedOrders,
          counts,
          reasonCounts: reasons,
          regimeReasonCode: load.reasonCode
        })
      }
    };
  })();

  const takerTrace = (() => {
    if (!input.taker) return null;
    const feed = makeFeed(now, input.taker.feed);
    const counts = emptyCounts();
    const reasons = new Map<string, number>();
    const top: LoopTrace["topDecisions"] = [];
    const ranked: Array<{ tokenId: string; kind: string; score: number }> = [];

    counts.generated = input.taker.opportunities.length;
    counts.afterSideFilters = input.taker.opportunities.length;

    for (const opp of input.taker.opportunities) {
      counts.afterWalletEligibility += 1;
      const kind = opp.signal === "BUY" ? "TAKER_BUY" : "TAKER_SELL";
      const row = byKey.get(`${opp.walletId}|${kind}|${opp.stateId ?? "null"}`) ?? fallbackDecision(kind);
      const filteredBy = row.allowed && row.sizeMultiplier > 0 ? null : row.reasonCode;
      if (!filteredBy) {
        counts.afterRegime += 1;
        counts.afterRisk += 1;
        ranked.push({ tokenId: opp.tokenId, kind, score: row.scoreBps ?? opp.netEdgeBps });
      } else {
        reasons.set(filteredBy, (reasons.get(filteredBy) ?? 0) + 1);
      }
      if (top.length < 10) {
        top.push({
          marketId: opp.marketId,
          tokenId: opp.tokenId,
          stateId: opp.stateId,
          kind,
          mode: row.mode,
          scoreBps: row.scoreBps,
          edgeLcbBps: row.edgeLcbBps,
          edgeUcbBps: row.edgeUcbBps,
          pFillLcb: row.pFillLcb,
          sizeMultiplier: row.sizeMultiplier,
          reasonCode: row.reasonCode,
          reasonDetail: row.reasonDetail,
          filteredBy
        });
      }
    }

    ranked.sort((a, b) => b.score - a.score);
    const placedOrders = counts.afterRisk;
    return {
      loop: "taker" as const,
      ts: now,
      tickId: 1,
      env,
      feed,
      candidates: counts,
      regimeLoad: load,
      topDecisions: top,
      outcome: {
        placedOrders,
        whyIdle: whyIdle({
          feed,
          placedOrders,
          counts,
          reasonCounts: reasons,
          regimeReasonCode: load.reasonCode
        })
      },
      ranked
    };
  })();

  return {
    makerTrace,
    takerTrace
  };
};

const main = (): void => {
  const args = parseArgs();
  const inputRaw = args.get("input");
  if (!inputRaw) {
    console.error("Usage: node apps/worker/dist/tools/replayTick.js --input <file>");
    process.exit(1);
  }

  const resolved = path.isAbsolute(inputRaw) ? inputRaw : path.join(process.cwd(), inputRaw);
  const input = JSON.parse(readFileSync(resolved, "utf-8")) as ReplayInput;
  const output = replayTick(input);
  console.log(
    JSON.stringify(
      {
        inputPath: resolved,
        ...output
      },
      null,
      2
    )
  );
};

const isMain = (() => {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  return pathToFileURL(path.resolve(argvPath)).href === import.meta.url;
})();

if (isMain) {
  main();
}
