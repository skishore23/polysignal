// Determinism utilities to prevent flaky golden tests
// These ensure deterministic replay by enforcing consistent float rounding,
// stable JSON serialization, and time anchoring

const DEFAULT_PRECISION = 1e-9;

/**
 * Round float to specified precision (default 1e-9).
 * Used by both write-path and replay-path to ensure exact equality.
 */
export function roundFloat(value: number, precision: number = DEFAULT_PRECISION): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  return Math.round(value / precision) * precision;
}

/**
 * Stable JSON stringify with sorted keys and sorted arrays.
 * Used for signal `reasons` and evidence JSON to ensure exact match.
 */
export function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return JSON.stringify(obj);
  }

  if (typeof obj !== "object") {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    const sorted = [...obj].sort((a, b) => {
      const aStr = stableStringify(a);
      const bStr = stableStringify(b);
      return aStr.localeCompare(bStr);
    });
    return `[${sorted.map(stableStringify).join(",")}]`;
  }

  const sortedEntries = Object.entries(obj)
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
    .map(([key, value]) => `"${key}":${stableStringify(value)}`);

  return `{${sortedEntries.join(",")}}`;
}

/**
 * Setup test environment for determinism.
 * Sets TZ=UTC, ensures consistent time handling.
 */
export function setupDeterminism(): void {
  process.env.TZ = "UTC";
  
  // Ensure consistent behavior
  if (typeof process.env.NODE_ENV === "undefined") {
    process.env.NODE_ENV = "test";
  }
}

/**
 * Anchor time grid for deterministic sampling.
 * Returns start time and interval for consistent feature sampling.
 * 
 * Example: floor(minEventRecvTs/1000)*1000, then every 1000ms
 * 
 * @param minRecvTs Minimum receive timestamp in ms
 * @param intervalMs Sampling interval in ms (default 1000)
 * @returns Object with startTs and intervalMs
 */
export function anchorTimeGrid(
  minRecvTs: number,
  intervalMs: number = 1000
): { startTs: number; intervalMs: number } {
  const startTs = Math.floor(minRecvTs / intervalMs) * intervalMs;
  return { startTs, intervalMs };
}

/**
 * Generate next sample timestamp from anchored grid.
 * 
 * @param grid Grid from anchorTimeGrid()
 * @param currentTs Current timestamp
 * @returns Next sample timestamp
 */
export function nextSampleTime(
  grid: { startTs: number; intervalMs: number },
  currentTs: number
): number {
  const elapsed = currentTs - grid.startTs;
  const intervals = Math.floor(elapsed / grid.intervalMs);
  return grid.startTs + (intervals + 1) * grid.intervalMs;
}

/**
 * Round all float properties in an object recursively.
 * Used to ensure deterministic float values in test outputs.
 */
export function roundFloatsInObject<T>(obj: T, precision: number = DEFAULT_PRECISION): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "number") {
    return roundFloat(obj, precision) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => roundFloatsInObject(item, precision)) as T;
  }

  if (typeof obj === "object") {
    const rounded: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      rounded[key] = roundFloatsInObject(value, precision);
    }
    return rounded as T;
  }

  return obj;
}
