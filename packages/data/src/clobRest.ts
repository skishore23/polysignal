import type { LoggerLike } from "@polysignal/utils";

export type RestLevel = { price: string; size: string };

export type RestBook = {
  market: string;
  asset_id: string;
  timestamp?: string;
  hash?: string;
  bids: RestLevel[];
  asks: RestLevel[];
  min_order_size?: string;
  tick_size?: string;
  neg_risk?: boolean;
};

export type ClobMarketRewards = {
  min_size: number | null;
  max_spread: number | null;
  rates: unknown | null;
};

export type ClobMarket = {
  condition_id: string;
  market_slug?: string | null;
  active?: boolean | null;
  closed?: boolean | null;
  archived?: boolean | null;
  minimum_order_size?: number | null;
  minimum_tick_size?: number | null;
  maker_base_fee?: number | null;
  taker_base_fee?: number | null;
  rewards?: ClobMarketRewards | null;
};

const parseNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizeRewards = (raw: unknown): ClobMarketRewards | null => {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const minSize = parseNumber(obj.min_size ?? obj.minSize ?? null);
  const maxSpread = parseNumber(obj.max_spread ?? obj.maxSpread ?? null);
  const rates = obj.rates ?? null;
  return {
    min_size: minSize,
    max_spread: maxSpread,
    rates
  };
};

const normalizeMarket = (raw: unknown): ClobMarket | null => {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const conditionId = typeof obj.condition_id === "string" ? obj.condition_id : null;
  if (!conditionId) return null;
  return {
    condition_id: conditionId,
    market_slug: typeof obj.market_slug === "string" ? obj.market_slug : null,
    active: typeof obj.active === "boolean" ? obj.active : null,
    closed: typeof obj.closed === "boolean" ? obj.closed : null,
    archived: typeof obj.archived === "boolean" ? obj.archived : null,
    minimum_order_size: parseNumber(obj.minimum_order_size ?? obj.minimumOrderSize ?? null),
    minimum_tick_size: parseNumber(obj.minimum_tick_size ?? obj.minimumTickSize ?? null),
    maker_base_fee: parseNumber(obj.maker_base_fee ?? obj.makerBaseFee ?? null),
    taker_base_fee: parseNumber(obj.taker_base_fee ?? obj.takerBaseFee ?? null),
    rewards: normalizeRewards(obj.rewards)
  };
};

export class ClobRestClient {
  private readonly base = "https://clob.polymarket.com";
  private marketNextAllowedTs = 0;
  private marketBackoffMs = 0;
  private lastMarketBackoffLogTs = 0;

  async getBook(tokenId: string, logger?: LoggerLike): Promise<RestBook> {
    const url = new URL("/book", this.base);
    url.searchParams.set("token_id", tokenId);

    const resp = await fetch(url.toString(), {
      headers: { accept: "application/json" },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`CLOB /book error: ${resp.status} ${text}`);
    }

    const book = (await resp.json()) as RestBook;
    logger?.debug({ tokenId, bids: book.bids?.length ?? 0, asks: book.asks?.length ?? 0 }, "Fetched book");
    return book;
  }

  async getMidpoint(tokenId: string): Promise<number | null> {
    const url = new URL("/midpoint", this.base);
    url.searchParams.set("token_id", tokenId);

    const resp = await fetch(url.toString(), {
      headers: { accept: "application/json" },
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as { mid?: string };
    if (!data.mid) return null;

    const v = Number(data.mid);
    return Number.isFinite(v) ? v : null;
  }

  async getFeeRateBps(tokenId: string): Promise<number | null> {
    const url = new URL("/fee-rate", this.base);
    url.searchParams.set("token_id", tokenId);

    const resp = await fetch(url.toString(), {
      headers: { accept: "application/json" },
    });

    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      fee_rate_bps?: number | string;
      feeRateBps?: number | string;
      base_fee?: number | string;
      baseFee?: number | string;
    };
    const value = parseNumber(
      data.fee_rate_bps ??
      data.feeRateBps ??
      data.base_fee ??
      data.baseFee
    );
    return Number.isFinite(value as number) ? value : null;
  }

  /**
   * Fetch market metadata by condition_id with endpoint fallbacks.
   */
  async getMarket(conditionId: string, logger?: LoggerLike): Promise<ClobMarket | null> {
    const now = Date.now();
    if (now < this.marketNextAllowedTs) {
      if (logger && now - this.lastMarketBackoffLogTs > 60_000) {
        this.lastMarketBackoffLogTs = now;
        logger.warn(
          { conditionId, waitMs: this.marketNextAllowedTs - now },
          "CLOB market metadata backoff active; skipping request"
        );
      }
      return null;
    }

    const paths = [
      `/market/${conditionId}`,
      `/markets/${conditionId}`,
      `/market?condition_id=${encodeURIComponent(conditionId)}`,
      `/markets?condition_id=${encodeURIComponent(conditionId)}`
    ];

    for (const path of paths) {
      const url = new URL(path, this.base);
      try {
        const resp = await fetch(url.toString(), {
          headers: { accept: "application/json" }
        });
        if (!resp.ok) {
          const text = await resp.text();
          if (resp.status === 404 || resp.status === 400) continue;
          if (this.isRateLimited(resp.status, text)) {
            this.recordMarketBackoff(now, logger);
            return null;
          }
          throw new Error(`CLOB market error: ${resp.status} ${text}`);
        }
        const raw = await resp.json();

        const maybeArray = Array.isArray(raw) ? raw : null;
        const maybeData = typeof raw === "object" && raw !== null && "data" in raw
          ? (raw as { data: unknown }).data
          : null;

        const candidate =
          normalizeMarket(raw) ??
          (maybeArray ? normalizeMarket(maybeArray[0]) : null) ??
          (maybeData && Array.isArray(maybeData) ? normalizeMarket(maybeData[0]) : normalizeMarket(maybeData));

        if (candidate) {
          this.resetMarketBackoff();
          return candidate;
        }
      } catch (err) {
        logger?.warn({ conditionId, err: String(err) }, "Failed to fetch market metadata");
      }
    }

    return null;
  }

  private isRateLimited(status: number, body: string): boolean {
    if (status === 429) return true;
    const text = body.toLowerCase();
    return text.includes("error 1015") || text.includes("rate limited") || text.includes("access denied");
  }

  private recordMarketBackoff(now: number, logger?: LoggerLike): void {
    const minMs = 30_000;
    const maxMs = 5 * 60_000;
    this.marketBackoffMs = this.marketBackoffMs > 0
      ? Math.min(maxMs, this.marketBackoffMs * 2)
      : minMs;
    const jitter = Math.floor(this.marketBackoffMs * 0.2 * Math.random());
    this.marketNextAllowedTs = now + this.marketBackoffMs + jitter;
    if (logger && now - this.lastMarketBackoffLogTs > 60_000) {
      this.lastMarketBackoffLogTs = now;
      logger.warn(
        { backoffMs: this.marketBackoffMs, nextAllowedInSec: Math.round((this.marketNextAllowedTs - now) / 1000) },
        "CLOB market metadata rate limited; backing off"
      );
    }
  }

  private resetMarketBackoff(): void {
    this.marketNextAllowedTs = 0;
    this.marketBackoffMs = 0;
  }
}
