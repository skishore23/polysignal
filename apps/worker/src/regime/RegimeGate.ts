import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Logger } from "../logger";
import { getRepoRoot } from "../config";
import { binValue, encodeState } from "@polysignal/data";
import { reachabilityHit } from "../observability/ReachabilityTrace";

export type RegimeGateConfig = {
  enabled: boolean;
  markovPath: string;
  strategyPath: string;
  /** Pair switch file written last by RegimeReportLoop. */
  manifestPath?: string;
  minCount: number;
  minWavgBps: number;
  minFillRate: number;
  reloadMs: number;
  failOpen: boolean;
  explicitHardBlocks?: string[];
  probabilistic?: {
    kEdge: number;
    zEdge: number;
    zFill: number;
    sigmaPriorBps: number;
    winsorClipBps: number;
    riskPenaltyBps: number;
    costBufferBps: number;
    hardBlockUpperBps: number;
    hardBlockMinCount: number;
    walletBlendK: number;
    minScoreByKind: Record<string, number>;
    exploreMinByKind: Record<string, number>;
    exploreMaxByKind: Record<string, number>;
    explicitHardBlocks: string[];
  };
  liveness?: {
    enabled: boolean;
    lookbackMs: number;
    feedFreshMaxAgeSec: number;
    minOrders5mMaker: number;
    minOrders5mTaker: number;
    relaxDurationMs: number;
    relaxCooldownMs: number;
    maxExploreOrdersPerWindow: number;
    allowInLive: boolean;
  };
};

type StrategyRow = {
  state: number;
  kind: string;
  walletId: number;
  count: number;
  markoutCount: number;
  orderCount: number;
  filledOrderCount: number;
  wavgBps: number | null;
  fillRate: number | null;
  markoutStdBps: number | null;
  markoutSeBps: number | null;
};

type PriorStats = {
  nMarkouts: number;
  muBps: number;
  nOrders: number;
  nFills: number;
  fillRate: number;
};

type LoadedSnapshot = {
  stamp: string;
  generatedAt: string | null;
  features: string[];
  bins: number;
  edges: Record<string, number[]>;
  strategyMap: Map<string, StrategyRow>;
  kindPrior: Map<string, PriorStats>;
  walletKindPrior: Map<string, PriorStats>;
};

type NormalizedErrorCode =
  | "missing_manifest"
  | "missing_json"
  | "manifest_mismatch"
  | "manifest_stamp_changed_without_manifest_update"
  | "invalid_manifest"
  | "invalid_markov"
  | "invalid_strategy"
  | "unknown";

export type RegimeGateLoadDiagnostics = {
  loaded: boolean;
  usingLastGood: boolean;
  lastLoadError: string | null;
  manifestStampWanted: string | null;
  manifestStampLoaded: string | null;
  manifestPath: string | null;
  manifestMtimeMs: number | null;
};

export type RegimeFeatureInput = {
  spread?: number | null;
  bidDepthTop?: number | null;
  askDepthTop?: number | null;
  obi?: number | null;
  vol30m?: number | null;
  micropriceMinusMid?: number | null;
};

export type RegimeDecisionContext = {
  lane?: "maker" | "taker";
  livenessRelax?: boolean;
  executionMode?: "PAPER" | "FULL";
};

type GateDecision = {
  allowed: boolean;
  state: number | null;
  reason: string;
};

export type RegimeDecisionMode = "full" | "explore" | "blocked";

export type RegimeDecision = GateDecision & {
  mode: RegimeDecisionMode;
  sizeMultiplier: number;
  reasonCode: string;
  reasonDetail: string | null;
  scoreBps: number | null;
  edgeLcbBps: number | null;
  edgeUcbBps: number | null;
  pFillLcb: number | null;
  wavgBps: number | null;
  count: number | null;
  fillRate: number | null;
  nOrders: number | null;
  nFills: number | null;
  nMarkouts: number | null;
};

type ManifestJson = {
  stamp?: string;
  generatedAt?: string;
  markovFile?: string;
  strategyFile?: string;
};

const readJson = <T,>(filePath: string): T => {
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
};

const toFinite = (value: unknown): number | null => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const clamp = (value: number, lo: number, hi: number): number => {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
};

const startsWithTaker = (kind: string): boolean => kind.startsWith("TAKER_");

const getOrDefault = (map: Record<string, number> | undefined, key: string, fallback: number): number => {
  const raw = map?.[key];
  return Number.isFinite(raw) ? Number(raw) : fallback;
};

