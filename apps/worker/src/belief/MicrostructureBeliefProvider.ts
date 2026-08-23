import type { PriorEstimate } from "@polysignal/types";
import type { BeliefContext, BeliefProvider } from "./BeliefProvider";

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * Canonical fallback prior: only market microstructure inputs.
 * This is the default when external coverage is missing.
 */
export class MicrostructureBeliefProvider implements BeliefProvider {
  public readonly name = "microstructure";

  public async getPrior(context: BeliefContext): Promise<PriorEstimate | null> {
    const mid = context.midPx;
    if (!Number.isFinite(mid) || (mid as number) <= 0 || (mid as number) >= 1) return null;

    const obi = Number.isFinite(context.obi) ? (context.obi as number) : 0;
    const vol = Number.isFinite(context.vol30m) ? (context.vol30m as number) : 0;
    const imbalance = clamp01((obi + 1) / 2) - 0.5;
    const volPenalty = Math.min(0.15, Math.max(0, vol * 1.5));

    const centered = ((mid as number) - 0.5) * 8 + imbalance * 2.25 - volPenalty;
    const probability = clamp01(sigmoid(centered));

    const spreadPenalty = Number.isFinite(context.spreadPx) ? Math.min(0.3, (context.spreadPx as number) * 3) : 0.2;
    const confidence = clamp01(0.55 + Math.abs(imbalance) * 0.35 - spreadPenalty);

    return {
      tokenId: context.tokenId,
      source: this.name,
      probability,
      confidence,
      observedTs: context.ts,
      metadata: {
        mid,
        obi: context.obi,
        vol30m: context.vol30m
      }
    };
  }
}

