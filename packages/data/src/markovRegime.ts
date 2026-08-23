export type QuantileEdges = number[];

export const computeQuantileEdges = (values: number[], bins: number): QuantileEdges => {
  if (bins <= 1) return [];
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return [];

  const edges: number[] = [];
  const last = sorted[sorted.length - 1];
  if (last == null) return edges;
  for (let i = 1; i < bins; i += 1) {
    const idx = Math.floor(((sorted.length - 1) * i) / bins);
    const v = sorted[idx];
    edges.push(v != null ? v : last);
  }
  return edges;
};

export const binValue = (value: number, edges: QuantileEdges): number => {
  let idx = 0;
  while (idx < edges.length) {
    const e = edges[idx];
    if (e == null || value <= e) break;
    idx += 1;
  }
  return idx;
};

export const encodeState = (bins: number[], base: number): number =>
  bins.reduce((acc, b) => acc * base + b, 0);

export const decodeState = (state: number, base: number, size: number): number[] => {
  const out = new Array<number>(size).fill(0);
  let rem = state;
  for (let i = size - 1; i >= 0; i -= 1) {
    out[i] = rem % base;
    rem = Math.floor(rem / base);
  }
  return out;
};

export type StatePoint = { ts: number; state: number };

export const lookupStateAt = (timeline: StatePoint[], ts: number): number | null => {
  if (timeline.length === 0) return null;
  const first = timeline[0];
  const last = timeline[timeline.length - 1];
  if (first == null || last == null) return null;
  let lo = 0;
  let hi = timeline.length - 1;
  if (ts < first.ts) return null;
  if (ts >= last.ts) return last.state;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const cur = timeline[mid];
    if (!cur) break;
    if (cur.ts === ts) return cur.state;
    if (cur.ts < ts) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const atHi = timeline[Math.max(0, hi)];
  return atHi != null ? atHi.state : null;
};

export const buildTransitionCounts = (sequence: number[]): Map<number, Map<number, number>> => {
  const transitions = new Map<number, Map<number, number>>();
  for (let i = 1; i < sequence.length; i += 1) {
    const from = sequence[i - 1];
    const to = sequence[i];
    if (from == null || to == null) continue;
    const row = transitions.get(from) ?? new Map<number, number>();
    row.set(to, (row.get(to) ?? 0) + 1);
    transitions.set(from, row);
  }
  return transitions;
};