const wilsonLowerBound = (successes: number, trials: number, z: number): number => {
  if (!Number.isFinite(trials) || trials <= 0) return 0;
  const n = trials;
  const p = clamp(successes / n, 0, 1);
  const zz = z * z;
  const denom = 1 + (zz / n);
  const center = p + (zz / (2 * n));
  const margin = z * Math.sqrt((p * (1 - p) / n) + (zz / (4 * n * n)));
  return clamp((center - margin) / denom, 0, 1);
};

export class RegimeGate {
  private readonly config: RegimeGateConfig;
  private readonly logger: Logger;
  private loaded = false;
  private usingLastGood = false;
  private lastLoadError: string | null = null;
  private lastLogTs = 0;
  private snapshot: LoadedSnapshot | null = null;
  private manifestStampWanted: string | null = null;
  private manifestStampLoaded: string | null = null;
  private manifestPathLoaded: string | null = null;
  private manifestMtimeMsLoaded: number | null = null;

  constructor(config: RegimeGateConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    if (this.config.enabled) {
      this.load();
      if (this.config.reloadMs > 0) {
        setInterval(() => this.load(), this.config.reloadMs).unref();
      }
    }
  }

  private decisionCounter = 0;

  public getLivenessConfig(): RegimeGateConfig["liveness"] {
    return this.config.liveness;
  }

  public getLoadDiagnostics(): RegimeGateLoadDiagnostics {
    return {
      loaded: this.loaded,
      usingLastGood: this.usingLastGood,
      lastLoadError: this.lastLoadError,
      manifestStampWanted: this.manifestStampWanted,
      manifestStampLoaded: this.manifestStampLoaded ?? this.snapshot?.stamp ?? null,
      manifestPath: this.manifestPathLoaded,
      manifestMtimeMs: this.manifestMtimeMsLoaded
    };
  }

  public allow(kind: string, walletId: number, feature: RegimeFeatureInput): GateDecision {
    const decision = this.decide(kind, walletId, feature);
    return {
      allowed: decision.allowed,
      state: decision.state,
      reason: decision.reason
    };
  }

  public decide(
    kind: string,
    walletId: number,
    feature: RegimeFeatureInput,
    context?: RegimeDecisionContext
  ): RegimeDecision {
    reachabilityHit("RegimeGate.decide");
    if (!this.config.enabled) {
      return this.decisionFrom({
        allowed: true,
        mode: "full",
        sizeMultiplier: 1,
        state: null,
        reasonCode: "disabled",
        reasonDetail: null,
        scoreBps: null,
        edgeLcbBps: null,
        edgeUcbBps: null,
        pFillLcb: null,
        row: null
      });
    }

    const state = this.computeState(feature);
    return this.decideForState(kind, walletId, state, context);
  }

