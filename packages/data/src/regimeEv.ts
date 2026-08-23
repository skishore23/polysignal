/**
 * One-step EV from Markov regime: shrunk μ, coverage, and EV(s).
 * Use for soft throttling and UI; does not hallucinate edge on small-n states.
 */

export type MarkoutEntry = {
  count?: number;
  wavgBps?: number;
  avgBps?: number;
  notional?: number;
};

export type StateEntry = {
  label: string;
  count: number;
  markout?: MarkoutEntry | null;
};

export type TransitionEntry = {
  total: number;
  to: Record<string, number>;
};

export type MarkovRegime = {
  states: Record<string, StateEntry>;
  transitions: Record<string, TransitionEntry>;
};

export type EVResult = {
  evBps: number;
  coverage: number;
  massUnknown: number;
  nextMass: number;
};

/**
 * EV(s) = Σ_s' P(s→s') · μ_shrunk(s'), with μ_shrunk(s') = μ(s') · n/(n+k).
 * coverage(s) = probability mass that transitions into known states (markout.count > 0).
 */
export function computeEV1Step(
  markov: MarkovRegime,
  fromState: string,
  opts?: {
    shrinkK?: number;
    use?: "wavgBps" | "avgBps";
  }
): EVResult {
  const shrinkK = opts?.shrinkK ?? 20;
  const use = opts?.use ?? "wavgBps";

  const tr = markov.transitions[fromState];
  if (!tr || tr.total <= 0) {
    return { evBps: 0, coverage: 0, massUnknown: 1, nextMass: 0 };
  }

  let ev = 0;
  let cov = 0;
  let mass = 0;

  for (const [toState, cnt] of Object.entries(tr.to)) {
    const p = cnt / tr.total;
    mass += p;

    const st = markov.states[toState];
    const m = st?.markout ?? null;
    const n = m?.count ?? 0;
    const mu = (m?.[use] ?? 0) as number;

    const known = n > 0;
    const muShrunk = known ? mu * (n / (n + shrinkK)) : 0;

    ev += p * muShrunk;
    if (known) cov += p;
  }

  return {
    evBps: ev,
    coverage: cov,
    massUnknown: Math.max(0, 1 - cov),
    nextMass: mass
  };
}
