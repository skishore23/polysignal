import type { PriorEstimate } from "@polysignal/types";

export type BeliefContext = {
  tokenId: string;
  marketId: string | null;
  midPx: number | null;
  spreadPx: number | null;
  bidDepthTop: number | null;
  askDepthTop: number | null;
  obi: number | null;
  vol30m: number | null;
  ts: number;
};

export interface BeliefProvider {
  readonly name: string;
  getPrior(context: BeliefContext): Promise<PriorEstimate | null>;
}