  public decideForState(
    kind: string,
    walletId: number,
    state: number | null,
    context?: RegimeDecisionContext
  ): RegimeDecision {
    reachabilityHit("RegimeGate.decideForState");
    if (!this.config.enabled) {
      return this.decisionFrom({
        allowed: true,
        mode: "full",
        sizeMultiplier: 1,
        state,
        reasonCode: "disabled",
        reasonDetail: null,
        scoreBps: null,
        edgeLcbBps: null,
        edgeUcbBps: null,
        pFillLcb: null,
        row: null
      });
    }

    const snapshot = this.snapshot;
    if (!this.loaded || !snapshot) {
      const allowed = this.config.failOpen;
      const reasonCode = "not_loaded_no_last_good";
      return this.decisionFrom({
        allowed,
        mode: allowed ? "explore" : "blocked",
        sizeMultiplier: allowed ? this.getExploreMin(kind) : 0,
        state,
        reasonCode,
        reasonDetail: this.lastLoadError,
        scoreBps: null,
        edgeLcbBps: null,
        edgeUcbBps: null,
        pFillLcb: null,
        row: null
      });
    }

    if (state == null) {
      const allowed = this.config.failOpen;
      return this.decisionFrom({
        allowed,
        mode: allowed ? "explore" : "blocked",
        sizeMultiplier: allowed ? this.getExploreMin(kind) : 0,
        state,
        reasonCode: "no_state",
        reasonDetail: null,
        scoreBps: null,
        edgeLcbBps: null,
        edgeUcbBps: null,
        pFillLcb: null,
        row: null
      });
    }

    const row = this.lookupRow(snapshot.strategyMap, state, kind, walletId);
    const prior = this.computePrior(snapshot, kind, walletId);

    const nMarkouts = Math.max(0, row?.markoutCount ?? 0);
    const nOrders = Math.max(0, row?.orderCount ?? 0);
    const nFills = Math.max(0, row?.filledOrderCount ?? 0);
    const muState = row?.wavgBps ?? null;
    const seState =
      row?.markoutSeBps ??
      (row?.markoutStdBps != null && nMarkouts > 0 ? row.markoutStdBps / Math.sqrt(nMarkouts) : null);
    const fillRateState = row?.fillRate ?? (nOrders > 0 ? nFills / nOrders : null);

    const p = this.probConfig();
    const kEdge = Math.max(1, p.kEdge);
    const nEdge = Math.max(0, nMarkouts);
    const muPrior = prior.muBps;
    const muHat =
      muState != null && nEdge > 0
        ? ((nEdge / (nEdge + kEdge)) * muState) + ((kEdge / (nEdge + kEdge)) * muPrior)
        : muPrior;

    const seFloor = Math.max(0, p.sigmaPriorBps) / Math.sqrt(nEdge + 1);
    const seEdge = Math.max(seFloor, seState != null && Number.isFinite(seState) ? seState : 0);
    const edgeLcbBps = muHat - (Math.max(0, p.zEdge) * seEdge);
    const edgeUcbBps = muHat + (Math.max(0, p.zEdge) * seEdge);

    const pFillLcb = startsWithTaker(kind)
      ? 1
      : nOrders > 0
        ? wilsonLowerBound(nFills, nOrders, Math.max(0, p.zFill))
        : clamp(prior.fillRate, 0, 1);

    const scoreBps = startsWithTaker(kind)
      ? edgeLcbBps - p.riskPenaltyBps - p.costBufferBps
      : (pFillLcb * edgeLcbBps) - p.riskPenaltyBps - p.costBufferBps;

    const explicitBlockKey = `${state}|${kind}`;
    const hasExplicitBlock = p.explicitHardBlockSet.has(explicitBlockKey);
    if (hasExplicitBlock) {
      this.maybeLogDecision(state, kind, walletId, row, "explicit_block");
      return this.decisionFrom({
        allowed: false,
        mode: "blocked",
        sizeMultiplier: 0,
        state,
        reasonCode: "explicit_block",
        reasonDetail: this.withLoadDetail(`state_kind=${explicitBlockKey}`),
        scoreBps,
        edgeLcbBps,
        edgeUcbBps,
        pFillLcb,
        row
      });
    }

    if (nMarkouts >= p.hardBlockMinCount && edgeUcbBps < p.hardBlockUpperBps) {
      this.maybeLogDecision(state, kind, walletId, row, "ucb_negative");
      return this.decisionFrom({
        allowed: false,
        mode: "blocked",
        sizeMultiplier: 0,
        state,
        reasonCode: "ucb_negative",
        reasonDetail: this.withLoadDetail(`edge_ucb_bps=${edgeUcbBps.toFixed(4)}`),
        scoreBps,
        edgeLcbBps,
        edgeUcbBps,
        pFillLcb,
        row
      });
    }

    const minScore = getOrDefault(p.minScoreByKind, kind, 0);
    const enoughStateEvidence = nMarkouts >= Math.max(1, this.config.minCount) && muState != null;
    const canUseLivenessRelax = this.shouldApplyLivenessRelax(context);

    if (enoughStateEvidence && scoreBps >= minScore) {
      this.maybeLogDecision(state, kind, walletId, row, "ok");
      return this.decisionFrom({
        allowed: true,
        mode: "full",
        sizeMultiplier: 1,
        state,
        reasonCode: "ok",
        reasonDetail: this.withLoadDetail(null),
        scoreBps,
        edgeLcbBps,
        edgeUcbBps,
        pFillLcb,
        row
      });
    }

    let reasonCode = "score_below_min";
    if (!enoughStateEvidence) reasonCode = "sparse_explore";
    if (canUseLivenessRelax) reasonCode = "liveness_relax";

    if (context?.executionMode === "FULL" && reasonCode === "liveness_relax") {
      this.logger.error(
        { kind, walletId, state, reasonCode, allowInLive: this.config.liveness?.allowInLive ?? false },
        "RegimeGate invariant violation: liveness relax attempted in live execution"
      );
      return this.decisionFrom({
        allowed: false,
        mode: "blocked",
        sizeMultiplier: 0,
        state,
        reasonCode: "live_liveness_relax_forbidden",
        reasonDetail: this.withLoadDetail("liveness_relax_disabled_in_live"),
        scoreBps,
        edgeLcbBps,
        edgeUcbBps,
        pFillLcb,
        row
      });
    }

    const sizeMultiplier = this.computeExploreSize({
      kind,
      scoreBps,
      minScoreBps: minScore,
      nMarkouts,
      livenessRelax: canUseLivenessRelax
    });

    this.maybeLogDecision(state, kind, walletId, row, reasonCode);
    return this.decisionFrom({
      allowed: true,
      mode: "explore",
      sizeMultiplier,
      state,
      reasonCode,
      reasonDetail: this.withLoadDetail(null),
      scoreBps,
      edgeLcbBps,
      edgeUcbBps,
      pFillLcb,
      row: row
        ? {
            ...row,
            fillRate: fillRateState
          }
        : null
    });
  }

