const WALLET_MARKET_KINDS = [
  "TAKER_BUY",
  "TAKER_SELL",
  "MAKER_BID",
  "MAKER_ASK"
] as const;

type WalletMarketKind = (typeof WALLET_MARKET_KINDS)[number];
type WalletMarketFilterV1 = {
  version: 1;
  includeMarketIds?: string[];
  excludeMarketIds?: string[];
  minVolumeUsd?: number;
  maxVolumeUsd?: number;
  minLiquidityUsd?: number;
  maxLiquidityUsd?: number;
  requireActive?: boolean;
  allowedKinds?: WalletMarketKind[];
};

const MARKET_KIND_SET = new Set<WalletMarketKind>(WALLET_MARKET_KINDS);

export type WalletMarketFilterNormalizeResult =
  | { ok: true; value: WalletMarketFilterV1 | null }
  | { ok: false; error: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const normalizeStringArray = (
  value: unknown,
  field: string,
): { ok: true; value: string[] | undefined } | { ok: false; error: string } => {
  if (value == null) return { ok: true, value: undefined };
  if (!Array.isArray(value)) {
    return { ok: false, error: `${field} must be an array of strings` };
  }

  const deduped = Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0),
    ),
  );
  return { ok: true, value: deduped.length > 0 ? deduped : undefined };
};

const normalizeNonNegativeNumber = (
  value: unknown,
  field: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } => {
  if (value == null) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: `${field} must be a finite non-negative number` };
  }
  return { ok: true, value };
};

const normalizeAllowedKinds = (
  value: unknown,
): { ok: true; value: WalletMarketKind[] | undefined } | { ok: false; error: string } => {
  if (value == null) return { ok: true, value: undefined };
  if (!Array.isArray(value)) {
    return { ok: false, error: "allowedKinds must be an array of market kinds" };
  }

  const kinds: WalletMarketKind[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return { ok: false, error: "allowedKinds must contain strings only" };
    }
    const normalized = item.trim().toUpperCase() as WalletMarketKind;
    if (!MARKET_KIND_SET.has(normalized)) {
      return { ok: false, error: `allowedKinds contains unsupported kind: ${item}` };
    }
    if (!kinds.includes(normalized)) kinds.push(normalized);
  }

  return { ok: true, value: kinds.length > 0 ? kinds : undefined };
};

export const normalizeWalletMarketFilter = (
  value: unknown,
): WalletMarketFilterNormalizeResult => {
  if (value == null) return { ok: true, value: null };
  if (!isPlainObject(value)) {
    return { ok: false, error: "marketFilter must be a JSON object" };
  }

  const versionRaw = value.version;
  const version = versionRaw == null ? 1 : versionRaw;
  if (version !== 1) {
    return { ok: false, error: "marketFilter.version must be 1" };
  }

  const includeMarketIds = normalizeStringArray(value.includeMarketIds, "includeMarketIds");
  if (!includeMarketIds.ok) return includeMarketIds;
  const excludeMarketIds = normalizeStringArray(value.excludeMarketIds, "excludeMarketIds");
  if (!excludeMarketIds.ok) return excludeMarketIds;

  const minVolumeUsd = normalizeNonNegativeNumber(value.minVolumeUsd, "minVolumeUsd");
  if (!minVolumeUsd.ok) return minVolumeUsd;
  const maxVolumeUsd = normalizeNonNegativeNumber(value.maxVolumeUsd, "maxVolumeUsd");
  if (!maxVolumeUsd.ok) return maxVolumeUsd;
  const minLiquidityUsd = normalizeNonNegativeNumber(value.minLiquidityUsd, "minLiquidityUsd");
  if (!minLiquidityUsd.ok) return minLiquidityUsd;
  const maxLiquidityUsd = normalizeNonNegativeNumber(value.maxLiquidityUsd, "maxLiquidityUsd");
  if (!maxLiquidityUsd.ok) return maxLiquidityUsd;

  if (
    minVolumeUsd.value != null &&
    maxVolumeUsd.value != null &&
    minVolumeUsd.value > maxVolumeUsd.value
  ) {
    return { ok: false, error: "minVolumeUsd cannot be greater than maxVolumeUsd" };
  }
  if (
    minLiquidityUsd.value != null &&
    maxLiquidityUsd.value != null &&
    minLiquidityUsd.value > maxLiquidityUsd.value
  ) {
    return { ok: false, error: "minLiquidityUsd cannot be greater than maxLiquidityUsd" };
  }

  let requireActive: boolean | undefined;
  if (value.requireActive != null) {
    if (typeof value.requireActive !== "boolean") {
      return { ok: false, error: "requireActive must be a boolean" };
    }
    requireActive = value.requireActive;
  }

  const allowedKinds = normalizeAllowedKinds(value.allowedKinds);
  if (!allowedKinds.ok) return allowedKinds;

  const normalized: WalletMarketFilterV1 = {
    version: 1,
    ...(includeMarketIds.value ? { includeMarketIds: includeMarketIds.value } : {}),
    ...(excludeMarketIds.value ? { excludeMarketIds: excludeMarketIds.value } : {}),
    ...(minVolumeUsd.value != null ? { minVolumeUsd: minVolumeUsd.value } : {}),
    ...(maxVolumeUsd.value != null ? { maxVolumeUsd: maxVolumeUsd.value } : {}),
    ...(minLiquidityUsd.value != null ? { minLiquidityUsd: minLiquidityUsd.value } : {}),
    ...(maxLiquidityUsd.value != null ? { maxLiquidityUsd: maxLiquidityUsd.value } : {}),
    ...(requireActive != null ? { requireActive } : {}),
    ...(allowedKinds.value ? { allowedKinds: allowedKinds.value } : {})
  };

  return { ok: true, value: normalized };
};

export const parseWalletMarketFilterJson = (
  value: string | null | undefined,
): WalletMarketFilterNormalizeResult => {
  if (value == null || value.trim().length === 0) return { ok: true, value: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, error: "marketFilterJson is not valid JSON" };
  }
  return normalizeWalletMarketFilter(parsed);
};

export const serializeWalletMarketFilter = (
  value: WalletMarketFilterV1 | null | undefined,
): WalletMarketFilterNormalizeResult & { json: string | null } => {
  const normalized = normalizeWalletMarketFilter(value);
  if (!normalized.ok) return { ...normalized, json: null };
  return {
    ok: true,
    value: normalized.value,
    json: normalized.value ? JSON.stringify(normalized.value) : null
  };
};
