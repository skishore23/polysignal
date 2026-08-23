import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { computeEV1Step } from "@polysignal/data";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";

export const dynamic = "force-dynamic";

function getRepoRoot(): string {
  if (process.env.REPO_ROOT) return path.resolve(process.env.REPO_ROOT);
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dir, "..", "..", "..", "..");
}

const loadJson = async (filePath: string): Promise<any | null> => {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const loadMtime = async (filePath: string): Promise<number | null> => {
  try {
    const info = await stat(filePath);
    return info.mtimeMs;
  } catch {
    return null;
  }
};

const formatBps = (value: number | null): string => {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(2)} bps`;
};

const formatPct = (value: number | null): string => {
  if (value == null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
};

const formatSignedBps = (value: number | null): string => {
  if (value == null || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)} bps`;
};

type MarkoutEntry = { count?: number; wavgBps?: number; notional?: number };
type StateRow = {
  state: number;
  label: string;
  count: number;
  markout?: MarkoutEntry | null;
  markoutCount: number;
};

const markoutCount = (markout: MarkoutEntry | null | undefined): number =>
  markout?.count ?? 0;

function totalMarkouts(states: StateRow[]): number {
  return states.reduce((sum, r) => sum + r.markoutCount, 0);
}

function statesWithMarkouts(states: StateRow[]): number {
  return states.filter((r) => r.markoutCount > 0).length;
}

function topNOccupancyCovered(
  states: StateRow[],
  n: number
): { covered: number; total: number } {
  const top = states.slice(0, n);
  const covered = top.filter((r) => r.markoutCount > 0).length;
  return { covered, total: top.length };
}

type GatingConfig = {
  minCount?: number;
  minWavgBps?: number;
  minFillRate?: number;
  failOpen?: boolean;
};

type StrategyRowLike = { count?: number; wavgBps?: number | null; fillRate?: number | null };

type StrategyRow = {
  state: number;
  kind: string;
  walletId: number;
  count: number;
  wavgBps: number | null;
  fillRate: number | null;
  winRate: number;
  notional: number;
};

type GateEval = {
  allowed: boolean;
  reason: string;
};

const toFiniteNumber = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const normalizeStrategyRow = (row: any): StrategyRow | null => {
  if (!row || typeof row !== "object") return null;
  const state = toFiniteNumber(row.state);
  const walletId = toFiniteNumber(row.walletId);
  const kind = typeof row.kind === "string" ? row.kind : "";
  if (state == null || walletId == null || kind.length === 0) return null;
  const count = Math.max(0, toFiniteNumber(row.count) ?? 0);
  const wavgRaw = row.wavgBps;
  const wavgBps = wavgRaw == null ? null : toFiniteNumber(wavgRaw);
  const fillRateRaw = row.fillRate;
  const fillRate = fillRateRaw == null ? null : toFiniteNumber(fillRateRaw);
  const winRate = toFiniteNumber(row.winRate) ?? 0;
  const notional = Math.max(0, toFiniteNumber(row.notional) ?? 0);
  return {
    state,
    kind,
    walletId,
    count,
    wavgBps,
    fillRate,
    winRate,
    notional
  };
};

function evaluateGateDecision(
  strategyRow: StrategyRowLike,
  gating: GatingConfig | null
): GateEval {
  const minCount = gating?.minCount ?? 0;
  const minWavgBps = gating?.minWavgBps ?? 0;
  const minFillRate = gating?.minFillRate ?? 0;
  const failOpen = gating?.failOpen ?? false;
  const c = strategyRow.count ?? 0;
  const w = strategyRow.wavgBps;
  const fillRate = strategyRow.fillRate;

  if (c < minCount) {
    return { allowed: failOpen, reason: `count_lt_${minCount}` };
  }
  if (w == null || !Number.isFinite(Number(w))) {
    return { allowed: failOpen, reason: "no_markouts" };
  }
  if (Number(w) < minWavgBps) {
    return { allowed: false, reason: `wavg_bps_lt_${minWavgBps}` };
  }
  if (
    minFillRate > 0 &&
    fillRate != null &&
    Number.isFinite(Number(fillRate)) &&
    Number(fillRate) < minFillRate
  ) {
    return { allowed: false, reason: `fill_rate_lt_${minFillRate}` };
  }
  return { allowed: true, reason: "ok" };
}