  private decisionFrom(input: {
    allowed: boolean;
    mode: RegimeDecisionMode;
    sizeMultiplier: number;
    state: number | null;
    reasonCode: string;
    reasonDetail: string | null;
    scoreBps: number | null;
    edgeLcbBps: number | null;
    edgeUcbBps: number | null;
    pFillLcb: number | null;
    row: StrategyRow | null;
  }): RegimeDecision {
    const row = input.row;
    const issues: string[] = [];
    const checkFinite = (name: string, value: number | null | undefined): void => {
      if (value == null) return;
      if (!Number.isFinite(value)) issues.push(name);
    };

    checkFinite("sizeMultiplier", input.sizeMultiplier);
    checkFinite("scoreBps", input.scoreBps);
    checkFinite("edgeLcbBps", input.edgeLcbBps);
    checkFinite("edgeUcbBps", input.edgeUcbBps);
    checkFinite("pFillLcb", input.pFillLcb);
    checkFinite("row.wavgBps", row?.wavgBps ?? null);
    checkFinite("row.fillRate", row?.fillRate ?? null);
    checkFinite("row.orderCount", row?.orderCount ?? null);
    checkFinite("row.filledOrderCount", row?.filledOrderCount ?? null);
    checkFinite("row.markoutCount", row?.markoutCount ?? null);

    if (issues.length > 0) {
      this.logger.error(
        { issues, state: input.state, reasonCode: input.reasonCode },
        "RegimeGate detected non-finite decision values; forcing blocked decision"
      );
      return {
        allowed: false,
        mode: "blocked",
        sizeMultiplier: 0,
        state: input.state,
        reason: "invalid_numeric",
        reasonCode: "invalid_numeric",
        reasonDetail: this.withLoadDetail(`invalid_numeric_fields=${issues.join(",")}`),
        scoreBps: null,
        edgeLcbBps: null,
        edgeUcbBps: null,
        pFillLcb: null,
        wavgBps: null,
        count: null,
        fillRate: null,
        nOrders: null,
        nFills: null,
        nMarkouts: null
      };
    }

    return {
      allowed: input.allowed,
      mode: input.mode,
      sizeMultiplier: clamp(input.sizeMultiplier, 0, 1),
      state: input.state,
      reason: input.reasonCode,
      reasonCode: input.reasonCode,
      reasonDetail: input.reasonDetail,
      scoreBps: input.scoreBps,
      edgeLcbBps: input.edgeLcbBps,
      edgeUcbBps: input.edgeUcbBps,
      pFillLcb: input.pFillLcb,
      wavgBps: row?.wavgBps ?? null,
      count: row?.markoutCount ?? null,
      fillRate: row?.fillRate ?? null,
      nOrders: row?.orderCount ?? null,
      nFills: row?.filledOrderCount ?? null,
      nMarkouts: row?.markoutCount ?? null
    };
  }

  private shouldApplyLivenessRelax(context?: RegimeDecisionContext): boolean {
    const l = this.config.liveness;
    if (!l?.enabled) return false;
    if (!context?.livenessRelax) return false;
    if (context.executionMode === "FULL" && !l.allowInLive) return false;
    return true;
  }

