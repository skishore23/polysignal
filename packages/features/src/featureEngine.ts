import type { BookStore } from "@polysignal/book";
import type { FeatureRow } from "@polysignal/types";
import { nowMs } from "@polysignal/utils";
import { TimeSeriesBuffer } from "./ringBuffer";

export type FeatureEngineOptions = {
  topKLevels: number;
  returnWindowSec: number;
  volWindowSec: number;
  sampleIntervalSec: number;
};

type TokenState = {
  midSeries: TimeSeriesBuffer;
  returnSeries: TimeSeriesBuffer;
};

export class FeatureEngine {
  private readonly state = new Map<string, TokenState>();

  constructor(
    private readonly store: BookStore,
    private readonly opts: FeatureEngineOptions,
  ) {}

  private getState(tokenId: string): TokenState {
    const existing = this.state.get(tokenId);
    if (existing) return existing;
    const maxSamples = Math.ceil(this.opts.volWindowSec / this.opts.sampleIntervalSec) + 5;
    const created: TokenState = {
      midSeries: new TimeSeriesBuffer(maxSamples),
      returnSeries: new TimeSeriesBuffer(maxSamples)
    };
    this.state.set(tokenId, created);
    return created;
  }

  compute(tokenId: string, marketId: string | null, now?: number): FeatureRow {
    const book = this.store.getBook(tokenId);
    const tsNow = now ?? nowMs();
    const bestBid = book?.bids[0]?.price ?? null;
    const bestAsk = book?.asks[0]?.price ?? null;
    const bidDepthTop = book
      ? book.bids.slice(0, this.opts.topKLevels).reduce((acc, x) => acc + x.size, 0)
      : null;
    const askDepthTop = book
      ? book.asks.slice(0, this.opts.topKLevels).reduce((acc, x) => acc + x.size, 0)
      : null;
    const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
    const obi =
      bidDepthTop != null && askDepthTop != null && bidDepthTop + askDepthTop > 0
        ? (bidDepthTop - askDepthTop) / (bidDepthTop + askDepthTop)
        : null;

    let microprice: number | null = null;
    if (book && bestBid != null && bestAsk != null) {
      const qb = book.bids[0]?.size ?? 0;
      const qa = book.asks[0]?.size ?? 0;
      const denom = qb + qa;
      if (denom > 0) microprice = (bestAsk * qb + bestBid * qa) / denom;
    }

    const micropriceMinusMid =
      microprice != null && mid != null ? microprice - mid : null;

    const stalenessSec = book ? Math.max(0, (tsNow - book.lastUpdatedMs) / 1000) : null;

    const state = this.getState(tokenId);
    if (mid != null) {
      state.midSeries.push(tsNow, mid);
      const target = tsNow - this.opts.returnWindowSec * 1000;
      const prev = state.midSeries.valueAtOrBefore(target);
      if (prev != null && prev > 0) {
        const ret = (mid - prev) / prev;
        state.returnSeries.push(tsNow, ret);
      }
    }

    const r10s = mid != null
      ? computeReturn(state.midSeries, tsNow, 10)
      : null;
    const r1m = mid != null
      ? computeReturn(state.midSeries, tsNow, 60)
      : null;
    const r5m = mid != null
      ? computeReturn(state.midSeries, tsNow, 300)
      : null;

    const windowMs = this.opts.volWindowSec * 1000;
    // 1m acceleration = change in 1m return (current 1m return minus previous 1m return)
    // Avoids systematic negative bias from comparing 10s returns 60s apart (mean reversion)
    const accel1m = computeAccel1m(state.midSeries, tsNow);
    const returnPoints = state.returnSeries.pointsSince(tsNow - windowMs);
    const skew30m = computeTimeWeightedSkewness(returnPoints, tsNow, windowMs);
    const entropy30m = computeTimeWeightedEntropy(returnPoints, tsNow, windowMs, 12);
    const vol30m = computeStd(state.returnSeries.valuesSince(tsNow - windowMs));

    return {
      ts: tsNow,
      tokenId,
      marketId,
      mid,
      spread,
      obi,
      microprice,
      micropriceMinusMid,
      bidDepthTop,
      askDepthTop,
      r10s,
      r1m,
      r5m,
      accel1m,
      skew30m,
      entropy30m,
      vol30m,
      stalenessSec,
      bestBid,
      bestAsk,
      recvTsMs: null,
      lastEventGlobalSeq: null
    };
  }
}

