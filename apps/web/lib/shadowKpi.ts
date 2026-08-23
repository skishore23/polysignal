import { getDb } from "./db";

export type ShadowKpiBucket = {
  spreadBucket: string;
  fills: number;
  notionalTotal: number;
  notionalPerDay: number;
  evBps5m: number | null;
  evBps10m: number | null;
  expectedDollarsPerDay: number | null;
};

export type ShadowKpiFilters = {
  lane?: string;
  bucket?: string;
  horizonMs: number;
  windowHours: number;
};

const BOOTSTRAP_B = 2000;

function bootstrapCiMean(xs: number[], alpha: number): [number, number] {
  if (!xs.length || xs.length < 2) return [NaN, NaN];
  const n = xs.length;
  const means: number[] = [];
  for (let b = 0; b < BOOTSTRAP_B; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(Math.random() * n);
      sum += xs[j] ?? 0;
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const loIdx = Math.floor((alpha / 2) * (BOOTSTRAP_B - 1));
  const hiIdx = Math.ceil((1 - alpha / 2) * (BOOTSTRAP_B - 1));
  return [means[loIdx] ?? NaN, means[hiIdx] ?? NaN];
}

export type ShadowKpi = {
  windowHours: number;
  horizonMs: number;
  lane?: string;
  bucket?: string;
  evBps: number | null;
  evBpsCiLo: number | null;
  evBpsCiHi: number | null;
  evBps5m: number | null;
  evBps10m: number | null;
  expectedDollarsPerDay: number | null;
  completedCycles: number;
  avgTimeInInventoryMs: number | null;
  medianTimeInInventoryMs: number | null;
  p90TimeInInventoryMs: number | null;
  openPositionsCount: number;
  p95DrawdownProxyBps: number | null;
  byBucket: ShadowKpiBucket[];
  ts: number;
};

export type CiBasis = "markouts" | "cycles";

export type ShadowKpiResponse = ShadowKpi & {
  status: "ok" | "empty" | "error";
  emptyReason?: string;
  error?: { code: string; message: string };
  diagnostics?: { laneRows: number; markoutRows: number };
  ciBasis?: CiBasis;
  nCycles?: number;
  nFills?: number;
  nMarkouts?: number;
  updatedAt: number;
  filters: ShadowKpiFilters;
};

const BUCKET_ORDER = ["0-10", "10-25", "25-50", "50-100", "100-200", "200+", "unknown"];

function bucketSpread(rtSpreadBps: number): string {
  if (!Number.isFinite(rtSpreadBps) || rtSpreadBps < 0) return "unknown";
  if (rtSpreadBps <= 10) return "0-10";
  if (rtSpreadBps <= 25) return "10-25";
  if (rtSpreadBps <= 50) return "25-50";
  if (rtSpreadBps <= 100) return "50-100";
  if (rtSpreadBps <= 200) return "100-200";
  return "200+";
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  const i = Math.max(0, idx);
  return sorted[i] ?? null;
}

const POLICY_V0_ENTRY_KINDS = "('MAKER_BID','MAKER_ASK','INVENTORY_REBALANCE')";
const POLICY_V0_ENTRY_KIND_SET = new Set([
  "MAKER_BID",
  "MAKER_ASK",
  "INVENTORY_REBALANCE"
]);
const ALL_KINDS =
  "('MAKER_BID','MAKER_ASK','INVENTORY_REBALANCE','TAKER_BUY','TAKER_SELL')";

export function getShadowKpi(
  sqlite: ReturnType<typeof getDb>["sqlite"],
  opts: {
    walletId?: number | null;
    windowHours?: number;
    horizonMs?: number;
    lane?: "policy_v0";
    bucket?: "spread_200p";
  } = {}
): ShadowKpiResponse {
  const windowHours = opts.windowHours ?? 24;
  const horizonMs = opts.horizonMs ?? 300_000;
  const since = Date.now() - windowHours * 60 * 60 * 1000;
  const walletClause = opts.walletId != null ? "AND o.wallet_id = @walletId" : "";
  const kindClause =
    opts.lane === "policy_v0"
      ? `AND o.kind IN ${POLICY_V0_ENTRY_KINDS}`
      : `AND o.kind IN ${ALL_KINDS}`;
  const spreadClause =
    opts.bucket === "spread_200p"
      ? "AND o.spread_bps IS NOT NULL AND o.spread_bps * 2 >= 200"
      : "";
  const params =
    opts.walletId != null
      ? { since, walletId: opts.walletId, horizonMs }
      : { since, horizonMs };

  const filters: ShadowKpiFilters = {
    lane: opts.lane,
    bucket: opts.bucket,
    horizonMs,
    windowHours
  };
  const updatedAt = Date.now();

  const byBucket: ShadowKpiBucket[] = BUCKET_ORDER.map((b) => ({
    spreadBucket: b,
    fills: 0,
    notionalTotal: 0,
    notionalPerDay: 0,
    evBps5m: null,
    evBps10m: null,
    expectedDollarsPerDay: null
  }));

  let totalFills = 0;
  let totalNotional = 0;
  const timeInInventoryMs: number[] = [];
  let openPositionsCount = 0;
  const markoutBpsList: number[] = [];
  const cycleEvBpsList: number[] = [];

  let status: "ok" | "empty" | "error" = "ok";
  let emptyReason: string | undefined;
  let error: { code: string; message: string } | undefined;
  let diagnostics: { laneRows: number; markoutRows: number } | undefined;
  let laneRows = 0;
  let markoutRows = 0;

  try {
    const fillsWithSpread = sqlite
      .prepare(
        `SELECT f.id as fill_id, f.ts as ts, f.method as method, f.size as size, f.price as price,
                o.wallet_id as wallet_id, o.token_id as token_id, o.side as side,
                o.spread_bps as spread_bps
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE f.ts >= @since AND o.execution_mode = 'SHADOW'
           ${kindClause}
           ${spreadClause}
           ${walletClause}
         ORDER BY o.wallet_id, o.token_id, f.ts ASC`
      )
      .all(params) as Array<{
      fill_id: number;
      ts: number;
      method: string | null;
      size: number | null;
      price: number | null;
      wallet_id: number | null;
      token_id: string;
      side: string;
      spread_bps: number | null;
    }>;

    for (const f of fillsWithSpread) {
      const notional = (f.size ?? 0) * (f.price ?? 0);
      if (Number.isFinite(notional) && notional > 0) {
        totalNotional += notional;
        totalFills += 1;
        const spreadBps = f.spread_bps ?? 0;
        const bucket = bucketSpread(spreadBps * 2);
        const idx = BUCKET_ORDER.indexOf(bucket);
        if (idx >= 0 && idx < byBucket.length) {
          byBucket[idx]!.fills += 1;
          byBucket[idx]!.notionalTotal += notional;
        }
      }
    }

    const notionalPerDay = (totalNotional / windowHours) * 24;
    byBucket.forEach((b) => {
      b.notionalPerDay = (b.notionalTotal / windowHours) * 24;
    });

    const fillsForHold = sqlite
      .prepare(
        `SELECT f.id as fill_id, f.ts as ts, o.wallet_id as wallet_id, o.token_id as token_id,
                o.side as side, f.size as size
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE f.ts >= @since AND o.execution_mode = 'SHADOW'
           AND o.kind IN ${POLICY_V0_ENTRY_KINDS}
           ${spreadClause}
           AND f.method != 'synthetic_fill'
           ${walletClause}
         ORDER BY o.wallet_id, o.token_id, f.ts ASC`
      )
      .all(params) as Array<{
      fill_id: number;
      ts: number;
      wallet_id: number | null;
      token_id: string;
      side: string;
      size: number | null;
    }>;

    const markoutsByFill = sqlite
      .prepare(
        `SELECT m.fill_id as fill_id, m.markout_bps as markout_bps
         FROM shadow_markouts m
         JOIN shadow_fills f ON f.id = m.fill_id
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE f.ts >= @since AND o.execution_mode = 'SHADOW'
           ${kindClause}
           ${spreadClause}
           AND m.horizon_ms = @horizonMs
           ${walletClause}`
      )
      .all(params) as Array<{ fill_id: number; markout_bps: number | null }>;
    const markoutByFillId = new Map<number, number>();
    for (const row of markoutsByFill) {
      if (row.markout_bps != null && Number.isFinite(row.markout_bps)) {
        markoutByFillId.set(row.fill_id, row.markout_bps);
      }
    }

    const key = (w: number | null, t: string) => `${w ?? -1}::${t}`;
    const posState = new Map<string, { position: number; openTs: number; fillIds: number[] }>();
    for (const f of fillsForHold) {
      const k = key(f.wallet_id, f.token_id);
      const size = Number(f.size ?? 0) || 0;
      const delta = f.side === "BUY" ? size : -size;
      const st = posState.get(k) ?? { position: 0, openTs: f.ts, fillIds: [] };
      st.fillIds.push(f.fill_id);
      const prevPos = st.position;
      st.position += delta;
      if (prevPos === 0 && st.position !== 0) st.openTs = f.ts;
      if (prevPos !== 0 && st.position === 0) {
        timeInInventoryMs.push(f.ts - st.openTs);
        let cycleSum = 0;
        let cycleCount = 0;
        for (const fid of st.fillIds) {
          const mb = markoutByFillId.get(fid);
          if (mb != null) {
            cycleSum += mb;
            cycleCount += 1;
          }
        }
        if (cycleCount > 0) {
          cycleEvBpsList.push(cycleSum / cycleCount);
        }
        st.fillIds = [];
      }
      posState.set(k, st);
    }

    const positions = sqlite
      .prepare(
        `SELECT o.wallet_id as wallet_id, o.token_id as token_id,
                SUM(CASE WHEN o.side = 'BUY' THEN f.size ELSE -f.size END) as position
         FROM shadow_fills f
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE o.kind IN ${POLICY_V0_ENTRY_KINDS}
           ${spreadClause}
           AND o.execution_mode = 'SHADOW' AND f.method != 'synthetic_fill'
           ${walletClause}
         GROUP BY o.wallet_id, o.token_id
         HAVING position != 0`
      )
      .all(params) as Array<{ position: number }>;
    openPositionsCount = positions.length;

    const markouts = sqlite
      .prepare(
        `SELECT m.markout_bps as markout_bps
         FROM shadow_markouts m
         JOIN shadow_fills f ON f.id = m.fill_id
         JOIN shadow_orders o ON o.id = f.order_id
         WHERE f.ts >= @since AND o.execution_mode = 'SHADOW'
           ${kindClause}
           ${spreadClause}
           AND m.horizon_ms = @horizonMs
           ${walletClause}`
      )
      .all(params) as Array<{ markout_bps: number | null }>;
    for (const m of markouts) {
      if (m.markout_bps != null && Number.isFinite(m.markout_bps)) {
        markoutBpsList.push(m.markout_bps);
      }
    }

    laneRows = fillsWithSpread.length;
    markoutRows = markoutBpsList.length;
    diagnostics = { laneRows, markoutRows };
    if (laneRows === 0) {
      status = "empty";
      emptyReason = "Lane filter returned 0 rows (no completed maker cycles in window)";
    } else if (markoutRows === 0) {
      status = "empty";
      emptyReason = "Insufficient markouts at selected horizon";
    } else {
      status = "ok";
    }
  } catch (err) {
    status = "error";
    error = {
      code: "SHADOW_KPI_ERROR",
      message: err instanceof Error ? err.message : String(err)
    };
  }

  const sortedMarkout = [...markoutBpsList].sort((a, b) => a - b);
  const p95DrawdownProxyBps =
    sortedMarkout.length > 0 ? percentile(sortedMarkout, 5) : null;

  const sortedTime = [...timeInInventoryMs].sort((a, b) => a - b);
  const avgTimeInInventoryMs =
    timeInInventoryMs.length > 0
      ? timeInInventoryMs.reduce((a, b) => a + b, 0) / timeInInventoryMs.length
      : null;
  const medianTimeInInventoryMs = percentile(sortedTime, 50);
  const p90TimeInInventoryMs = percentile(sortedTime, 90);

  const notionalPerDay = (totalNotional / windowHours) * 24;
  const nCycles = timeInInventoryMs.length;
  const nFills = totalFills;
  const nMarkouts = markoutBpsList.length;
  let evBps: number | null;
  let evBpsCiLo: number | null;
  let evBpsCiHi: number | null;
  let ciBasis: CiBasis = "markouts";
  if (cycleEvBpsList.length >= 2) {
    evBps = cycleEvBpsList.reduce((a, b) => a + b, 0) / cycleEvBpsList.length;
    const [lo, hi] = bootstrapCiMean(cycleEvBpsList, 0.05);
    evBpsCiLo = Number.isFinite(lo) ? lo : null;
    evBpsCiHi = Number.isFinite(hi) ? hi : null;
    ciBasis = "cycles";
  } else {
    evBps =
      markoutBpsList.length > 0
        ? markoutBpsList.reduce((a, b) => a + b, 0) / markoutBpsList.length
        : null;
    const [lo, hi] =
      markoutBpsList.length >= 2 ? bootstrapCiMean(markoutBpsList, 0.05) : [NaN, NaN];
    evBpsCiLo = lo != null && Number.isFinite(lo) ? lo : null;
    evBpsCiHi = hi != null && Number.isFinite(hi) ? hi : null;
  }
  const evBps5m = horizonMs === 300_000 ? evBps : null;
  const evBps10m = horizonMs === 600_000 ? evBps : null;
  const expectedDollarsPerDay =
    evBps != null && Number.isFinite(evBps)
      ? notionalPerDay * (evBps / 10_000)
      : null;

  const ts = Date.now();
  return {
    windowHours,
    horizonMs,
    lane: opts.lane,
    bucket: opts.bucket,
    completedCycles: nCycles,
    evBps,
    evBpsCiLo,
    evBpsCiHi,
    evBps5m,
    evBps10m,
    expectedDollarsPerDay,
    avgTimeInInventoryMs,
    medianTimeInInventoryMs: medianTimeInInventoryMs ?? null,
    p90TimeInInventoryMs: p90TimeInInventoryMs ?? null,
    openPositionsCount,
    p95DrawdownProxyBps,
    byBucket: byBucket.filter((b) => b.fills > 0),
    ts,
    status,
    ...(emptyReason !== undefined && { emptyReason }),
    ...(error !== undefined && { error }),
    ...(diagnostics !== undefined && { diagnostics }),
    ciBasis,
    nCycles,
    nFills,
    nMarkouts,
    updatedAt,
    filters
  };
}

const HORIZONS_MS = [300_000, 600_000, 1_200_000] as const;
const HORIZON_LABELS: Record<number, string> = {
  300_000: "5m",
  600_000: "10m",
  1_200_000: "20m"
};

export type ShadowKpiPerHorizon = {
  horizonMs: number;
  horizonLabel: string;
  evBps: number | null;
  evBpsCiLo: number | null;
  evBpsCiHi: number | null;
  completedCycles: number;
  markoutRows: number;
  expectedDollarsPerDay: number | null;
  status: "ok" | "empty" | "error";
  emptyReason?: string;
  ciBasis?: CiBasis;
  nCycles?: number;
  nFills?: number;
  nMarkouts?: number;
};

export type ShadowKpiMultiHorizonResponse = {
  windowHours: number;
  horizons: ShadowKpiPerHorizon[];
  lane?: string;
  bucket?: string;
  updatedAt: number;
};

export function getShadowKpiMultiHorizon(
  sqlite: ReturnType<typeof getDb>["sqlite"],
  opts: {
    walletId?: number | null;
    windowHours?: number;
    lane?: "policy_v0";
    bucket?: "spread_200p";
  } = {}
): ShadowKpiMultiHorizonResponse {
  const windowHours = opts.windowHours ?? 24;
  const horizons: ShadowKpiPerHorizon[] = [];

  for (const horizonMs of HORIZONS_MS) {
    const kpi = getShadowKpi(sqlite, {
      ...opts,
      windowHours,
      horizonMs
    });
    horizons.push({
      horizonMs,
      horizonLabel: HORIZON_LABELS[horizonMs] ?? `${horizonMs / 60_000}m`,
      evBps: kpi.evBps,
      evBpsCiLo: kpi.evBpsCiLo,
      evBpsCiHi: kpi.evBpsCiHi,
      completedCycles: kpi.completedCycles,
      markoutRows: kpi.diagnostics?.markoutRows ?? 0,
      expectedDollarsPerDay: kpi.expectedDollarsPerDay,
      status: kpi.status,
      ...(kpi.emptyReason !== undefined && { emptyReason: kpi.emptyReason }),
      ciBasis: kpi.ciBasis,
      nCycles: kpi.nCycles,
      nFills: kpi.nFills,
      nMarkouts: kpi.nMarkouts
    });
  }

  return {
    windowHours,
    horizons,
    lane: opts.lane,
    bucket: opts.bucket,
    updatedAt: Date.now()
  };
}

const TIME_TREND_WINDOWS = [6, 24, 168] as const;

export type ShadowKpiTimeTrendWindow = {
  windowHours: number;
  evBps: number | null;
  evBpsCiLo: number | null;
  evBpsCiHi: number | null;
  n: number;
  expectedDollarsPerDay: number | null;
  status: "ok" | "empty" | "error";
  ciBasis?: CiBasis;
  nCycles?: number;
  nFills?: number;
  nMarkouts?: number;
};

export type ShadowKpiTimeTrendResponse = {
  horizonMs: number;
  horizonLabel: string;
  windows: ShadowKpiTimeTrendWindow[];
  lane?: string;
  bucket?: string;
  updatedAt: number;
};

export function getShadowKpiTimeTrend(
  sqlite: ReturnType<typeof getDb>["sqlite"],
  opts: {
    walletId?: number | null;
    horizonMs?: number;
    lane?: "policy_v0";
    bucket?: "spread_200p";
  } = {}
): ShadowKpiTimeTrendResponse {
  const horizonMs = opts.horizonMs ?? 600_000;
  const horizonLabel = HORIZON_LABELS[horizonMs] ?? `${horizonMs / 60_000}m`;
  const windows: ShadowKpiTimeTrendWindow[] = [];

  for (const windowHours of TIME_TREND_WINDOWS) {
    const kpi = getShadowKpi(sqlite, {
      ...opts,
      windowHours,
      horizonMs
    });
    windows.push({
      windowHours,
      evBps: kpi.evBps,
      evBpsCiLo: kpi.evBpsCiLo,
      evBpsCiHi: kpi.evBpsCiHi,
      n: kpi.diagnostics?.markoutRows ?? 0,
      expectedDollarsPerDay: kpi.expectedDollarsPerDay,
      status: kpi.status,
      ciBasis: kpi.ciBasis,
      nCycles: kpi.nCycles,
      nFills: kpi.nFills,
      nMarkouts: kpi.nMarkouts
    });
  }

  return {
    horizonMs,
    horizonLabel,
    windows,
    lane: opts.lane,
    bucket: opts.bucket,
    updatedAt: Date.now()
  };
}

export type EdgeMapCell = {
  lane: string;
  bucket: string;
  horizonMs: number;
  horizonLabel: string;
  evBps: number | null;
  evBpsCiLo: number | null;
  evBpsCiHi: number | null;
  expectedDollarsPerDay: number | null;
  medianHoldMs: number | null;
  p90HoldMs: number | null;
  p95DrawdownBps: number | null;
  status: "ok" | "empty" | "error";
  ciBasis?: CiBasis;
  nCycles: number;
  nFills: number;
  nMarkouts: number;
};

type RawFill = {
  fill_id: number;
  ts: number;
  wallet_id: number | null;
  token_id: string;
  side: string;
  size: number | null;
  price: number | null;
  method: string | null;
  spread_bps: number | null;
  kind: string;
};

function computeCellFromFills(
  fills: RawFill[],
  markoutByFillId: Map<number, number>,
  horizonMs: number,
  windowHours: number
): Omit<EdgeMapCell, "lane" | "bucket" | "horizonMs" | "horizonLabel" | "status"> & { status: "ok" | "empty" } {
  const key = (w: number | null, t: string) => `${w ?? -1}::${t}`;
  const posState = new Map<string, { position: number; openTs: number; fillIds: number[] }>();
  const timeInInventoryMs: number[] = [];
  const cycleEvBpsList: number[] = [];
  let totalNotional = 0;

  for (const f of fills) {
    const notional = (f.size ?? 0) * (f.price ?? 0);
    if (Number.isFinite(notional) && notional > 0) totalNotional += notional;
    const size = Number(f.size ?? 0) || 0;
    const delta = f.side === "BUY" ? size : -size;
    const k = key(f.wallet_id, f.token_id);
    const st = posState.get(k) ?? { position: 0, openTs: f.ts, fillIds: [] };
    st.fillIds.push(f.fill_id);
    const prevPos = st.position;
    st.position += delta;
    if (prevPos === 0 && st.position !== 0) st.openTs = f.ts;
    if (prevPos !== 0 && st.position === 0) {
      timeInInventoryMs.push(f.ts - st.openTs);
      let cycleSum = 0;
      let cycleCount = 0;
      for (const fid of st.fillIds) {
        const mb = markoutByFillId.get(fid);
        if (mb != null) {
          cycleSum += mb;
          cycleCount += 1;
        }
      }
      if (cycleCount > 0) {
        cycleEvBpsList.push(cycleSum / cycleCount);
      }
      st.fillIds = [];
    }
    posState.set(k, st);
  }

  const nCycles = timeInInventoryMs.length;
  const nFills = fills.length;
  const markoutBpsList: number[] = [];
  for (const f of fills) {
    const mb = markoutByFillId.get(f.fill_id);
    if (mb != null) markoutBpsList.push(mb);
  }
  const nMarkouts = markoutBpsList.length;
  const sortedTime = [...timeInInventoryMs].sort((a, b) => a - b);
  const medianHoldMs = percentile(sortedTime, 50);
  const p90HoldMs = percentile(sortedTime, 90);
  const sortedMarkout = [...markoutBpsList].sort((a, b) => a - b);
  const p95DrawdownBps = sortedMarkout.length > 0 ? percentile(sortedMarkout, 5) : null;

  let evBps: number | null;
  let evBpsCiLo: number | null;
  let evBpsCiHi: number | null;
  let ciBasis: CiBasis = "markouts";
  if (cycleEvBpsList.length >= 2) {
    evBps = cycleEvBpsList.reduce((a, b) => a + b, 0) / cycleEvBpsList.length;
    const [lo, hi] = bootstrapCiMean(cycleEvBpsList, 0.05);
    evBpsCiLo = Number.isFinite(lo) ? lo : null;
    evBpsCiHi = Number.isFinite(hi) ? hi : null;
    ciBasis = "cycles";
  } else if (markoutBpsList.length > 0) {
    evBps = markoutBpsList.reduce((a, b) => a + b, 0) / markoutBpsList.length;
    const [lo, hi] =
      markoutBpsList.length >= 2 ? bootstrapCiMean(markoutBpsList, 0.05) : [null, null];
    evBpsCiLo = lo != null && Number.isFinite(lo) ? lo : null;
    evBpsCiHi = hi != null && Number.isFinite(hi) ? hi : null;
  } else {
    evBps = null;
    evBpsCiLo = null;
    evBpsCiHi = null;
  }

  const notionalPerDay = (totalNotional / windowHours) * 24;
  const expectedDollarsPerDay =
    evBps != null && Number.isFinite(evBps) ? notionalPerDay * (evBps / 10_000) : null;

  const status: "ok" | "empty" = nMarkouts > 0 ? "ok" : "empty";
  return {
    evBps,
    evBpsCiLo,
    evBpsCiHi,
    expectedDollarsPerDay,
    medianHoldMs: medianHoldMs ?? null,
    p90HoldMs: p90HoldMs ?? null,
    p95DrawdownBps,
    status,
    ciBasis,
    nCycles,
    nFills,
    nMarkouts
  };
}

export function getShadowKpiEdgeMap(
  sqlite: ReturnType<typeof getDb>["sqlite"],
  opts: { windowHours?: number } = {}
): { cells: EdgeMapCell[]; updatedAt: number } {
  const windowHours = opts.windowHours ?? 24;
  const since = Date.now() - windowHours * 60 * 60 * 1000;

  const allFills = sqlite
    .prepare(
      `SELECT f.id as fill_id, f.ts as ts, f.method as method, f.size as size, f.price as price,
              o.wallet_id as wallet_id, o.token_id as token_id, o.side as side,
              o.spread_bps as spread_bps, o.kind as kind
       FROM shadow_fills f
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE f.ts >= @since AND o.execution_mode = 'SHADOW'
       ORDER BY o.wallet_id, o.token_id, f.ts ASC`
    )
    .all({ since }) as RawFill[];

  const allMarkouts = sqlite
    .prepare(
      `SELECT m.fill_id as fill_id, m.horizon_ms as horizon_ms, m.markout_bps as markout_bps
       FROM shadow_markouts m
       JOIN shadow_fills f ON f.id = m.fill_id
       JOIN shadow_orders o ON o.id = f.order_id
       WHERE f.ts >= @since AND o.execution_mode = 'SHADOW'`
    )
    .all({ since }) as Array<{ fill_id: number; horizon_ms: number; markout_bps: number | null }>;

  const markoutByFillByHorizon = new Map<number, Map<number, number>>();
  for (const row of allMarkouts) {
    if (row.markout_bps == null || !Number.isFinite(row.markout_bps)) continue;
    let byFill = markoutByFillByHorizon.get(row.horizon_ms);
    if (!byFill) {
      byFill = new Map();
      markoutByFillByHorizon.set(row.horizon_ms, byFill);
    }
    byFill.set(row.fill_id, row.markout_bps);
  }

  const lanes: { id: string; filter: (f: RawFill) => boolean }[] = [
    { id: "policy_v0", filter: (f) => POLICY_V0_ENTRY_KIND_SET.has(f.kind) },
    { id: "all", filter: () => true }
  ];
  const bucketFilters: { id: string; label: string; filter: (f: RawFill) => boolean }[] = [
    {
      id: "200+",
      label: "200+",
      filter: (f) => (f.spread_bps ?? 0) * 2 >= 200
    },
    {
      id: "100-200",
      label: "100-200",
      filter: (f) => {
        const rt = (f.spread_bps ?? 0) * 2;
        return rt >= 100 && rt < 200;
      }
    }
  ];

  const cells: EdgeMapCell[] = [];
  for (const lane of lanes) {
    const fillsForLane = allFills.filter(lane.filter);
    for (const bucket of bucketFilters) {
      const fillsForCell = fillsForLane.filter(bucket.filter);
      for (const horizonMs of HORIZONS_MS) {
        const horizonLabel = HORIZON_LABELS[horizonMs] ?? `${horizonMs / 60_000}m`;
        const markoutByFillId = markoutByFillByHorizon.get(horizonMs) ?? new Map();
        const cell = computeCellFromFills(
          fillsForCell,
          markoutByFillId,
          horizonMs,
          windowHours
        );
        cells.push({
          lane: lane.id,
          bucket: bucket.label,
          horizonMs,
          horizonLabel,
          ...cell
        });
      }
    }
  }

  return { cells, updatedAt: Date.now() };
}
