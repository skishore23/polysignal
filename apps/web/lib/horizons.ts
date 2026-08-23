import { parseHorizonEnv } from "@polysignal/utils";

const DEFAULT_HORIZONS_SEC = [300, 900, 1800]; // 5m, 15m, 30m (matches current worker)

export function getSignalHorizons(): number[] {
  return parseHorizonEnv(
    process.env.SIGNAL_HORIZONS_SEC ?? process.env.SIGNAL_HORIZONS ?? process.env.NEXT_PUBLIC_SIGNAL_HORIZONS,
    DEFAULT_HORIZONS_SEC,
  );
}

export function formatHorizonLabel(horizonSec: number): string {
  // Format as hours if >= 3600 seconds, otherwise as minutes
  if (horizonSec >= 3600) {
    const hours = Math.round(horizonSec / 3600);
    return `${hours}h`;
  }
  const minutes = Math.round(horizonSec / 60);
  return `${minutes}m`;
}