function computeReturn(series: TimeSeriesBuffer, now: number, windowSec: number): number | null {
  const past = series.valueAtOrBefore(now - windowSec * 1000);
  const latest = series.latest();
  if (!latest || past == null || past === 0) return null;
  return (latest.value - past) / past;
}

function computeDelta(series: TimeSeriesBuffer, now: number, windowSec: number): number | null {
  const past = series.valueAtOrBefore(now - windowSec * 1000);
  const latest = series.latest();
  if (!latest || past == null) return null;
  return latest.value - past;
}

/** Change in 1m return: (r1m now) - (r1m over previous 60s). Positive = momentum accelerating up. */
function computeAccel1m(midSeries: TimeSeriesBuffer, now: number): number | null {
  const midNow = midSeries.latest()?.value ?? null;
  const mid60s = midSeries.valueAtOrBefore(now - 60 * 1000);
  const mid120s = midSeries.valueAtOrBefore(now - 120 * 1000);
  if (midNow == null || mid60s == null || mid120s == null || mid60s <= 0 || mid120s <= 0) return null;
  const r1mNow = (midNow - mid60s) / mid60s;
  const r1mPrev = (mid60s - mid120s) / mid120s;
  return r1mNow - r1mPrev;
}

function computeTimeWeightedSkewness(
  points: { ts: number; value: number }[],
  now: number,
  windowMs: number,
): number | null {
  if (points.length < 4 || windowMs <= 0) return null;
  const windowStart = now - windowMs;
  let sumW = 0;
  let sumWX = 0;
  const weights = points.map((p) => {
    const ratio = (p.ts - windowStart) / windowMs;
    const clamped = Math.max(0, Math.min(1, ratio));
    const w = 0.1 + 0.9 * clamped;
    sumW += w;
    sumWX += w * p.value;
    return w;
  });
  if (sumW === 0) return null;
  const mean = sumWX / sumW;
  let sumVar = 0;
  for (let i = 0; i < points.length; i += 1) {
    const value = points[i]?.value ?? 0;
    const diff = value - mean;
    sumVar += (weights[i] ?? 0) * diff * diff;
  }
  const variance = sumVar / sumW;
  if (variance === 0) return 0;
  const std = Math.sqrt(variance);
  let sumSkew = 0;
  for (let i = 0; i < points.length; i += 1) {
    const diff = (points[i]?.value ?? 0) - mean;
    sumSkew += (weights[i] ?? 0) * (diff / std) ** 3;
  }
  return sumSkew / sumW;
}

function computeTimeWeightedEntropy(
  points: { ts: number; value: number }[],
  now: number,
  windowMs: number,
  bins: number,
): number | null {
  if (points.length < 2 || windowMs <= 0 || bins < 2) return null;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) return 0;

  const windowStart = now - windowMs;
  const counts = new Array(bins).fill(0);
  let sumW = 0;
  for (const p of points) {
    const ratio = (p.ts - windowStart) / windowMs;
    const clamped = Math.max(0, Math.min(1, ratio));
    const w = 0.1 + 0.9 * clamped;
    const idx = Math.min(bins - 1, Math.floor(((p.value - min) / range) * bins));
    counts[idx] += w;
    sumW += w;
  }
  if (sumW === 0) return null;
  let entropy = 0;
  for (const count of counts) {
    if (count <= 0) continue;
    const p = count / sumW;
    entropy -= p * Math.log(p);
  }
  return entropy / Math.log(bins);
}

function computeStd(values: number[]): number | null {
  if (values.length < 3) return null;
  const mean = values.reduce((acc, x) => acc + x, 0) / values.length;
  const variance = values.reduce((acc, x) => acc + (x - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
