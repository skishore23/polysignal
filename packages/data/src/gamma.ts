import { sleep, type LoggerLike } from "@polysignal/utils";

export type GammaMarket = {
  id: string;
  slug: string | null;
  question: string | null;
  category: string | null;
  active: boolean;
  closed: boolean;
  liquidity: number | null;
  volume: number | null;
  conditionId: string | null;
  eventId?: string | null;
  negRisk?: boolean | null;
  events?: unknown;
  tags?: unknown;
  clobTokenIds: unknown;
};

export type TopMarket = {
  market: GammaMarket;
  conditionId: string | null;
  tokenIds: string[];
};

type GetTopMarketsOptions = {
  limit: number;
  logger?: LoggerLike;
};

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_FETCH_RETRIES = 5;
const DEFAULT_FETCH_BACKOFF_MS = 250;

function isRetriableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isRetriableFetchError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === "object" && err != null && "code" in err
      ? String((err as { code: unknown }).code ?? "")
      : "";
  const msg = `${message} ${code}`.toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("eai_again") ||
    msg.includes("enotfound") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("aborterror") ||
    msg.includes("timeout")
  );
}

export class GammaClient {
  private readonly base = "https://gamma-api.polymarket.com";

  private async fetchMarketsPage(
    url: string,
    logger?: LoggerLike
  ): Promise<GammaMarket[]> {
    let backoffMs = DEFAULT_FETCH_BACKOFF_MS;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= DEFAULT_FETCH_RETRIES; attempt += 1) {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), DEFAULT_FETCH_TIMEOUT_MS);
      try {
        const resp = await fetch(url, {
          headers: { accept: "application/json" },
          signal: abort.signal
        });
        clearTimeout(timeout);

        if (!resp.ok) {
          const text = await resp.text();
          const err = new Error(`Gamma API error: ${resp.status} ${text}`);
          if (!isRetriableHttpStatus(resp.status) || attempt >= DEFAULT_FETCH_RETRIES) {
            throw err;
          }
          lastError = err;
          logger?.warn(
            { attempt, retries: DEFAULT_FETCH_RETRIES, status: resp.status, backoffMs },
            "Gamma page fetch failed; retrying"
          );
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 5_000);
          continue;
        }

        return (await resp.json()) as GammaMarket[];
      } catch (err) {
        clearTimeout(timeout);
        const error = err instanceof Error ? err : new Error(String(err));
        const retriable = isRetriableFetchError(error);
        lastError = error;
        if (!retriable || attempt >= DEFAULT_FETCH_RETRIES) {
          throw error;
        }
        logger?.warn(
          { attempt, retries: DEFAULT_FETCH_RETRIES, err: error.message, backoffMs },
          "Gamma page fetch errored; retrying"
        );
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 5_000);
      }
    }

    throw lastError ?? new Error("Gamma page fetch failed after retries");
  }

  async getTopMarkets(opts: GetTopMarketsOptions): Promise<TopMarket[]> {
    const { limit, logger } = opts;
    const results: TopMarket[] = [];
    let offset = 0;
    const pageSize = 100;

    while (results.length < limit) {
      const url = new URL("/markets", this.base);
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("active", "true");
      url.searchParams.set("closed", "false");
      url.searchParams.set("include_tag", "true");

      const data = await this.fetchMarketsPage(url.toString(), logger);
      if (data.length === 0) break;

      for (const m of data) {
        const tokenIds = this.parseClobTokenIds(m.clobTokenIds);
        if (tokenIds.length === 0) continue;

        results.push({
          market: m,
          conditionId: m.conditionId ?? null,
          tokenIds,
        });

        if (results.length >= limit) break;
      }

      offset += pageSize;
      if (data.length < pageSize) break;
    }

    // Sort by volume (fallback to liquidity)
    results.sort((a, b) => {
      const aVol = a.market.volume ?? 0;
      const bVol = b.market.volume ?? 0;
      if (bVol !== aVol) return bVol - aVol;
      const aLiq = a.market.liquidity ?? 0;
      const bLiq = b.market.liquidity ?? 0;
      return bLiq - aLiq;
    });

    logger?.info(
      { count: results.length, limit },
      "Fetched top markets from Gamma"
    );

    return results.slice(0, limit);
  }

  async getMarketsBySlug(slug: string): Promise<GammaMarket[]> {
    const url = new URL("/markets", this.base);
    url.searchParams.set("slug", slug);
    return this.fetchMarketsPage(url.toString());
  }

  async getMarketsByIds(ids: string[], logger?: LoggerLike): Promise<TopMarket[]> {
    const uniqueIds = Array.from(
      new Set(
        ids
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      )
    );
    if (uniqueIds.length === 0) return [];

    const results: TopMarket[] = [];
    for (const marketId of uniqueIds) {
      const url = new URL("/markets", this.base);
      url.searchParams.set("id", marketId);
      const markets = await this.fetchMarketsPage(url.toString(), logger);
      for (const market of markets) {
        const tokenIds = this.parseClobTokenIds(market.clobTokenIds);
        if (tokenIds.length === 0) continue;
        results.push({
          market,
          conditionId: market.conditionId ?? null,
          tokenIds
        });
      }
    }

    logger?.info(
      { requested: uniqueIds.length, returned: results.length },
      "Fetched pinned markets from Gamma by id"
    );
    return results;
  }

  parseClobTokenIds(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === "string") {
      const s = raw.trim();
      if (!s) return [];
      if (s.startsWith("[")) {
        try {
          const arr = JSON.parse(s);
          if (Array.isArray(arr)) return arr.map(String);
        } catch {
          // fallthrough
        }
      }
      return s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }
    if (raw && typeof raw === "object") {
      const vals = Object.values(raw as Record<string, unknown>);
      const out: string[] = [];
      for (const v of vals) out.push(...this.parseClobTokenIds(v));
      return out;
    }
    return [];
  }
}