  private withLoadDetail(detail: string | null): string | null {
    const parts: string[] = [];
    if (detail && detail.length > 0) parts.push(detail);
    parts.push(`manifest_stamp_wanted=${this.manifestStampWanted ?? "none"}`);
    parts.push(`manifest_stamp_loaded=${this.manifestStampLoaded ?? this.snapshot?.stamp ?? "none"}`);
    parts.push(`using_last_good=${this.usingLastGood ? "1" : "0"}`);
    if (this.usingLastGood) {
      parts.push("not_loaded_using_last_good");
    }
    if (this.lastLoadError) {
      parts.push(`load_error=${this.lastLoadError}`);
    }
    return parts.join("; ");
  }

  private computeExploreSize(input: {
    kind: string;
    scoreBps: number;
    minScoreBps: number;
    nMarkouts: number;
    livenessRelax: boolean;
  }): number {
    const p = this.probConfig();
    const minSize = getOrDefault(p.exploreMinByKind, input.kind, 0.1);
    const maxSize = Math.max(minSize, getOrDefault(p.exploreMaxByKind, input.kind, 0.35));
    const evidenceNorm = clamp(input.nMarkouts / Math.max(1, this.config.minCount), 0, 1);
    const scoreNorm = input.minScoreBps > 0
      ? clamp(input.scoreBps / input.minScoreBps, 0, 1)
      : clamp((input.scoreBps + 5) / 10, 0, 1);
    const blend = (0.5 * evidenceNorm) + (0.5 * scoreNorm);
    let out = minSize + ((maxSize - minSize) * blend);
    if (input.livenessRelax) {
      out = Math.min(maxSize, out * 1.25);
    }
    return clamp(out, minSize, maxSize);
  }

  private maybeLogDecision(
    stateId: number,
    kind: string,
    walletId: number,
    row: StrategyRow | null,
    decision: string
  ): void {
    const sampleN = Number(process.env.REGIME_GATE_DEBUG_SAMPLE ?? 0);
    if (sampleN <= 0) return;
    this.decisionCounter += 1;
    if (this.decisionCounter % sampleN !== 0) return;
    const key = `${stateId}|${kind}|${walletId}`;
    const found = row != null;
    const count = row?.markoutCount ?? 0;
    const wavgBps = row?.wavgBps ?? 0;
    this.logger.info(
      { stateId, key, found, count, wavgBps, decision, usingLastGood: this.usingLastGood },
      "RegimeGate diagnostic"
    );
  }

  public getWavgBps(stateId: number, kind: string, walletId: number): number | null {
    const map = this.snapshot?.strategyMap;
    if (!map) return null;
    const row = map.get(`${stateId}|${kind}|${walletId}`);
    return row?.wavgBps ?? null;
  }

  public computeState(feature: RegimeFeatureInput): number | null {
    const snapshot = this.snapshot;
    if (!snapshot || !snapshot.features.length || snapshot.bins <= 0) return null;
    const bins: number[] = [];
    for (const name of snapshot.features) {
      const value = this.getMetricValue(name, feature);
      if (!Number.isFinite(value ?? NaN)) return null;
      const edges = snapshot.edges[name] ?? [];
      bins.push(binValue(value as number, edges));
    }
    return encodeState(bins, snapshot.bins);
  }

  private getMetricValue(name: string, feature: RegimeFeatureInput): number | null {
    switch (name) {
      case "spread":
        return feature.spread ?? null;
      case "depth":
        if (feature.bidDepthTop == null || feature.askDepthTop == null) return null;
        return feature.bidDepthTop + feature.askDepthTop;
      case "obi":
        return feature.obi ?? null;
      case "vol":
        return feature.vol30m ?? null;
      case "micro":
        return feature.micropriceMinusMid ?? null;
      default:
        return null;
    }
  }

  private load(): void {
    try {
      const snapshot = this.loadSnapshot();
      this.snapshot = snapshot;
      this.loaded = true;
      this.usingLastGood = false;
      this.lastLoadError = null;
       this.manifestStampLoaded = snapshot.stamp;
      this.logOnce(`RegimeGate loaded regime snapshot stamp=${snapshot.stamp}`);
    } catch (err) {
      const code = this.normalizeLoadError(err);
      this.lastLoadError = code;
      if (this.snapshot) {
        this.loaded = true;
        this.usingLastGood = true;
        this.logOnce(`RegimeGate reload failed (${code}); keeping last-good snapshot.`);
        return;
      }
      this.loaded = false;
      this.usingLastGood = false;
      this.logOnce(`RegimeGate not loaded (${code}) and no last-good snapshot.`);
    }
  }