function gatePassRates(
  strategyRows: StrategyRowLike[],
  gating: GatingConfig | null
): {
  passRows: number;
  totalRows: number;
  passRateRows: number;
  passCountWeighted: number;
  totalCountWeighted: number;
  passRateWeighted: number;
} {
  const totalRows = strategyRows.length;
  let passRows = 0;
  let passCountWeighted = 0;
  let totalCountWeighted = 0;
  for (const row of strategyRows) {
    const c = row.count ?? 0;
    totalCountWeighted += c;
    const evalDecision = evaluateGateDecision(row, gating);
    if (evalDecision.allowed) {
      passRows += 1;
      passCountWeighted += c;
    }
  }
  const passRateRows = totalRows > 0 ? passRows / totalRows : 0;
  const passRateWeighted =
    totalCountWeighted > 0 ? passCountWeighted / totalCountWeighted : 0;
  return {
    passRows,
    totalRows,
    passRateRows,
    passCountWeighted,
    totalCountWeighted,
    passRateWeighted
  };
}

function countPassRowsAtMinCount(
  strategyRows: StrategyRowLike[],
  gating: GatingConfig | null,
  minCountOverride: number
): number {
  const overrideGate: GatingConfig = {
    ...(gating ?? {}),
    minCount: minCountOverride,
    failOpen: false
  };
  let n = 0;
  for (const row of strategyRows) {
    if (evaluateGateDecision(row, overrideGate).allowed) {
      n += 1;
    }
  }
  return n;
}

type GateFailureBreakdown = {
  total: number;
  pass: number;
  lowCount: number;
  noMarkouts: number;
  lowWavg: number;
  lowFillRate: number;
  failOpenAllowed: number;
};

function gateFailureBreakdown(
  strategyRows: StrategyRowLike[],
  gating: GatingConfig | null
): GateFailureBreakdown {
  const minCount = gating?.minCount ?? 0;
  const minWavgBps = gating?.minWavgBps ?? 0;
  const minFillRate = gating?.minFillRate ?? 0;
  const failOpen = gating?.failOpen ?? false;
  const out: GateFailureBreakdown = {
    total: strategyRows.length,
    pass: 0,
    lowCount: 0,
    noMarkouts: 0,
    lowWavg: 0,
    lowFillRate: 0,
    failOpenAllowed: 0
  };
  for (const row of strategyRows) {
    const c = row.count ?? 0;
    const w = row.wavgBps;
    const fillRate = row.fillRate;
    if (c < minCount) {
      out.lowCount += 1;
      if (failOpen) {
        out.failOpenAllowed += 1;
        out.pass += 1;
      }
      continue;
    }
    if (w == null || !Number.isFinite(Number(w))) {
      out.noMarkouts += 1;
      if (failOpen) {
        out.failOpenAllowed += 1;
        out.pass += 1;
      }
      continue;
    }
    if (Number(w) < minWavgBps) {
      out.lowWavg += 1;
      continue;
    }
    if (
      minFillRate > 0 &&
      fillRate != null &&
      Number.isFinite(Number(fillRate)) &&
      Number(fillRate) < minFillRate
    ) {
      out.lowFillRate += 1;
      continue;
    }
    out.pass += 1;
  }
  return out;
}

function hasMarkoutEvidence(row: StrategyRow): boolean {
  return row.count > 0 && row.wavgBps != null;
}

function sumEvidenceCount(rows: StrategyRow[]): number {
  return rows.reduce((sum, r) => sum + r.count, 0);
}

