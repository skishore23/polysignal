import type { PriorEstimate } from "@polysignal/types";
import type { BeliefContext, BeliefProvider } from "./BeliefProvider";

type SportsbookConfig = {
  enabled: boolean;
  baseUrl: string | null;
  apiKey: string | null;
  timeoutMs: number;
};

type SportsbookPayload = {
  probability?: number;
  confidence?: number;
  source?: string;
  observedTs?: number;
  metadata?: Record<string, unknown>;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export class SportsbookBeliefProvider implements BeliefProvider {
  public readonly name = "sportsbook";
  private readonly config: SportsbookConfig;

  constructor(config: SportsbookConfig) {
    this.config = config;
  }

  public async getPrior(context: BeliefContext): Promise<PriorEstimate | null> {
    if (!this.config.enabled) return null;
    if (!this.config.baseUrl) return null;

    const url = new URL(this.config.baseUrl);
    url.searchParams.set("token_id", context.tokenId);
    if (context.marketId) url.searchParams.set("market_id", context.marketId);

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.config.timeoutMs);
    try {
      const resp = await fetch(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {})
        },
        signal: abort.signal
      });
      if (!resp.ok) return null;
      const payload = (await resp.json()) as SportsbookPayload;
      if (!Number.isFinite(payload.probability)) return null;
      const probability = clamp01(payload.probability as number);
      const confidence = clamp01(Number.isFinite(payload.confidence) ? (payload.confidence as number) : 0.6);
      return {
        tokenId: context.tokenId,
        source: payload.source ?? this.name,
        probability,
        confidence,
        observedTs: Number.isFinite(payload.observedTs) ? (payload.observedTs as number) : context.ts,
        metadata: payload.metadata
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

