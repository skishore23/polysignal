/**
 * Query Result Cache
 * 
 * In-memory cache for expensive database queries to prevent:
 * - Repeated execution of the same queries
 * - Database lock contention
 * - Slow page loads
 * 
 * This is a simple in-memory cache. For production, consider Redis.
 */

type CacheEntry<T> = {
  data: T;
  timestamp: number;
  ttl: number;
};

class QueryCache {
  private cache = new Map<string, CacheEntry<any>>();
  private readonly defaultTTL = 2000; // 2 seconds default
  private readonly maxSize = 1000; // Max cache entries

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  set<T>(key: string, data: T, ttl: number = this.defaultTTL): void {
    // Evict oldest entries if cache is full
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey != null) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    });
  }

  clear(): void {
    this.cache.clear();
  }

  invalidate(pattern?: string): void {
    if (!pattern) {
      this.clear();
      return;
    }

    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }
}

export const queryCache = new QueryCache();

/**
 * Cache key generators
 */
export const cacheKeys = {
  universe: (limit: number, onlyWithSignals?: boolean) => 
    `universe:${limit}:${onlyWithSignals ?? false}`,
  makerMetrics: (limit: number, walletId?: number | null) => 
    `makerMetrics:${limit}:${walletId ?? 'all'}`,
  makerPnLSnapshot: (limit: number) => `makerPnLSnapshot:${limit}`,
  makerFills: (limit: number) => `makerFills:${limit}`,
  makerQuotes: (limit: number) => `makerQuotes:${limit}`,
  makerWalletSummary: (limit: number) => 
    `makerWalletSummary:${limit}`,
  marketDetail: (tokenId: string) => 
    `marketDetail:${tokenId}`,
};
