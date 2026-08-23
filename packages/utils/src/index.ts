export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type BackoffOptions = {
  minMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
  maxAttempts: number;
};

export async function withBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: BackoffOptions,
): Promise<T> {
  let delay = opts.minMs;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const jitter = 1 + (Math.random() * 2 - 1) * opts.jitter;
      await sleep(Math.min(opts.maxMs, Math.round(delay * jitter)));
      delay = Math.min(opts.maxMs, Math.round(delay * opts.factor));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Backoff exhausted");
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const safeNumber = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

export const nowMs = (): number => Date.now();

export const toFixed = (value: number | null, digits: number): string =>
  value == null ? "-" : value.toFixed(digits);

export type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
};

export const noopLogger: LoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined
};

const DEFAULT_HORIZONS_SEC = [300, 900, 1800];

export function parseHorizonEnv(
  raw: string | undefined | null,
  fallback: number[] = DEFAULT_HORIZONS_SEC,
): number[] {
  if (!raw) return [...fallback];
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const parsed = parts
    .map((part) => parseHorizonValue(part))
    .filter((value): value is number => value != null && Number.isFinite(value) && value > 0);
  if (!parsed.length) return [...fallback];
  const out = parsed.slice(0, 3);
  while (out.length < 3) {
    out.push(fallback[out.length] ?? fallback[fallback.length - 1] ?? 300);
  }
  return out;
}

function parseHorizonValue(value: string): number | null {
  const lowered = value.toLowerCase();
  if (lowered.endsWith("m")) {
    const num = Number(lowered.slice(0, -1));
    return Number.isFinite(num) ? num * 60 : null;
  }
  if (lowered.endsWith("s")) {
    const num = Number(lowered.slice(0, -1));
    return Number.isFinite(num) ? num : null;
  }
  const num = Number(lowered);
  if (!Number.isFinite(num)) return null;
  return num < 60 ? num * 60 : num;
}

export {
  normalizeWalletMarketFilter,
  parseWalletMarketFilterJson,
  serializeWalletMarketFilter,
  type WalletMarketFilterNormalizeResult
} from "./walletFilters";