  private loadSnapshot(): LoadedSnapshot {
    const markovPath = this.resolvePath(this.config.markovPath);
    const strategyPath = this.resolvePath(this.config.strategyPath);
    const manifestPath = this.resolvePath(
      this.config.manifestPath ?? path.join(path.dirname(markovPath), "regime_manifest.json")
    );
    this.manifestPathLoaded = manifestPath;
    let manifestMtimeMs: number | null = null;
    try {
      manifestMtimeMs = statSync(manifestPath).mtimeMs;
    } catch {
      manifestMtimeMs = null;
    }

    try {
      const manifest = readJson<ManifestJson>(manifestPath);
      return this.loadFromManifest(manifestPath, manifest, manifestMtimeMs);
    } catch (err) {
      const code = this.normalizeLoadError(err);
      if (code !== "missing_manifest") throw err;
      return this.loadLegacyPair(markovPath, strategyPath);
    }
  }

  private loadFromManifest(manifestPath: string, manifest: ManifestJson, manifestMtimeMs: number | null): LoadedSnapshot {
    const stamp = String(manifest.stamp ?? "");
    this.manifestStampWanted = stamp || null;
    this.manifestPathLoaded = manifestPath;
    if (!stamp) {
      throw new Error("invalid_manifest");
    }
    const markovName = String(manifest.markovFile ?? "");
    const strategyName = String(manifest.strategyFile ?? "");
    if (!markovName || !strategyName) {
      throw new Error("invalid_manifest");
    }

    const dir = path.dirname(manifestPath);
    const markovPath = path.isAbsolute(markovName) ? markovName : path.join(dir, markovName);
    const strategyPath = path.isAbsolute(strategyName) ? strategyName : path.join(dir, strategyName);
    const markov = readJson<any>(markovPath);
    const strategy = readJson<any>(strategyPath);

    const markovStamp = String(markov?._meta?.stamp ?? "");
    const strategyStamp = String(strategy?._meta?.stamp ?? "");
    if (!markovStamp || !strategyStamp || markovStamp !== stamp || strategyStamp !== stamp) {
      throw new Error("manifest_mismatch");
    }

    const previousLoadedStamp = this.manifestStampLoaded ?? this.snapshot?.stamp ?? null;
    const previousManifestMtimeMs = this.manifestMtimeMsLoaded;
    if (
      previousLoadedStamp != null &&
      previousLoadedStamp !== stamp &&
      previousManifestMtimeMs != null &&
      manifestMtimeMs != null &&
      manifestMtimeMs <= previousManifestMtimeMs
    ) {
      throw new Error("manifest_stamp_changed_without_manifest_update");
    }

    this.manifestStampLoaded = stamp;
    this.manifestMtimeMsLoaded = manifestMtimeMs;

    return this.buildSnapshot(markov, strategy, stamp, String(manifest.generatedAt ?? ""));
  }

  private loadLegacyPair(markovPath: string, strategyPath: string): LoadedSnapshot {
    const markov = readJson<any>(markovPath);
    const strategy = readJson<any>(strategyPath);
    const markovStamp = String(markov?._meta?.stamp ?? "");
    const strategyStamp = String(strategy?._meta?.stamp ?? "");
    if (markovStamp && strategyStamp && markovStamp !== strategyStamp) {
      throw new Error("manifest_mismatch");
    }
    const stamp = markovStamp || strategyStamp || `legacy:${Date.now()}`;
    const generatedAt = String(markov?._meta?.generatedAt ?? strategy?._meta?.generatedAt ?? "");
    this.manifestStampWanted = null;
    this.manifestStampLoaded = stamp;
    this.manifestMtimeMsLoaded = null;
    return this.buildSnapshot(markov, strategy, stamp, generatedAt);
  }