function weightedAverageWavgBps(
  rows: StrategyRow[],
  weightBy: "count" | "notional"
): number | null {
  let weighted = 0;
  let totalWeight = 0;
  for (const row of rows) {
    const wavg = row.wavgBps;
    if (wavg == null || !Number.isFinite(wavg)) continue;
    const weight = weightBy === "count" ? row.count : row.notional;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    weighted += wavg * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return null;
  return weighted / totalWeight;
}

function formatGateReason(reason: string): string {
  if (reason === "ok") return "ok";
  if (reason === "no_markouts") return "no-markouts";
  if (reason.startsWith("count_lt_")) {
    return `count<${reason.slice("count_lt_".length)}`;
  }
  if (reason.startsWith("wavg_bps_lt_")) {
    return `wavg<${reason.slice("wavg_bps_lt_".length)}bps`;
  }
  if (reason.startsWith("fill_rate_lt_")) {
    return `fillRate<${reason.slice("fill_rate_lt_".length)}`;
  }
  return reason;
}

function formatCoverage(markoutCount: number, occupancyCount: number): string {
  if (occupancyCount === 0) return "—";
  const ratio = markoutCount / occupancyCount;
  if (ratio < 0.001) return "<0.1%";
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatTimeShort(ts: number | null): string {
  if (ts == null) return "—";
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
}

export default async function RegimesPage() {
  const repoRoot = getRepoRoot();
  const workerConfigPath = path.join(repoRoot, "configs", "worker.json");
  const workerConfig = await loadJson(workerConfigPath);
  const gating = workerConfig?.regimeGating ?? null;
  const report = workerConfig?.regimeReport ?? null;

  const resolvePath = (raw: string | null | undefined, fallback: string): string => {
    const value = raw && raw.length > 0 ? raw : fallback;
    if (path.isAbsolute(value)) return value;
    return path.resolve(repoRoot, value);
  };

  const outputDir = resolvePath(report?.outputDir, "data");
  const markovPath = resolvePath(gating?.markovPath, path.join(outputDir, "markov_regime.json"));
  const strategyPath = resolvePath(gating?.strategyPath, path.join(outputDir, "strategy_regime_report.json"));

  const [markov, strategy, markovMtime, strategyMtime] = await Promise.all([
    loadJson(markovPath),
    loadJson(strategyPath),
    loadMtime(markovPath),
    loadMtime(strategyPath)
  ]);

  if (!markov || !strategy) {
    return (
      <div className="p-6 lg:p-10 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Regime Research</h1>
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest mt-1">
            Question: which market states are evidence-ready to gate decisions?
          </p>
        </div>
        <Card className="bg-card/40 border-border/50">
          <CardHeader>
            <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
              Data Missing
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>Run the regime scripts to generate the JSON artifacts:</p>
            <pre className="bg-black/40 border border-border/40 rounded-md p-3 text-xs overflow-x-auto">
              node --import tsx scripts/markov-regime-analysis.ts --hours=24 --horizon-ms=300000 --bins=3
              {"\n"}
              node --import tsx scripts/strategy-regime-report.ts --hours=24 --horizon-ms=300000 --bins=3
            </pre>
          </CardContent>
        </Card>
      </div>
    );
  }

  const markovForEv = {
    states: markov.states ?? {},
    transitions: markov.transitions ?? {}
  };

  const markovStates: StateRow[] = (
    Object.entries(markov.states ?? {}) as [string, { label: string; count: number; markout?: MarkoutEntry | null }][]
  ).map(([state, data]) => ({
    state: Number(state),
    label: data.label,
    count: data.count,
    markout: data.markout ?? null,
    markoutCount: markoutCount(data.markout ?? null)
  }));
  markovStates.sort((a, b) => b.count - a.count);

  const mostEvidencedStates: StateRow[] = markovStates
    .filter((r) => r.markoutCount > 0)
    .sort((a, b) => {
      if (b.markoutCount !== a.markoutCount) return b.markoutCount - a.markoutCount;
      const notA = a.markout?.notional ?? 0;
      const notB = b.markout?.notional ?? 0;
      if (notB !== notA) return notB - notA;
      const absA = Math.abs(a.markout?.wavgBps ?? 0);
      const absB = Math.abs(b.markout?.wavgBps ?? 0);
      return absB - absA;
    })
    .slice(0, 15);

  const strategyRows = ((strategy.rows ?? []) as Array<any>)
    .map(normalizeStrategyRow)
    .filter((row): row is StrategyRow => row != null);
  const totalMarkoutsN = totalMarkouts(markovStates);
  const statesWithMarkoutsN = statesWithMarkouts(markovStates);
  const top10Covered = topNOccupancyCovered(markovStates, 10);
  const passRates = gatePassRates(strategyRows, gating);
  const failureBreakdown = gateFailureBreakdown(strategyRows, gating);
  const bothPassRatesNearZero =
    passRates.passRateRows < 0.01 && passRates.passRateWeighted < 0.01;

  const transitions: Array<{ from: number; to: number; count: number; prob: number }> = [];
  for (const [from, row] of Object.entries(markov.transitions ?? {})) {
    const total = (row as any).total ?? 0;
    const to = (row as any).to ?? {};
    for (const [toState, count] of Object.entries(to)) {
      transitions.push({
        from: Number(from),
        to: Number(toState),
        count: count as number,
        prob: total > 0 ? (count as number) / total : 0
      });
    }
  }
  transitions.sort((a, b) => b.count - a.count);
  const nonSelfTransitions = transitions.filter((t) => t.from !== t.to);

  const baseMinCount = gating?.minCount ?? 20;
  const passAtBase = countPassRowsAtMinCount(strategyRows, gating, baseMinCount);
  const passAt5 = countPassRowsAtMinCount(strategyRows, gating, 5);
  const passAt1 = countPassRowsAtMinCount(strategyRows, gating, 1);
  const strategyKinds = [...new Set(strategyRows.map((r) => r.kind).filter(Boolean))].sort();

  const evidencedRows = strategyRows.filter(hasMarkoutEvidence);
  const nonEvidencedRows = strategyRows.filter((row) => !hasMarkoutEvidence(row));
  const positiveRows = evidencedRows.filter((row) => (row.wavgBps ?? 0) > 0);
  const flatRows = evidencedRows.filter((row) => (row.wavgBps ?? 0) === 0);
  const negativeRows = evidencedRows.filter((row) => (row.wavgBps ?? 0) < 0);

  const allowedEvidencedRows: StrategyRow[] = [];
  const blockedEvidencedRows: StrategyRow[] = [];
  const blockedReasonCounts = new Map<string, number>();
  for (const row of evidencedRows) {
    const evalDecision = evaluateGateDecision(row, gating);
    if (evalDecision.allowed) {
      allowedEvidencedRows.push(row);
    } else {
      blockedEvidencedRows.push(row);
      blockedReasonCounts.set(
        evalDecision.reason,
        (blockedReasonCounts.get(evalDecision.reason) ?? 0) + 1
      );
    }
  }

  const baselineWavgByCount = weightedAverageWavgBps(evidencedRows, "count");
  const baselineWavgByNotional = weightedAverageWavgBps(evidencedRows, "notional");
  const allowedWavgByCount = weightedAverageWavgBps(allowedEvidencedRows, "count");
  const blockedWavgByCount = weightedAverageWavgBps(blockedEvidencedRows, "count");
  const gateUpliftByCount =
    baselineWavgByCount != null && allowedWavgByCount != null
      ? allowedWavgByCount - baselineWavgByCount
      : null;

  const totalEvidenceCount = sumEvidenceCount(evidencedRows);
  const allowedEvidenceCount = sumEvidenceCount(allowedEvidencedRows);
  const blockedEvidenceCount = sumEvidenceCount(blockedEvidencedRows);

  const blockedReasonsSummary = Array.from(blockedReasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${formatGateReason(reason)}=${count}`)
    .join(" · ");

  const sortedEvidencedRows = [...evidencedRows].sort(
    (a, b) => (b.wavgBps ?? -Infinity) - (a.wavgBps ?? -Infinity)
  );
  const topRows = sortedEvidencedRows.slice(0, 15);
  const bottomRows = [...sortedEvidencedRows].slice(-15).reverse();
  const noEvidencePreviewRows = [...nonEvidencedRows]
    .sort((a, b) => (b.fillRate ?? -1) - (a.fillRate ?? -1))
    .slice(0, 15);

  const config = markov.config ?? {};
  const formatTime = (ts: number | null): string =>
    ts == null ? "—" : new Date(ts).toLocaleString();

  return (
    <div className="p-6 lg:p-10 space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Regime Research</h1>
        <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest mt-1">
          System understanding via Markov regimes + strategy diagnostics
        </p>
        <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
          Question: which feature states should allow or block strategy actions?
        </p>
      </div>

      <Card className="bg-card/40 border-border/50">
        <CardHeader>
          <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
            Model readiness
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs font-mono">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Markouts</span>
              <div className="text-sm">{totalMarkoutsN}</div>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">States w/ markouts</span>
              <div className="text-sm">{statesWithMarkoutsN}</div>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Top-10 occupancy covered</span>
              <div className="text-sm">{top10Covered.covered}/{top10Covered.total}</div>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Pass rate (rows)</span>
              <div className="text-sm">{formatPct(passRates.passRateRows)} ({passRates.passRows}/{passRates.totalRows} pass gate)</div>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Pass rate (weighted)</span>
              <div className="text-sm">{formatPct(passRates.passRateWeighted)}</div>
            </div>
          </div>
          <div className="text-[10px] text-muted-foreground">
            Strategy rows: {passRates.totalRows} · Kinds: {strategyKinds.length ? strategyKinds.join(", ") : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Markov: {formatTimeShort(markovMtime)} · Strategy: {formatTimeShort(strategyMtime)} · Reload: {gating?.reloadMs != null ? `${Math.round((gating.reloadMs as number) / 1000)}s` : "—"}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Pass at minCount={baseMinCount}: {passAtBase}/{passRates.totalRows} · minCount=5: {passAt5}/{passRates.totalRows} · minCount=1: {passAt1}/{passRates.totalRows}
          </div>
          {bothPassRatesNearZero && (
            <div className="space-y-1">
              <p className="text-amber-600 dark:text-amber-400 font-medium">
                Model warming up — safe mode
              </p>
              <p className="text-[10px] text-muted-foreground">
                Gate blockers @ current thresholds: count&lt;{gating?.minCount ?? 0} = {failureBreakdown.lowCount}, no markouts = {failureBreakdown.noMarkouts}, wavg&lt;{gating?.minWavgBps ?? 0} = {failureBreakdown.lowWavg}, fillRate&lt;{gating?.minFillRate ?? 0} = {failureBreakdown.lowFillRate}.
                {gating?.failOpen
                  ? ` Fail-open is ON; ${failureBreakdown.failOpenAllowed} rows are allowed despite low-count/no-markout.`
                  : ""}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card/40 border-border/50">
        <CardHeader>
          <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
            Markov Decision Transparency
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Evidence-only view of what worked (positive markouts), what failed (negative markouts), and how current gate thresholds would filter that evidence.
          </p>
        </CardHeader>
        <CardContent className="space-y-2 text-xs font-mono">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Evidenced rows</span>
              <div className="text-sm">{evidencedRows.length}/{strategyRows.length}</div>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">No-evidence rows</span>
              <div className="text-sm">{nonEvidencedRows.length}</div>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Worked</span>
              <div className="text-sm">{positiveRows.length} rows · {sumEvidenceCount(positiveRows)} fills</div>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Failed</span>
              <div className="text-sm">{negativeRows.length} rows · {sumEvidenceCount(negativeRows)} fills</div>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Flat</span>
              <div className="text-sm">{flatRows.length} rows · {sumEvidenceCount(flatRows)} fills</div>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Baseline WAvg</span>
              <div className="text-sm">{formatSignedBps(baselineWavgByCount)}</div>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Baseline WAvg (Notional)</span>
              <div className="text-sm">{formatSignedBps(baselineWavgByNotional)}</div>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Gate-allowed WAvg</span>
              <div className="text-sm">{formatSignedBps(allowedWavgByCount)}</div>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Gate-blocked WAvg</span>
              <div className="text-sm">{formatSignedBps(blockedWavgByCount)}</div>
            </div>
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Estimated Uplift</span>
              <div className="text-sm">{formatSignedBps(gateUpliftByCount)}</div>
            </div>
          </div>
          <div className="text-[10px] text-muted-foreground">
            Allowed evidenced fills: {allowedEvidenceCount}/{totalEvidenceCount} · Blocked evidenced fills: {blockedEvidenceCount}/{totalEvidenceCount}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Blocked reason mix: {blockedReasonsSummary || "—"}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card/40 border-border/50">
        <CardHeader>
          <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
            Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs font-mono">
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Window</div>
            <div className="text-sm">{config.hours}h</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Horizon</div>
            <div className="text-sm">{config.horizonMs}ms</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Bins</div>
            <div className="text-sm">{config.bins}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Features</div>
            <div className="text-sm">{(config.features ?? []).join(", ")}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card/40 border-border/50">
        <CardHeader>
          <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
            Gating Policy
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs font-mono">
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Enabled</div>
            <div className="text-sm">{gating?.enabled ? "Yes" : "No"}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Min Count</div>
            <div className="text-sm">{gating?.minCount ?? "—"}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Min WAvg</div>
            <div className="text-sm">{gating?.minWavgBps ?? "—"} bps</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Fail Open</div>
            <div className="text-sm">{gating?.failOpen ? "Yes" : "No"}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Min Fill Rate</div>
            <div className="text-sm">{gating?.minFillRate ?? "—"}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Reload</div>
            <div className="text-sm">
              {gating?.reloadMs != null
                ? `${Math.round((gating.reloadMs as number) / 1000)}s (${gating.reloadMs} ms)`
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Markov JSON</div>
            <div className="text-sm">{formatTime(markovMtime)}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Strategy JSON</div>
            <div className="text-sm">{formatTime(strategyMtime)}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card/40 border-border/50">
        <CardHeader>
          <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
            How We Use This
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs font-mono text-muted-foreground space-y-2">
          <p>1. Generate regimes + strategy report daily (or hourly).</p>
          <p>2. Gate maker/taker by regime when wavg bps is positive and sample is sufficient.</p>
          <p>3. Disable strategies in regimes where markout is consistently negative.</p>
          <p>4. Review top/bottom combos here to decide which wallets/strategies to expand or cut.</p>
        </CardContent>
      </Card>

      <Card className="bg-card/40 border-border/50">
        <CardHeader>
          <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
            Most common states
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            High occupancy doesn&apos;t mean high evidence. Most fills happen in a small subset of states.
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Occupancy = feature steps in this state. Coverage = occupancy-labeled (markout/occupancy). EV_1step = one-step Markov EV (shrunk μ). Cov% = transition mass into known states.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="text-left py-2 pr-4">State</th>
                <th className="text-left py-2 pr-4">Label</th>
                <th className="text-right py-2 pr-4">Occupancy</th>
                <th className="text-right py-2 pr-4">Markout count</th>
                <th className="text-right py-2 pr-4">Markout</th>
                <th className="text-right py-2 pr-4">Coverage</th>
                <th className="text-right py-2 pr-4">EV_1step</th>
                <th className="text-right py-2">Cov%</th>
              </tr>
            </thead>
            <tbody>
              {markovStates.slice(0, 10).map((row) => {
                const ev = computeEV1Step(markovForEv, String(row.state), { shrinkK: 20 });
                return (
                  <tr key={row.state} className="border-t border-border/30">
                    <td className="py-2 pr-4">{row.state}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{row.label}</td>
                    <td className="py-2 pr-4 text-right">{row.count}</td>
                    <td className="py-2 pr-4 text-right">{row.markoutCount}</td>
                    <td className="py-2 pr-4 text-right">
                      {row.markoutCount > 0 ? formatBps(row.markout?.wavgBps ?? null) : "—"}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {formatCoverage(row.markoutCount, row.count)}
                    </td>
                    <td className="py-2 pr-4 text-right">{formatBps(ev.evBps)}</td>
                    <td className="py-2 text-right">
                      {ev.coverage < 0.001 ? "—" : `${(ev.coverage * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card className="bg-card/40 border-border/50">
        <CardHeader>
          <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
            Most evidenced states
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Where we have evidence: states that had fills with attributed markouts. Coverage = occupancy-labeled. Cov% = transition mass into known states.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="text-left py-2 pr-4">State</th>
                <th className="text-left py-2 pr-4">Label</th>
                <th className="text-right py-2 pr-4">Markout count</th>
                <th className="text-right py-2 pr-4">WAvg</th>
                <th className="text-right py-2 pr-4">Notional</th>
                <th className="text-right py-2 pr-4">Coverage</th>
                <th className="text-right py-2 pr-4">EV_1step</th>
                <th className="text-right py-2">Cov%</th>
              </tr>
            </thead>
            <tbody>
              {mostEvidencedStates.map((row) => {
                const ev = computeEV1Step(markovForEv, String(row.state), { shrinkK: 20 });
                return (
                  <tr key={row.state} className="border-t border-border/30">
                    <td className="py-2 pr-4">{row.state}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{row.label}</td>
                    <td className="py-2 pr-4 text-right">{row.markoutCount}</td>
                    <td className="py-2 pr-4 text-right">
                      {row.markoutCount > 0 ? formatBps(row.markout?.wavgBps ?? null) : "—"}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {row.markout?.notional != null && Number.isFinite(row.markout.notional)
                        ? row.markout.notional.toFixed(1)
                        : "—"}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {formatCoverage(row.markoutCount, row.count)}
                    </td>
                    <td className="py-2 pr-4 text-right">{formatBps(ev.evBps)}</td>
                    <td className="py-2 text-right">
                      {ev.coverage < 0.001 ? "—" : `${(ev.coverage * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card className="bg-card/40 border-border/50">
        <CardHeader>
          <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
            Top Transitions
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto space-y-4">
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="text-left py-2 pr-4">From</th>
                <th className="text-left py-2 pr-4">To</th>
                <th className="text-right py-2 pr-4">Count</th>
                <th className="text-right py-2">Prob</th>
              </tr>
            </thead>
            <tbody>
              {transitions.slice(0, 12).map((row, idx) => (
                <tr key={`${row.from}-${row.to}-${idx}`} className="border-t border-border/30">
                  <td className="py-2 pr-4">{row.from}</td>
                  <td className="py-2 pr-4">{row.to}</td>
                  <td className="py-2 pr-4 text-right">{row.count}</td>
                  <td className="py-2 text-right">{formatPct(row.prob)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-2">Top non-self transitions</div>
            <table className="w-full text-xs font-mono border-collapse">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  <th className="text-left py-2 pr-4">From</th>
                  <th className="text-left py-2 pr-4">To</th>
                  <th className="text-right py-2 pr-4">Count</th>
                  <th className="text-right py-2">Prob</th>
                </tr>
              </thead>
              <tbody>
                {nonSelfTransitions.slice(0, 12).map((row, idx) => (
                  <tr key={`nonself-${row.from}-${row.to}-${idx}`} className="border-t border-border/30">
                    <td className="py-2 pr-4">{row.from}</td>
                    <td className="py-2 pr-4">{row.to}</td>
                    <td className="py-2 pr-4 text-right">{row.count}</td>
                    <td className="py-2 text-right">{formatPct(row.prob)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {nonSelfTransitions.length === 0 && (
              <p className="text-xs text-muted-foreground py-2">All transitions are self-loops (coarse bins / frequent sampling).</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card/40 border-border/50">
        <CardHeader>
          <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
            Best Evidenced Combos
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Top 15 by WAvg among rows with attributed markouts (count &gt; 0). This is what actually worked.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="text-left py-2 pr-4">State</th>
                <th className="text-left py-2 pr-4">Kind</th>
                <th className="text-right py-2 pr-4">Wallet</th>
                <th className="text-right py-2 pr-4">Count</th>
                <th className="text-right py-2 pr-4">WAvg</th>
                <th className="text-right py-2">Fill Rate</th>
              </tr>
            </thead>
            <tbody>
              {topRows.length === 0 && (
                <tr className="border-t border-border/30">
                  <td colSpan={6} className="py-3 text-center text-muted-foreground">
                    No evidenced rows in this window.
                  </td>
                </tr>
              )}
              {topRows.map((row, idx) => (
                <tr key={`top-${idx}`} className="border-t border-border/30">
                  <td className="py-2 pr-4">{row.state}</td>
                  <td className="py-2 pr-4">{row.kind}</td>
                  <td className="py-2 pr-4 text-right">{row.walletId}</td>
                  <td className="py-2 pr-4 text-right">{row.count}</td>
                  <td className="py-2 pr-4 text-right">{formatBps(row.wavgBps)}</td>
                  <td className="py-2 text-right">{formatPct(row.fillRate ?? null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card className="bg-card/40 border-border/50">
        <CardHeader>
          <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
            Worst Evidenced Combos
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Bottom 15 by WAvg among rows with attributed markouts (count &gt; 0). This is what did not work.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="text-left py-2 pr-4">State</th>
                <th className="text-left py-2 pr-4">Kind</th>
                <th className="text-right py-2 pr-4">Wallet</th>
                <th className="text-right py-2 pr-4">Count</th>
                <th className="text-right py-2 pr-4">WAvg</th>
                <th className="text-right py-2">Fill Rate</th>
              </tr>
            </thead>
            <tbody>
              {bottomRows.length === 0 && (
                <tr className="border-t border-border/30">
                  <td colSpan={6} className="py-3 text-center text-muted-foreground">
                    No evidenced rows in this window.
                  </td>
                </tr>
              )}
              {bottomRows.map((row, idx) => (
                <tr key={`bottom-${idx}`} className="border-t border-border/30">
                  <td className="py-2 pr-4">{row.state}</td>
                  <td className="py-2 pr-4">{row.kind}</td>
                  <td className="py-2 pr-4 text-right">{row.walletId}</td>
                  <td className="py-2 pr-4 text-right">{row.count}</td>
                  <td className="py-2 pr-4 text-right">{formatBps(row.wavgBps)}</td>
                  <td className="py-2 text-right">{formatPct(row.fillRate ?? null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card className="bg-card/40 border-border/50">
        <CardHeader>
          <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
            No-Markout Combos (Unknown Outcome)
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Orders seen for these (state, kind, wallet) combos, but no attributed markouts in this window yet. Treat as unknown, not win/loss.
          </p>
        </CardHeader>
        <CardContent className="space-y-2 overflow-x-auto">
          <div className="text-[10px] text-muted-foreground font-mono">
            Unknown rows: {nonEvidencedRows.length} / {strategyRows.length}
          </div>
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                <th className="text-left py-2 pr-4">State</th>
                <th className="text-left py-2 pr-4">Kind</th>
                <th className="text-right py-2 pr-4">Wallet</th>
                <th className="text-right py-2 pr-4">Count</th>
                <th className="text-right py-2 pr-4">WAvg</th>
                <th className="text-right py-2">Fill Rate</th>
              </tr>
            </thead>
            <tbody>
              {noEvidencePreviewRows.length === 0 && (
                <tr className="border-t border-border/30">
                  <td colSpan={6} className="py-3 text-center text-muted-foreground">
                    All rows have markout evidence.
                  </td>
                </tr>
              )}
              {noEvidencePreviewRows.map((row, idx) => (
                <tr key={`unknown-${idx}`} className="border-t border-border/30">
                  <td className="py-2 pr-4">{row.state}</td>
                  <td className="py-2 pr-4">{row.kind}</td>
                  <td className="py-2 pr-4 text-right">{row.walletId}</td>
                  <td className="py-2 pr-4 text-right">{row.count}</td>
                  <td className="py-2 pr-4 text-right">{formatBps(row.wavgBps)}</td>
                  <td className="py-2 text-right">{formatPct(row.fillRate ?? null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
