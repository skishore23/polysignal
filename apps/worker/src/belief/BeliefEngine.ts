import type { Logger } from "../logger";
import type { PriorEstimate } from "@polysignal/types";
import type { BeliefContext, BeliefProvider } from "./BeliefProvider";

type BeliefEngineConfig = {
  providerWeights: Record<string, number>;
  minConfidence: number;
};

type BeliefEngineDeps = {
  sqlite: any;
  logger: Logger;
};

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export class BeliefEngine {
  private readonly providers: BeliefProvider[];
  private readonly config: BeliefEngineConfig;
  private readonly deps: BeliefEngineDeps;
  private readonly insertPriorStmt: any;

  constructor(providers: BeliefProvider[], config: BeliefEngineConfig, deps: BeliefEngineDeps) {
    this.providers = providers;
    this.config = config;
    this.deps = deps;
    this.insertPriorStmt = this.deps.sqlite.prepare(
      `INSERT INTO external_priors
       (ts, token_id, source, probability, confidence, metadata_json)
       VALUES (@ts, @tokenId, @source, @probability, @confidence, @metadataJson)`
    );
  }

  public async estimate(context: BeliefContext): Promise<PriorEstimate | null> {
    const priors: PriorEstimate[] = [];
    for (const provider of this.providers) {
      try {
        const prior = await provider.getPrior(context);
        if (!prior) continue;
        if (!Number.isFinite(prior.probability)) continue;
        if (!Number.isFinite(prior.confidence)) continue;
        const normalized: PriorEstimate = {
          ...prior,
          probability: clamp01(prior.probability),
          confidence: clamp01(prior.confidence)
        };
        priors.push(normalized);
        this.persistPrior(normalized);
      } catch (err) {
        this.deps.logger.warn(
          { provider: provider.name, err: err instanceof Error ? err.message : String(err) },
          "Belief provider failed"
        );
      }
    }

    if (!priors.length) return null;
    const aggregate = this.combine(priors);
    if (!aggregate) return null;
    if (aggregate.confidence < this.config.minConfidence) return null;
    return aggregate;
  }

  private combine(priors: PriorEstimate[]): PriorEstimate | null {
    let weightSum = 0;
    let pWeighted = 0;
    let cWeighted = 0;
    const sourceWeights: Record<string, number> = {};
    for (const prior of priors) {
      const providerWeight = this.config.providerWeights[prior.source] ?? 1;
      const weight = Math.max(0, providerWeight * prior.confidence);
      if (weight <= 0) continue;
      weightSum += weight;
      pWeighted += prior.probability * weight;
      cWeighted += prior.confidence * weight;
      sourceWeights[prior.source] = weight;
    }
    if (weightSum <= 0) return null;
    const top = priors.slice().sort((a, b) => b.confidence - a.confidence)[0];
    if (!top) return null;
    return {
      tokenId: top.tokenId,
      source: "blended",
      probability: clamp01(pWeighted / weightSum),
      confidence: clamp01(cWeighted / weightSum),
      observedTs: top.observedTs,
      metadata: {
        sourceWeights
      }
    };
  }

  private persistPrior(prior: PriorEstimate): void {
    try {
      this.insertPriorStmt.run({
        ts: prior.observedTs,
        tokenId: prior.tokenId,
        source: prior.source,
        probability: prior.probability,
        confidence: prior.confidence,
        metadataJson: prior.metadata ? JSON.stringify(prior.metadata) : null
      });
    } catch {
      // table may not exist before migration; ignore to keep worker running
    }
  }
}

