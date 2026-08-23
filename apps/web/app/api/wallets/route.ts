import { getDb } from "../../../lib/db";
import { resolveWalletMakerTakerFlags } from "../../../lib/wallet-flags";
import { eq, wallets } from "@polysignal/storage";
import { normalizeWalletMarketFilter, parseWalletMarketFilterJson } from "@polysignal/utils";
import { appConfig } from "../../../lib/config";


export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export async function GET() {
  const { db } = getDb();
  const rows = db.select().from(wallets).orderBy(wallets.id).all();
  return Response.json(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      startingBalance: row.startingBalance,
      sizeMultiplier: row.sizeMultiplier,
      maxOpenPositions: row.maxOpenPositions,
      minConfidence: row.minConfidence,
      minEdge: row.minEdge,
      autoOpenLimit: row.autoOpenLimit,
      autoTradeEnabled: row.autoTradeEnabled ?? 1,
      makerEnabled: row.makerEnabled ?? 0,
      // Maker-specific parameters
      makerQuoteSize: row.makerQuoteSize ?? 50,
      makerQuoteWidthBps: row.makerQuoteWidthBps ?? 20,
      makerMinSpread: row.makerMinSpread ?? 0.002,
      makerMaxSpread: row.makerMaxSpread ?? 0.02,
      makerMinDepth: row.makerMinDepth ?? 20,
      makerInventoryMaxAbs: row.makerInventoryMaxAbs ?? 500,
      makerInventorySkewBps: row.makerInventorySkewBps ?? 15,
      maxDailyLossUsd: row.maxDailyLossUsd ?? null,
      maxDrawdownPct: row.maxDrawdownPct ?? null,
      cooldownMinutes: row.cooldownMinutes ?? null,
      marketAllowlist: row.marketAllowlist ?? "",
      marketFilterJson: row.marketFilterJson ?? null,
      marketFilter: (() => {
        const parsed = parseWalletMarketFilterJson(row.marketFilterJson ?? null);
        return parsed.ok ? parsed.value : null;
      })(),
      createdAt: row.createdAt,
      // Position-level defaults (null means use global appConfig defaults)
      defaultStopLossPct: row.defaultStopLossPct,
      defaultTakeProfitPct: row.defaultTakeProfitPct,
      defaultMaxLossAbs: row.defaultMaxLossAbs,
      defaultMaxHoldSec: row.defaultMaxHoldSec,
      maxHoldMinutes: row.maxHoldMinutes ?? null
    })),
  );
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | {
      id?: number | null;
      name?: string;
      startingBalance?: number;
      sizeMultiplier?: number;
      maxOpenPositions?: number;
      minConfidence?: number;
      minEdge?: number;
      autoOpenLimit?: number;
      autoTradeEnabled?: boolean;
      makerEnabled?: boolean;
      maxDailyLossUsd?: number | null;
      maxDrawdownPct?: number | null;
      cooldownMinutes?: number | null;
      marketAllowlist?: string | null;
      marketFilter?: unknown;
      marketFilterJson?: string | null;
      clearMarketFilters?: boolean;
      // Maker-specific parameters
      makerQuoteSize?: number;
      makerQuoteWidthBps?: number;
      makerMinSpread?: number;
      makerMaxSpread?: number;
      makerMinDepth?: number;
      makerInventoryMaxAbs?: number;
      makerInventorySkewBps?: number;
      // Position-level defaults
      defaultStopLossPct?: number | null;
      defaultTakeProfitPct?: number | null;
      defaultMaxLossAbs?: number | null;
      defaultMaxHoldSec?: number | null;
      maxHoldMinutes?: number | null;
    }
    | null;

  if (!body) return Response.json({ error: "Invalid JSON payload." }, { status: 400 });

  const hasProp = (key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);

  const { db } = getDb();
  const name = (body.name ?? "Wallet").trim();
  const startingBalance = clampNumber(Number(body.startingBalance ?? appConfig.wallet.startingBalance), 0, 1_000_000_000);
  const sizeMultiplier = clampNumber(Number(body.sizeMultiplier ?? appConfig.wallet.sizeMultiplier), 0.1, 1000);
  const maxOpenPositions = Math.round(clampNumber(Number(body.maxOpenPositions ?? appConfig.wallet.maxOpenPositions), 1, 1000));
  const minConfidence = clampNumber(Number(body.minConfidence ?? appConfig.wallet.minConfidence), 0, 1);
  const minEdge = clampNumber(Number(body.minEdge ?? appConfig.wallet.minEdge), -1, 1);
  const autoOpenLimit = Math.round(clampNumber(Number(body.autoOpenLimit ?? appConfig.wallet.autoOpenLimit), 1, 50));
  const makerExecutionMode = "SHADOW";

  // Maker-specific parameters with sensible defaults and bounds
  const makerQuoteSize = clampNumber(Number(body.makerQuoteSize ?? 50), 1, 10000);
  const makerQuoteWidthBps = clampNumber(Number(body.makerQuoteWidthBps ?? 20), 1, 500);
  const makerMinSpread = clampNumber(Number(body.makerMinSpread ?? 0.002), 0, 0.5);
  const makerMaxSpread = clampNumber(Number(body.makerMaxSpread ?? 0.02), 0, 0.5);
  const makerMinDepth = clampNumber(Number(body.makerMinDepth ?? 20), 0, 10000);
  const makerInventoryMaxAbs = clampNumber(Number(body.makerInventoryMaxAbs ?? 500), 1, 100000);
  const makerInventorySkewBps = clampNumber(Number(body.makerInventorySkewBps ?? 15), 0, 500);

  const maxDailyLossUsd = body.maxDailyLossUsd == null
    ? null
    : clampNumber(Number(body.maxDailyLossUsd), 0, 1_000_000_000);
  const maxDrawdownRaw = body.maxDrawdownPct == null ? null : Number(body.maxDrawdownPct);
  const maxDrawdownPct = maxDrawdownRaw == null
    ? null
    : clampNumber(maxDrawdownRaw > 1 ? maxDrawdownRaw / 100 : maxDrawdownRaw, 0, 1);
  const cooldownMinutes = body.cooldownMinutes == null
    ? null
    : Math.round(clampNumber(Number(body.cooldownMinutes), 0, 10080));
  const marketAllowlist = (body.marketAllowlist ?? "").trim();
  const marketAllowlistValue = marketAllowlist.length ? marketAllowlist : null;
  const hasMarketFilterInBody = hasProp("marketFilter") || hasProp("marketFilterJson");

  let normalizedMarketFilterJson: string | null = null;
  if (hasProp("marketFilter")) {
    const normalized = normalizeWalletMarketFilter(body.marketFilter);
    if (!normalized.ok) {
      return Response.json({ error: normalized.error }, { status: 400 });
    }
    normalizedMarketFilterJson = normalized.value ? JSON.stringify(normalized.value) : null;
  } else if (hasProp("marketFilterJson")) {
    const parsed = parseWalletMarketFilterJson(body.marketFilterJson ?? null);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    normalizedMarketFilterJson = parsed.value ? JSON.stringify(parsed.value) : null;
  }
  
  // Position-level defaults (null means use global appConfig defaults)
  const parseOptionalNumber = (val: number | null | undefined): number | null => {
    if (val === null || val === undefined) return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  };
  const defaultStopLossPct = parseOptionalNumber(body.defaultStopLossPct);
  const defaultTakeProfitPct = parseOptionalNumber(body.defaultTakeProfitPct);
  const defaultMaxLossAbs = parseOptionalNumber(body.defaultMaxLossAbs);
  const defaultMaxHoldSec = body.defaultMaxHoldSec != null && Number.isFinite(body.defaultMaxHoldSec)
    ? Math.round(Number(body.defaultMaxHoldSec))
    : null;
  const maxHoldMinutes = body.maxHoldMinutes != null && Number.isFinite(Number(body.maxHoldMinutes))
    ? Math.round(Number(body.maxHoldMinutes))
    : null;

  if (!name) return Response.json({ error: "Name is required." }, { status: 400 });

  if (body.id != null) {
    const existing = db.select().from(wallets).where(eq(wallets.id, body.id)).all()[0];
    if (!existing) return Response.json({ error: "Wallet not found." }, { status: 404 });
    const { makerEnabled, autoTradeEnabled } = resolveWalletMakerTakerFlags(body, existing);
    const clearMarketFilters = body.clearMarketFilters === true;
    const isAllowlistCleared = hasProp("marketAllowlist") && marketAllowlistValue == null;
    const isFilterCleared = hasMarketFilterInBody && normalizedMarketFilterJson == null;
    const hasExistingMarketConfig =
      (existing.marketAllowlist != null && existing.marketAllowlist.trim().length > 0) ||
      (existing.marketFilterJson != null && existing.marketFilterJson.trim().length > 0);
    const preserveExistingMarketConfig =
      !clearMarketFilters && isAllowlistCleared && isFilterCleared && hasExistingMarketConfig;

    db.update(wallets)
      .set({
        name: hasProp("name") ? name : existing.name,
        startingBalance: hasProp("startingBalance") ? startingBalance : existing.startingBalance,
        sizeMultiplier: hasProp("sizeMultiplier") ? sizeMultiplier : existing.sizeMultiplier,
        maxOpenPositions: hasProp("maxOpenPositions") ? maxOpenPositions : existing.maxOpenPositions,
        minConfidence: hasProp("minConfidence") ? minConfidence : existing.minConfidence,
        minEdge: hasProp("minEdge") ? minEdge : existing.minEdge,
        autoOpenLimit: hasProp("autoOpenLimit") ? autoOpenLimit : existing.autoOpenLimit,
        autoTradeEnabled,
        makerEnabled,
        makerExecutionMode,
        makerQuoteSize: hasProp("makerQuoteSize") ? makerQuoteSize : existing.makerQuoteSize,
        makerQuoteWidthBps: hasProp("makerQuoteWidthBps") ? makerQuoteWidthBps : existing.makerQuoteWidthBps,
        makerMinSpread: hasProp("makerMinSpread") ? makerMinSpread : existing.makerMinSpread,
        makerMaxSpread: hasProp("makerMaxSpread") ? makerMaxSpread : existing.makerMaxSpread,
        makerMinDepth: hasProp("makerMinDepth") ? makerMinDepth : existing.makerMinDepth,
        makerInventoryMaxAbs: hasProp("makerInventoryMaxAbs") ? makerInventoryMaxAbs : existing.makerInventoryMaxAbs,
        makerInventorySkewBps: hasProp("makerInventorySkewBps") ? makerInventorySkewBps : existing.makerInventorySkewBps,
        maxDailyLossUsd: hasProp("maxDailyLossUsd") ? maxDailyLossUsd : existing.maxDailyLossUsd,
        maxDrawdownPct: hasProp("maxDrawdownPct") ? maxDrawdownPct : existing.maxDrawdownPct,
        cooldownMinutes: hasProp("cooldownMinutes") ? cooldownMinutes : existing.cooldownMinutes,
        marketAllowlist: preserveExistingMarketConfig
          ? existing.marketAllowlist ?? null
          : hasProp("marketAllowlist")
            ? marketAllowlistValue
            : existing.marketAllowlist ?? null,
        marketFilterJson: preserveExistingMarketConfig
          ? existing.marketFilterJson ?? null
          : hasMarketFilterInBody
            ? normalizedMarketFilterJson
            : existing.marketFilterJson ?? null,
        defaultStopLossPct: hasProp("defaultStopLossPct") ? defaultStopLossPct : existing.defaultStopLossPct,
        defaultTakeProfitPct: hasProp("defaultTakeProfitPct") ? defaultTakeProfitPct : existing.defaultTakeProfitPct,
        defaultMaxLossAbs: hasProp("defaultMaxLossAbs") ? defaultMaxLossAbs : existing.defaultMaxLossAbs,
        defaultMaxHoldSec: hasProp("defaultMaxHoldSec") ? defaultMaxHoldSec : existing.defaultMaxHoldSec,
        maxHoldMinutes: hasProp("maxHoldMinutes") ? maxHoldMinutes : existing.maxHoldMinutes
      })
      .where(eq(wallets.id, body.id))
      .run();
    return Response.json({ ok: true, id: body.id });
  }

  const now = Date.now();
  const { makerEnabled: makerEnabledDefault, autoTradeEnabled: autoTradeEnabledDefault } =
    resolveWalletMakerTakerFlags(body);
  const result = db.insert(wallets).values({
    name,
    startingBalance,
    sizeMultiplier,
    maxOpenPositions,
    minConfidence,
    minEdge,
    autoOpenLimit,
    autoTradeEnabled: autoTradeEnabledDefault,
    makerEnabled: makerEnabledDefault,
    makerExecutionMode,
    makerQuoteSize,
    makerQuoteWidthBps,
    makerMinSpread,
    makerMaxSpread,
    makerMinDepth,
    makerInventoryMaxAbs,
    makerInventorySkewBps,
    maxDailyLossUsd,
    maxDrawdownPct,
    cooldownMinutes,
    marketAllowlist: marketAllowlistValue,
    marketFilterJson: hasMarketFilterInBody ? normalizedMarketFilterJson : null,
    createdAt: now,
    defaultStopLossPct,
    defaultTakeProfitPct,
    defaultMaxLossAbs,
    defaultMaxHoldSec,
    maxHoldMinutes
  }).returning().all();
  return Response.json({ ok: true, id: result[0]?.id });
}