  private buildSnapshot(markov: any, strategy: any, stamp: string, generatedAt: string): LoadedSnapshot {
    const features = Array.isArray(markov?.config?.features) ? markov.config.features.map((x: unknown) => String(x)) : [];
    const bins = Number(markov?.config?.bins ?? 0);
    const edges = typeof markov?.edges === "object" && markov.edges != null
      ? (markov.edges as Record<string, number[]>)
      : null;
    if (!features.length || bins <= 0 || edges == null) {
      throw new Error("invalid_markov");
    }

    const rows = Array.isArray(strategy?.rows) ? strategy.rows : null;
    if (rows == null) {
      throw new Error("invalid_strategy");
    }

    const strategyMap = new Map<string, StrategyRow>();
    for (const raw of rows) {
      if (!raw) continue;
      const state = Number(raw.state);
      const walletId = Number(raw.walletId);
      const kind = String(raw.kind ?? "");
      if (!Number.isFinite(state) || !Number.isFinite(walletId) || !kind) continue;
      const countRaw = Math.max(0, Number(raw.count ?? 0));
      const markoutCount = Math.max(0, Number(raw.markoutCount ?? countRaw));
      const filledOrderCountRaw = toFinite(raw.filledOrderCount);
      const filledOrderCount = Math.max(0, filledOrderCountRaw != null ? filledOrderCountRaw : markoutCount);
      const orderCountRaw = toFinite(raw.orderCount);
      let orderCount = orderCountRaw != null ? Math.max(0, orderCountRaw) : 0;

      const fillRateRaw = toFinite(raw.fillRate);
      if (orderCount <= 0) {
        if (fillRateRaw != null && fillRateRaw > 0 && filledOrderCount > 0) {
          orderCount = Math.max(filledOrderCount, Math.round(filledOrderCount / fillRateRaw));
        } else {
          orderCount = filledOrderCount;
        }
      }

      const fillRate = fillRateRaw != null
        ? clamp(fillRateRaw, 0, 1)
        : orderCount > 0
          ? clamp(filledOrderCount / orderCount, 0, 1)
          : null;
      const wavgBps = toFinite(raw.wavgBps);
      const markoutStdBps = toFinite(raw.markoutStdBps);
      const markoutSeBps = toFinite(raw.markoutSeBps);

      strategyMap.set(`${state}|${kind}|${walletId}`, {
        state,
        kind,
        walletId,
        count: countRaw,
        markoutCount,
        orderCount,
        filledOrderCount,
        wavgBps,
        fillRate,
        markoutStdBps,
        markoutSeBps
      });
    }

    const { kindPrior, walletKindPrior } = this.computePriors(strategyMap);
    return {
      stamp,
      generatedAt: generatedAt || null,
      features,
      bins,
      edges,
      strategyMap,
      kindPrior,
      walletKindPrior
    };
  }

  private computePriors(strategyMap: Map<string, StrategyRow>): {
    kindPrior: Map<string, PriorStats>;
    walletKindPrior: Map<string, PriorStats>;
  } {
    const kind = new Map<string, { nMarkouts: number; sumMuWeighted: number; nOrders: number; nFills: number }>();
    const walletKind = new Map<string, { nMarkouts: number; sumMuWeighted: number; nOrders: number; nFills: number }>();

    for (const row of strategyMap.values()) {
      const rowMarkouts = Math.max(0, row.markoutCount);
      const rowOrders = Math.max(0, row.orderCount);
      const rowFills = Math.max(0, row.filledOrderCount);
      const kindKey = row.kind;
      const wkKey = `${row.walletId}|${row.kind}`;

      const kindAgg = kind.get(kindKey) ?? { nMarkouts: 0, sumMuWeighted: 0, nOrders: 0, nFills: 0 };
      if (row.wavgBps != null && rowMarkouts > 0) {
        kindAgg.nMarkouts += rowMarkouts;
        kindAgg.sumMuWeighted += row.wavgBps * rowMarkouts;
      }
      kindAgg.nOrders += rowOrders;
      kindAgg.nFills += rowFills;
      kind.set(kindKey, kindAgg);

      const wkAgg = walletKind.get(wkKey) ?? { nMarkouts: 0, sumMuWeighted: 0, nOrders: 0, nFills: 0 };
      if (row.wavgBps != null && rowMarkouts > 0) {
        wkAgg.nMarkouts += rowMarkouts;
        wkAgg.sumMuWeighted += row.wavgBps * rowMarkouts;
      }
      wkAgg.nOrders += rowOrders;
      wkAgg.nFills += rowFills;
      walletKind.set(wkKey, wkAgg);
    }

    const kindPrior = new Map<string, PriorStats>();
    for (const [key, agg] of kind.entries()) {
      const muBps = agg.nMarkouts > 0 ? agg.sumMuWeighted / agg.nMarkouts : 0;
      const fillRate = agg.nOrders > 0 ? clamp(agg.nFills / agg.nOrders, 0, 1) : 0.5;
      kindPrior.set(key, {
        nMarkouts: agg.nMarkouts,
        muBps,
        nOrders: agg.nOrders,
        nFills: agg.nFills,
        fillRate
      });
    }

    const walletKindPrior = new Map<string, PriorStats>();
    for (const [key, agg] of walletKind.entries()) {
      const muBps = agg.nMarkouts > 0 ? agg.sumMuWeighted / agg.nMarkouts : 0;
      const fillRate = agg.nOrders > 0 ? clamp(agg.nFills / agg.nOrders, 0, 1) : 0.5;
      walletKindPrior.set(key, {
        nMarkouts: agg.nMarkouts,
        muBps,
        nOrders: agg.nOrders,
        nFills: agg.nFills,
        fillRate
      });
    }

    return { kindPrior, walletKindPrior };
  }

  private computePrior(snapshot: LoadedSnapshot, kind: string, walletId: number): {
    muBps: number;
    fillRate: number;
  } {
    const kindPrior = snapshot.kindPrior.get(kind) ?? {
      nMarkouts: 0,
      muBps: 0,
      nOrders: 0,
      nFills: 0,
      fillRate: 0.5
    };
    const wk = snapshot.walletKindPrior.get(`${walletId}|${kind}`);
    if (!wk) {
      return {
        muBps: kindPrior.muBps,
        fillRate: kindPrior.fillRate
      };
    }
    const blendK = Math.max(1, this.probConfig().walletBlendK);
    const w = wk.nMarkouts / (wk.nMarkouts + blendK);
    const muBps = (w * wk.muBps) + ((1 - w) * kindPrior.muBps);
    const fillRate = (w * wk.fillRate) + ((1 - w) * kindPrior.fillRate);
    return {
      muBps,
      fillRate: clamp(fillRate, 0, 1)
    };
  }

  private lookupRow(
    strategyMap: Map<string, StrategyRow>,
    state: number,
    kind: string,
    walletId: number
  ): StrategyRow | null {
    return strategyMap.get(`${state}|${kind}|${walletId}`) ?? null;
  }

  private getExploreMin(kind: string): number {
    return getOrDefault(this.probConfig().exploreMinByKind, kind, 0.1);
  }

  private probConfig(): Required<NonNullable<RegimeGateConfig["probabilistic"]>> & {
    explicitHardBlockSet: Set<string>;
  } {
    const cfg = this.config.probabilistic ?? {
      kEdge: 50,
      zEdge: 1.64,
      zFill: 1.64,
      sigmaPriorBps: 25,
      winsorClipBps: 250,
      riskPenaltyBps: 0.5,
      costBufferBps: 1.0,
      hardBlockUpperBps: 0,
      hardBlockMinCount: 30,
      walletBlendK: 50,
      minScoreByKind: {
        TAKER_BUY: 1.5,
        TAKER_SELL: 0.5,
        MAKER_BID: 0,
        MAKER_ASK: 0
      },
      exploreMinByKind: {
        TAKER_BUY: 0.1,
        TAKER_SELL: 0.2,
        MAKER_BID: 0.25,
        MAKER_ASK: 0.25
      },
      exploreMaxByKind: {
        TAKER_BUY: 0.25,
        TAKER_SELL: 0.35,
        MAKER_BID: 0.4,
        MAKER_ASK: 0.4
      },
      explicitHardBlocks: this.config.explicitHardBlocks ?? []
    };
    return {
      ...cfg,
      explicitHardBlockSet: new Set((cfg.explicitHardBlocks ?? []).map((s) => String(s)))
    };
  }

  private normalizeLoadError(err: unknown): NormalizedErrorCode {
    if (err instanceof Error) {
      const msg = err.message;
      if (msg.includes("ENOENT")) {
        if (msg.includes("regime_manifest.json")) return "missing_manifest";
        return "missing_json";
      }
      if (msg === "missing_manifest") return "missing_manifest";
      if (msg === "manifest_mismatch") return "manifest_mismatch";
      if (msg === "manifest_stamp_changed_without_manifest_update") {
        return "manifest_stamp_changed_without_manifest_update";
      }
      if (msg === "invalid_manifest") return "invalid_manifest";
      if (msg === "invalid_markov") return "invalid_markov";
      if (msg === "invalid_strategy") return "invalid_strategy";
      if (msg.includes("Unexpected token")) return "invalid_manifest";
    }
    return "unknown";
  }

  private resolvePath(raw: string): string {
    if (path.isAbsolute(raw)) return raw;
    return path.resolve(getRepoRoot(), raw);
  }

  private logOnce(message: string): void {
    const now = Date.now();
    if (now - this.lastLogTs < 60_000) return;
    this.lastLogTs = now;
    this.logger.info(message);
  }
}
