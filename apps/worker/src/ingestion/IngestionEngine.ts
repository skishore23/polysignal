import { GammaClient, ClobRestClient, ClobWsClient, type TopMarket } from "@polysignal/data";
import { BookStore } from "@polysignal/book";
import { sleep } from "@polysignal/utils";
import type { Logger } from "../logger";
import { TaskScheduler } from "../utils/TaskScheduler";
import type { MarketScope } from "../trading/MarketProfile";
import { classifyMarketProfile, isProfileTradableInScope } from "../trading/MarketProfile";
import { decideMarketProfileScope } from "../trading/DecisionEngine";

interface IngestionConfig {
    clobWsUrl: string;
    universeRefreshSec: number;
    topN: number;
    activeTokenLimit: number;
    activeTokenWindowMinutes: number;
    clobEventsSampleRate: number;
    marketScope?: MarketScope;
}

interface IngestionState {
    marketsTracked: number;
    tokensTracked: number;
    wsConnected: boolean;
    lastUpdate: number | null;
}

interface ExternalDependencies {
    db: any;
    sqlite: any;
    logger: Logger;
    store: BookStore;
    onUniverseUpdated?: (args: { tokenIds: string[]; conditionIds: string[] }) => void;
}

type ParsedEventMeta = {
    eventId: string | null;
    eventSlug: string | null;
    eventTitle: string | null;
    eventStartDate: string | null;
    eventEndDate: string | null;
    negRisk: boolean;
};

type Btc5mWalletRow = {
    id: number;
    name: string;
    marketFilterJson: string | null;
    marketAllowlist: string | null;
};

type WalletMarketFilterDraft = {
    version?: unknown;
    includeMarketIds?: unknown;
    excludeMarketIds?: unknown;
    minVolumeUsd?: unknown;
    maxVolumeUsd?: unknown;
    minLiquidityUsd?: unknown;
    maxLiquidityUsd?: unknown;
    requireActive?: unknown;
    allowedKinds?: unknown;
};

const BTC_5M_WALLET_NAME_PREFIX = "BTC 5m · ";
const BTC_5M_WALLET_NAME_LIKE = `${BTC_5M_WALLET_NAME_PREFIX}%`;
const BTC_5M_ARB_WALLET_NAME_PREFIX = "BTC 5m · Arb ";
const BTC_5M_MARKET_SLUG_PREFIX = "btc-updown-5m-";
const BTC_5M_DEFAULT_MARKET_COUNT = 10;
const BTC_5M_MIN_MARKET_COUNT = 1;
const BTC_5M_MAX_MARKET_COUNT = 50;
const BTC_5M_PAST_MINUTES = 30;
const BTC_5M_FUTURE_MINUTES = 120;

const toFiveMinuteBucket = (epochSeconds: number): number => epochSeconds - (epochSeconds % 300);

const normalizeIdList = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return Array.from(
        new Set(
            value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter((entry) => entry.length > 0)
        )
    );
};

const buildBtc5mSlugCandidates = (nowEpochSeconds: number, pastMinutes: number, futureMinutes: number): string[] => {
    const start = toFiveMinuteBucket(nowEpochSeconds - pastMinutes * 60);
    const end = toFiveMinuteBucket(nowEpochSeconds + futureMinutes * 60);
    const slugs: string[] = [];
    for (let ts = start; ts <= end; ts += 300) {
        slugs.push(`${BTC_5M_MARKET_SLUG_PREFIX}${ts}`);
    }
    return slugs;
};

const parseEventMeta = (market: TopMarket["market"]): ParsedEventMeta => {
    const raw = market as Record<string, unknown>;
    const directEventId =
        typeof raw.eventId === "string"
            ? raw.eventId
            : typeof raw.event_id === "string"
              ? (raw.event_id as string)
              : null;
    const directNegRisk =
        typeof raw.negRisk === "boolean"
            ? raw.negRisk
            : typeof raw.neg_risk === "boolean"
              ? (raw.neg_risk as boolean)
              : false;

    const events = Array.isArray(raw.events) ? (raw.events as Array<Record<string, unknown>>) : [];
    const firstEvent = events[0];
    const eventId = directEventId ?? (typeof firstEvent?.id === "string" ? firstEvent.id : null);
    const eventSlug = typeof firstEvent?.slug === "string" ? firstEvent.slug : null;
    const eventTitle =
        typeof firstEvent?.title === "string"
            ? firstEvent.title
            : typeof firstEvent?.name === "string"
              ? firstEvent.name
              : null;
    const marketEventStartTime = typeof raw.eventStartTime === "string" ? raw.eventStartTime : null;
    const marketEndDate =
        typeof raw.endDate === "string"
            ? raw.endDate
            : typeof raw.end_date === "string"
              ? (raw.end_date as string)
              : null;
    const eventStartDate =
        marketEventStartTime ??
        (typeof firstEvent?.startDate === "string"
            ? firstEvent.startDate
            : typeof firstEvent?.start_date === "string"
              ? firstEvent.start_date
              : null);
    const eventEndDate =
        marketEndDate ??
        (typeof firstEvent?.endDate === "string"
            ? firstEvent.endDate
            : typeof firstEvent?.end_date === "string"
              ? firstEvent.end_date
              : null);
    const eventNegRisk =
        typeof firstEvent?.negRisk === "boolean"
            ? firstEvent.negRisk
            : typeof firstEvent?.neg_risk === "boolean"
              ? firstEvent.neg_risk
              : directNegRisk;
    return {
        eventId,
        eventSlug,
        eventTitle,
        eventStartDate,
        eventEndDate,
        negRisk: Boolean(eventNegRisk)
    };
};

export class IngestionEngine {
    public readonly state: IngestionState = {
        marketsTracked: 0,
        tokensTracked: 0,
        wsConnected: false,
        lastUpdate: null
    };

    private readonly config: IngestionConfig;
    private readonly deps: ExternalDependencies;

    private gamma: GammaClient;
    private rest: ClobRestClient;
    private clobWs: ClobWsClient | null = null;
    private clobWsConnected = false;
    private wsEventSeq = 0;

    private tokenIds: string[] = [];
    private marketIds: string[] = [];
    private conditionIds: string[] = []; // CTF condition IDs
    private tokenToMarket = new Map<string, string>();
    private tokenToCondition = new Map<string, string>(); // token -> conditionId
    private conditionToTokens = new Map<string, string[]>(); // conditionId -> tokens
    private marketToTokens = new Map<string, string[]>();
    private readyTokens = new Set<string>();
    private noOrderbookTokens = new Set<string>();
    private tokenLastSeenTs = new Map<string, number>();
    private snapshotInProgress = false;
    private universeScheduler: TaskScheduler;

    public readonly tokenLastEventSeq = new Map<string, number>();
    private readonly connectionId = `conn_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    public getTrackedTokenIds(): string[] {
        return [...this.tokenIds];
    }

    public getTrackedConditionIds(): string[] {
        return [...this.conditionIds];
    }

    public getReadyTokenCount(): number {
        return this.readyTokens.size;
    }

    public isSnapshotInProgress(): boolean {
        return this.snapshotInProgress;
    }

    private getPinnedMarketIdsFromWallets(): string[] {
        try {
            const rows = this.deps.sqlite
                .prepare(
                    `SELECT market_filter_json as marketFilterJson
                 FROM wallets`
                )
                .all() as Array<{ marketFilterJson?: string | null }>;

            const ids = new Set<string>();
            for (const row of rows) {
                const filterRaw = row.marketFilterJson;
                if (!filterRaw) continue;
                try {
                    const parsed = JSON.parse(filterRaw) as { includeMarketIds?: unknown };
                    if (!Array.isArray(parsed.includeMarketIds)) continue;
                    for (const value of parsed.includeMarketIds) {
                        const id = typeof value === "string" ? value.trim() : "";
                        if (id.length > 0) ids.add(id);
                    }
                } catch {
                    // Ignore malformed wallet filter JSON and continue.
                }
            }

            return Array.from(ids);
        } catch {
            return [];
        }
    }

    private loadBtc5mWalletRows(): Btc5mWalletRow[] {
        try {
            return this.deps.sqlite
                .prepare(
                    `SELECT
                    id,
                    name,
                    market_filter_json as marketFilterJson,
                    market_allowlist as marketAllowlist
                 FROM wallets
                 WHERE name LIKE ?
                   AND name NOT LIKE ?
                 ORDER BY id ASC`
                )
                .all(BTC_5M_WALLET_NAME_LIKE, `${BTC_5M_ARB_WALLET_NAME_PREFIX}%`) as Btc5mWalletRow[];
        } catch {
            return [];
        }
    }

    private getBtc5mTargetCount(walletRows: Btc5mWalletRow[]): number {
        let maxCount = BTC_5M_DEFAULT_MARKET_COUNT;
        for (const row of walletRows) {
            if (!row.marketFilterJson) continue;
            try {
                const parsed = JSON.parse(row.marketFilterJson) as WalletMarketFilterDraft;
                const ids = normalizeIdList(parsed.includeMarketIds);
                if (ids.length > maxCount) maxCount = ids.length;
            } catch {
                // Ignore malformed filter JSON and keep default count.
            }
        }
        return Math.max(BTC_5M_MIN_MARKET_COUNT, Math.min(BTC_5M_MAX_MARKET_COUNT, maxCount));
    }

    private inferAllowedKindsForBtc5mWallet(walletName: string): string[] {
        const lower = walletName.toLowerCase();
        if (lower.includes("maker")) return ["MAKER_BID", "MAKER_ASK"];
        return ["TAKER_BUY", "TAKER_SELL"];
    }

    private isLiveBtc5mMarket(market: TopMarket["market"], nowMs: number): boolean {
        if (!market.id || !market.slug) return false;
        if (!market.slug.startsWith(BTC_5M_MARKET_SLUG_PREFIX)) return false;
        if (!market.active || market.closed) return false;

        const raw = market as Record<string, unknown>;
        const acceptingOrders = raw.acceptingOrders ?? raw.accepting_orders;
        if (acceptingOrders === false) return false;

        const endDate =
            typeof raw.endDate === "string" ? raw.endDate : typeof raw.end_date === "string" ? raw.end_date : null;
        if (endDate && endDate.trim().length > 0) {
            const endMs = Date.parse(endDate);
            if (Number.isFinite(endMs) && endMs < nowMs - 60_000) return false;
        }
        return true;
    }

    private rankBtc5mMarketEndMs(market: TopMarket["market"]): number {
        const raw = market as Record<string, unknown>;
        const endDate =
            typeof raw.endDate === "string" ? raw.endDate : typeof raw.end_date === "string" ? raw.end_date : null;
        if (endDate && endDate.trim().length > 0) {
            const parsed = Date.parse(endDate);
            if (Number.isFinite(parsed)) return parsed;
        }

        const slug = market.slug ?? "";
        const tail = slug.split("-").pop();
        const startSec = tail ? Number(tail) : Number.NaN;
        if (Number.isFinite(startSec)) {
            return startSec * 1000 + 5 * 60 * 1000;
        }
        return Number.POSITIVE_INFINITY;
    }

    private async fetchActiveBtc5mMarketIds(targetCount: number): Promise<string[]> {
        const nowSec = Math.floor(Date.now() / 1000);
        const nowMs = Date.now();
        const slugCandidates = buildBtc5mSlugCandidates(nowSec, BTC_5M_PAST_MINUTES, BTC_5M_FUTURE_MINUTES);
        const foundMarkets: TopMarket["market"][] = [];

        await this.mapWithConcurrency(slugCandidates, 6, async (slug) => {
            const markets = await this.gamma.getMarketsBySlug(slug);
            for (const market of markets) {
                if (!this.isLiveBtc5mMarket(market, nowMs)) continue;
                foundMarkets.push(market);
            }
        });

        const uniqueById = new Map<string, TopMarket["market"]>();
        for (const market of foundMarkets) {
            uniqueById.set(market.id, market);
        }

        return Array.from(uniqueById.values())
            .sort((a, b) => this.rankBtc5mMarketEndMs(a) - this.rankBtc5mMarketEndMs(b))
            .slice(0, targetCount)
            .map((market) => market.id);
    }

    private async maybeAutoRefreshBtc5mWalletPins(): Promise<void> {
        const walletRows = this.loadBtc5mWalletRows();
        if (walletRows.length === 0) return;

        const targetCount = this.getBtc5mTargetCount(walletRows);
        const marketIds = await this.fetchActiveBtc5mMarketIds(targetCount);
        if (marketIds.length === 0) {
            this.deps.logger.warn(
                {
                    walletCount: walletRows.length,
                    targetCount
                },
                "BTC 5m wallet pin refresh skipped: no active BTC 5m markets resolved"
            );
            return;
        }

        const marketAllowlist = marketIds.join(",");
        const updateRows: Array<{ id: number; marketFilterJson: string; marketAllowlist: string }> = [];

        for (const wallet of walletRows) {
            let parsed: WalletMarketFilterDraft = {};
            if (wallet.marketFilterJson) {
                try {
                    const candidate = JSON.parse(wallet.marketFilterJson) as unknown;
                    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
                        parsed = candidate as WalletMarketFilterDraft;
                    }
                } catch {
                    // Reset malformed payload to a sane BTC 5m filter.
                    parsed = {};
                }
            }

            const allowedKinds =
                Array.isArray(parsed.allowedKinds) && parsed.allowedKinds.length > 0
                    ? parsed.allowedKinds
                    : this.inferAllowedKindsForBtc5mWallet(wallet.name);
            const requireActive = typeof parsed.requireActive === "boolean" ? parsed.requireActive : true;
            const nextFilter = {
                ...parsed,
                version: 1,
                includeMarketIds: marketIds,
                requireActive,
                allowedKinds
            };
            const nextFilterJson = JSON.stringify(nextFilter);
            if (nextFilterJson === wallet.marketFilterJson && marketAllowlist === (wallet.marketAllowlist ?? "")) {
                continue;
            }

            updateRows.push({
                id: wallet.id,
                marketFilterJson: nextFilterJson,
                marketAllowlist
            });
        }

        if (updateRows.length === 0) return;

        const updateStmt = this.deps.sqlite.prepare(
            `UPDATE wallets
             SET market_filter_json = @marketFilterJson,
                 market_allowlist = @marketAllowlist
             WHERE id = @id`
        );
        const tx = this.deps.sqlite.transaction(
            (rows: Array<{ id: number; marketFilterJson: string; marketAllowlist: string }>) => {
                for (const row of rows) {
                    updateStmt.run(row);
                }
            }
        );
        tx(updateRows);

        this.deps.logger.info(
            {
                walletCount: walletRows.length,
                updatedWallets: updateRows.length,
                marketCount: marketIds.length,
                marketIds: marketIds.slice(0, 8)
            },
            "Refreshed BTC 5m wallet market pins"
        );
    }

    private insertClobEventStmt: any;
    private upsertMarketStmt: any;
    private upsertEventStmt: any;
    private upsertEventMarketStmt: any;
    private upsertTokenStmt: any;
    private activeTokensStmt: any;

    constructor(config: IngestionConfig, deps: ExternalDependencies) {
        this.config = {
            ...config,
            marketScope: config.marketScope ?? "PROFILE_KNOWN_ONLY"
        };
        this.deps = deps;
        this.gamma = new GammaClient();
        this.rest = new ClobRestClient();

        this.insertClobEventStmt = this.deps.sqlite.prepare(
            "INSERT INTO clob_events (recv_ts_ms, conn_id, token_id, msg_type, payload_json) VALUES (@recvTsMs, @connId, @tokenId, @msgType, @payloadJson)"
        );

        this.upsertMarketStmt = this.deps.sqlite.prepare(`
            INSERT INTO markets (
                id,
                condition_id,
                event_id,
                neg_risk,
                slug,
                question,
                active,
                volume,
                liquidity,
                rewards_min_size,
                rewards_max_spread,
                rewards_rates_json,
                rewards_updated_at,
                maker_base_fee,
                taker_base_fee,
                minimum_order_size,
                minimum_tick_size,
                updated_at,
                created_at
            )
            VALUES (
                @id,
                @conditionId,
                @eventId,
                @negRisk,
                @slug,
                @question,
                @active,
                @volume,
                @liquidity,
                @rewardsMinSize,
                @rewardsMaxSpread,
                @rewardsRatesJson,
                @rewardsUpdatedAt,
                @makerBaseFee,
                @takerBaseFee,
                @minimumOrderSize,
                @minimumTickSize,
                @updatedAt,
                @createdAt
            )
            ON CONFLICT(id) DO UPDATE SET
                condition_id = COALESCE(excluded.condition_id, markets.condition_id),
                event_id = COALESCE(excluded.event_id, markets.event_id),
                neg_risk = COALESCE(excluded.neg_risk, markets.neg_risk),
                slug = excluded.slug,
                question = excluded.question,
                active = excluded.active,
                volume = excluded.volume,
                liquidity = excluded.liquidity,
                rewards_min_size = COALESCE(excluded.rewards_min_size, markets.rewards_min_size),
                rewards_max_spread = COALESCE(excluded.rewards_max_spread, markets.rewards_max_spread),
                rewards_rates_json = COALESCE(excluded.rewards_rates_json, markets.rewards_rates_json),
                rewards_updated_at = COALESCE(excluded.rewards_updated_at, markets.rewards_updated_at),
                maker_base_fee = COALESCE(excluded.maker_base_fee, markets.maker_base_fee),
                taker_base_fee = COALESCE(excluded.taker_base_fee, markets.taker_base_fee),
                minimum_order_size = COALESCE(excluded.minimum_order_size, markets.minimum_order_size),
                minimum_tick_size = COALESCE(excluded.minimum_tick_size, markets.minimum_tick_size),
                updated_at = excluded.updated_at
        `);

        this.upsertTokenStmt = this.deps.sqlite.prepare(`
            INSERT INTO tokens (id, market_id, outcome, name, fee_rate_bps, fee_rate_updated_at, updated_at)
            VALUES (@id, @marketId, @outcome, @name, @feeRateBps, @feeRateUpdatedAt, @updatedAt)
            ON CONFLICT(id) DO UPDATE SET
                market_id = excluded.market_id,
                outcome = excluded.outcome,
                name = excluded.name,
                fee_rate_bps = COALESCE(excluded.fee_rate_bps, tokens.fee_rate_bps),
                fee_rate_updated_at = COALESCE(excluded.fee_rate_updated_at, tokens.fee_rate_updated_at),
                updated_at = excluded.updated_at
        `);

        this.upsertEventStmt = this.deps.sqlite.prepare(`
            INSERT INTO market_events (id, slug, title, neg_risk, updated_at, created_at)
            VALUES (@id, @slug, @title, @negRisk, @updatedAt, @createdAt)
            ON CONFLICT(id) DO UPDATE SET
                slug = COALESCE(excluded.slug, market_events.slug),
                title = COALESCE(excluded.title, market_events.title),
                neg_risk = excluded.neg_risk,
                updated_at = excluded.updated_at
        `);

        this.upsertEventMarketStmt = this.deps.sqlite.prepare(`
            INSERT OR IGNORE INTO event_markets (event_id, market_id, created_at)
            VALUES (@eventId, @marketId, @createdAt)
        `);

        this.activeTokensStmt = this.deps.sqlite.prepare(`
            SELECT token_id as tokenId, COUNT(*) as events
            FROM clob_events
            WHERE recv_ts_ms > @minTs
              AND msg_type != 'trade'
            GROUP BY token_id
            ORDER BY events DESC
            LIMIT @limit
        `);

        this.universeScheduler = new TaskScheduler(
            async () => {
                await this.refreshUniverse();
            },
            {
                name: "UniverseRefresh",
                intervalMs: this.config.universeRefreshSec * 1000,
                logger: this.deps.logger
            }
        );
    }

    public async start(): Promise<void> {
        this.deps.logger.info("Starting IngestionEngine with CLOB market channel...");
        await this.refreshUniverseOnStartup();
        this.universeScheduler.start();
        this.startClobWs();
        void this.primeSnapshots();
    }

    public async stop(): Promise<void> {
        this.universeScheduler.stop();
        this.clobWs?.close();
        this.state.wsConnected = false;
    }

    /**
     * Trigger a REST snapshot refresh when market data becomes stale.
     */
    public triggerRefresh(): void {
        if (this.snapshotInProgress) return;
        this.deps.logger.info("Triggering REST snapshot refresh due to stale data");
        void this.primeSnapshots();
    }

    private persistUniverse(
        markets: TopMarket[],
        marketMeta: Map<
            string,
            {
                rewardsMinSize: number | null;
                rewardsMaxSpread: number | null;
                rewardsRatesJson: string | null;
                rewardsUpdatedAt: number;
                makerBaseFee: number | null;
                takerBaseFee: number | null;
                minimumOrderSize: number | null;
                minimumTickSize: number | null;
            }
        >,
        feeRates: Map<string, number>
    ): void {
        const now = Date.now();
        let marketsUpserted = 0;
        let tokensUpserted = 0;

        for (const m of markets) {
            const meta = marketMeta.get(m.market.id);
            const eventMeta = parseEventMeta(m.market);
            this.upsertMarketStmt.run({
                id: m.market.id,
                conditionId: m.conditionId ?? null,
                eventId: eventMeta.eventId,
                negRisk: eventMeta.negRisk ? 1 : 0,
                slug: m.market.slug ?? null,
                question: m.market.question ?? null,
                active: m.market.active ? 1 : 0,
                volume: m.market.volume ?? null,
                liquidity: m.market.liquidity ?? null,
                rewardsMinSize: meta?.rewardsMinSize ?? null,
                rewardsMaxSpread: meta?.rewardsMaxSpread ?? null,
                rewardsRatesJson: meta?.rewardsRatesJson ?? null,
                rewardsUpdatedAt: meta?.rewardsUpdatedAt ?? null,
                makerBaseFee: meta?.makerBaseFee ?? null,
                takerBaseFee: meta?.takerBaseFee ?? null,
                minimumOrderSize: meta?.minimumOrderSize ?? null,
                minimumTickSize: meta?.minimumTickSize ?? null,
                updatedAt: now,
                createdAt: now
            });
            marketsUpserted++;

            if (eventMeta.eventId) {
                this.upsertEventStmt.run({
                    id: eventMeta.eventId,
                    slug: eventMeta.eventSlug,
                    title: eventMeta.eventTitle,
                    negRisk: eventMeta.negRisk ? 1 : 0,
                    updatedAt: now,
                    createdAt: now
                });
                this.upsertEventMarketStmt.run({
                    eventId: eventMeta.eventId,
                    marketId: m.market.id,
                    createdAt: now
                });
            }

            for (let i = 0; i < m.tokenIds.length; i++) {
                const tokenId = m.tokenIds[i];
                if (!tokenId) continue;
                const outcome = i === 0 ? "Yes" : "No";
                const feeRateBps = feeRates.get(tokenId) ?? null;
                this.upsertTokenStmt.run({
                    id: tokenId,
                    marketId: m.market.id,
                    outcome,
                    name: outcome,
                    feeRateBps,
                    feeRateUpdatedAt: feeRateBps != null ? now : null,
                    updatedAt: now
                });
                tokensUpserted++;
            }
        }

        this.deps.logger.info({ marketsUpserted, tokensUpserted }, "Universe persisted to database");
    }

    private async refreshUniverseOnStartup(): Promise<void> {
        const attemptsRaw = Number(process.env.UNIVERSE_STARTUP_ATTEMPTS ?? 5);
        const attempts = Number.isFinite(attemptsRaw) ? Math.max(1, Math.floor(attemptsRaw)) : 5;
        let backoffMs = 500;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const ok = await this.refreshUniverse();
            if (ok && this.tokenIds.length > 0) return;
            if (this.tokenIds.length > 0) return;
            if (attempt >= attempts) break;
            this.deps.logger.warn(
                { attempt, attempts, backoffMs },
                "Universe empty after refresh; retrying startup universe load"
            );
            await sleep(backoffMs);
            backoffMs = Math.min(backoffMs * 2, 5000);
        }

        this.deps.logger.warn(
            {
                attempts,
                tokensTracked: this.tokenIds.length,
                conditionsTracked: this.conditionIds.length
            },
            "Startup universe load exhausted retries"
        );
        this.deps.logger.warn("Continuing startup with empty scoped universe (zero-trade fail-closed mode)");
    }

    private async refreshUniverse(): Promise<boolean> {
        const filterMarketId = process.env.FILTER_MARKET_ID;

        try {
            await this.maybeAutoRefreshBtc5mWalletPins();

            const top = await this.gamma.getTopMarkets({
                limit: this.config.topN,
                logger: this.deps.logger
            });
            const pinnedMarketIds = this.getPinnedMarketIdsFromWallets();
            const pinnedMarketIdSet = new Set(pinnedMarketIds);
            if (pinnedMarketIds.length > 0) {
                const existingMarketIds = new Set(top.map((m) => m.market.id));
                const missingPinnedIds = pinnedMarketIds.filter((id) => !existingMarketIds.has(id));
                if (missingPinnedIds.length > 0) {
                    const pinned = await this.gamma.getMarketsByIds(missingPinnedIds, this.deps.logger);
                    for (const market of pinned) {
                        top.push(market);
                    }
                    this.deps.logger.info(
                        {
                            pinnedRequested: missingPinnedIds.length,
                            pinnedAdded: pinned.length
                        },
                        "Universe augmented with wallet-pinned markets"
                    );
                }
            }

            const feeRates = new Map<string, number>();
            const marketScope = this.config.marketScope ?? "PROFILE_KNOWN_ONLY";
            const eventMetaByMarketId = new Map<string, ParsedEventMeta>();
            for (const m of top) {
                eventMetaByMarketId.set(m.market.id, parseEventMeta(m.market));
            }

            const tokenIds = new Set<string>();
            for (const m of top) {
                const eventMeta = eventMetaByMarketId.get(m.market.id);
                const textProfile = classifyMarketProfile({
                    question: m.market.question,
                    slug: m.market.slug,
                    eventTitle: eventMeta?.eventTitle ?? null,
                    category: m.market.category ?? null,
                    tags: (m.market as Record<string, unknown>).tags ?? null,
                    eventStartDate: eventMeta?.eventStartDate ?? null,
                    eventEndDate: eventMeta?.eventEndDate ?? null,
                    feeRateBps: 1
                });
                if (!isProfileTradableInScope(textProfile, marketScope)) {
                    continue;
                }
                for (const tokenId of m.tokenIds) {
                    tokenIds.add(tokenId);
                }
            }

            const tokenIdList = Array.from(tokenIds);
            if (tokenIdList.length > 0) {
                await this.mapWithConcurrency(tokenIdList, 6, async (tokenId) => {
                    const feeRateBps = await this.rest.getFeeRateBps(tokenId);
                    if (feeRateBps != null) {
                        feeRates.set(tokenId, feeRateBps);
                    }
                });
            }

            const scopedTop: TopMarket[] = [];
            let skippedByScope = 0;
            let skippedUnknown = 0;
            const skipReasons = new Map<string, number>();
            for (const m of top) {
                const tokenFeeRateBps =
                    m.tokenIds.map((tokenId) => feeRates.get(tokenId) ?? null).find((v) => v != null) ?? null;
                const eventMeta = eventMetaByMarketId.get(m.market.id) ?? parseEventMeta(m.market);
                const profile = classifyMarketProfile({
                    question: m.market.question,
                    slug: m.market.slug,
                    eventTitle: eventMeta.eventTitle,
                    category: m.market.category ?? null,
                    tags: (m.market as Record<string, unknown>).tags ?? null,
                    eventStartDate: eventMeta.eventStartDate,
                    eventEndDate: eventMeta.eventEndDate,
                    feeRateBps: tokenFeeRateBps
                });
                if (!isProfileTradableInScope(profile, marketScope)) {
                    const reason = decideMarketProfileScope(profile, marketScope).reason;
                    skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
                    skippedByScope += 1;
                    if (profile === "UNKNOWN") skippedUnknown += 1;
                    continue;
                }
                scopedTop.push(m);
            }
            if (skippedByScope > 0) {
                this.deps.logger.info(
                    {
                        marketScope: this.config.marketScope,
                        kept: scopedTop.length,
                        skippedByScope,
                        skippedUnknown,
                        skipReasons: Object.fromEntries(skipReasons.entries())
                    },
                    "Universe scope filtering applied"
                );
            }

            const marketMeta = new Map<
                string,
                {
                    rewardsMinSize: number | null;
                    rewardsMaxSpread: number | null;
                    rewardsRatesJson: string | null;
                    rewardsUpdatedAt: number;
                    makerBaseFee: number | null;
                    takerBaseFee: number | null;
                    minimumOrderSize: number | null;
                    minimumTickSize: number | null;
                }
            >();
            const marketsToFetch = scopedTop.filter((m) => m.conditionId != null);
            if (marketsToFetch.length > 0) {
                await this.mapWithConcurrency(marketsToFetch, 6, async (m) => {
                    if (!m.conditionId) return;
                    const market = await this.rest.getMarket(m.conditionId, this.deps.logger);
                    if (!market) return;
                    const rewards = market.rewards ?? null;
                    marketMeta.set(m.market.id, {
                        rewardsMinSize: rewards?.min_size ?? null,
                        rewardsMaxSpread: rewards?.max_spread ?? null,
                        rewardsRatesJson: rewards?.rates != null ? JSON.stringify(rewards.rates) : null,
                        rewardsUpdatedAt: Date.now(),
                        makerBaseFee: market.maker_base_fee ?? null,
                        takerBaseFee: market.taker_base_fee ?? null,
                        minimumOrderSize: market.minimum_order_size ?? null,
                        minimumTickSize: market.minimum_tick_size ?? null
                    });
                });
            }

            let newTokenIds: string[] = [];
            let newMarketIds: string[] = [];
            let newConditionIds: string[] = [];
            let newTokenToMarket = new Map<string, string>();
            let newTokenToCondition = new Map<string, string>();
            let newConditionToTokens = new Map<string, string[]>();
            let newMarketToTokens = new Map<string, string[]>();

            for (const m of scopedTop) {
                if (filterMarketId && m.market.id !== filterMarketId) continue;

                const marketId = m.market.id;
                const conditionId = m.conditionId; // CTF condition ID

                newMarketIds.push(marketId);
                if (conditionId) {
                    newConditionIds.push(conditionId);
                }

                const tokens: string[] = [];

                for (const tid of m.tokenIds) {
                    newTokenIds.push(tid);
                    newTokenToMarket.set(tid, marketId);
                    if (conditionId) {
                        newTokenToCondition.set(tid, conditionId);
                    }
                    tokens.push(tid);
                }
                newMarketToTokens.set(marketId, tokens);
                if (conditionId) {
                    newConditionToTokens.set(conditionId, tokens);
                }
            }

            const pinnedTokenSet = new Set<string>();
            if (pinnedMarketIdSet.size > 0) {
                for (const [marketId, tokens] of newMarketToTokens.entries()) {
                    if (!pinnedMarketIdSet.has(marketId)) continue;
                    for (const tokenId of tokens) {
                        pinnedTokenSet.add(tokenId);
                    }
                }
            }

            const activeTokenSet = this.getActiveTokenSet();
            if (activeTokenSet) {
                if (pinnedTokenSet.size > 0) {
                    for (const tokenId of pinnedTokenSet) {
                        activeTokenSet.add(tokenId);
                    }
                }
                let keptTokens = 0;
                const filteredTokenIds: string[] = [];
                const filteredMarketIds: string[] = [];
                const filteredConditionIds: string[] = [];
                const filteredTokenToMarket = new Map<string, string>();
                const filteredTokenToCondition = new Map<string, string>();
                const filteredConditionToTokens = new Map<string, string[]>();
                const filteredMarketToTokens = new Map<string, string[]>();

                for (const [marketId, tokens] of newMarketToTokens.entries()) {
                    const kept = tokens.filter((tokenId) => activeTokenSet.has(tokenId));
                    if (kept.length === 0) continue;
                    filteredMarketIds.push(marketId);
                    filteredMarketToTokens.set(marketId, kept);
                    for (const tokenId of kept) {
                        filteredTokenIds.push(tokenId);
                        filteredTokenToMarket.set(tokenId, marketId);
                    }
                    keptTokens += kept.length;
                }

                for (const [conditionId, tokens] of newConditionToTokens.entries()) {
                    const kept = tokens.filter((tokenId) => activeTokenSet.has(tokenId));
                    if (kept.length === 0) continue;
                    filteredConditionIds.push(conditionId);
                    filteredConditionToTokens.set(conditionId, kept);
                    for (const tokenId of kept) {
                        filteredTokenToCondition.set(tokenId, conditionId);
                    }
                }

                if (keptTokens > 0) {
                    newTokenIds.length = 0;
                    newMarketIds.length = 0;
                    newConditionIds.length = 0;
                    newTokenIds.push(...filteredTokenIds);
                    newMarketIds.push(...filteredMarketIds);
                    newConditionIds.push(...filteredConditionIds);
                    newTokenToMarket = filteredTokenToMarket;
                    newTokenToCondition = filteredTokenToCondition;
                    newConditionToTokens = filteredConditionToTokens;
                    newMarketToTokens = filteredMarketToTokens;
                    this.deps.logger.info(
                        {
                            keptTokens,
                            activeLimit: this.config.activeTokenLimit,
                            windowMinutes: this.config.activeTokenWindowMinutes,
                            pinnedTokensKept: pinnedTokenSet.size
                        },
                        "Universe filtered to active tokens"
                    );
                } else {
                    this.deps.logger.warn(
                        {
                            activeLimit: this.config.activeTokenLimit,
                            windowMinutes: this.config.activeTokenWindowMinutes
                        },
                        "Active token filter empty; keeping full universe"
                    );
                }
            }

            const prevConditions = JSON.stringify(this.conditionIds.sort());
            const nextConditions = JSON.stringify(newConditionIds.sort());
            const prevTokens = JSON.stringify(this.tokenIds.sort());
            const nextTokens = JSON.stringify(newTokenIds.sort());

            this.tokenIds = newTokenIds;
            this.marketIds = newMarketIds;
            this.conditionIds = newConditionIds;
            this.tokenToMarket = newTokenToMarket;
            this.tokenToCondition = newTokenToCondition;
            this.conditionToTokens = newConditionToTokens;
            this.marketToTokens = newMarketToTokens;
            const universeTokenSet = new Set(newTokenIds);
            for (const tokenId of Array.from(this.noOrderbookTokens)) {
                if (!universeTokenSet.has(tokenId)) {
                    this.noOrderbookTokens.delete(tokenId);
                }
            }

            this.state.marketsTracked = filterMarketId ? (newTokenIds.length > 0 ? 1 : 0) : newMarketIds.length;
            this.state.tokensTracked = this.tokenIds.length;

            // Persist markets and tokens to database
            this.persistUniverse(scopedTop, marketMeta, feeRates);

            if (prevConditions !== nextConditions || prevTokens !== nextTokens) {
                this.deps.logger.info(
                    {
                        markets: this.marketIds.length,
                        tokens: this.tokenIds.length,
                        conditions: this.conditionIds.length,
                        filter: filterMarketId ?? "NONE"
                    },
                    "Universe updated"
                );
                this.deps.onUniverseUpdated?.({
                    tokenIds: this.tokenIds,
                    conditionIds: this.conditionIds
                });

                if (this.clobWs) {
                    this.clobWs.close();
                    this.startClobWs();
                }
            }
            return this.tokenIds.length > 0;
        } catch (err) {
            const rootCause = (() => {
                if (!(err instanceof Error)) return String(err);
                const cause = (err as Error & { cause?: unknown }).cause;
                if (cause instanceof Error) return `${err.message}: ${cause.message}`;
                return err.message;
            })();
            if (this.tokenIds.length > 0) {
                this.deps.logger.warn(
                    {
                        err: rootCause,
                        markets: this.marketIds.length,
                        tokens: this.tokenIds.length,
                        conditions: this.conditionIds.length
                    },
                    "Universe refresh failed; retaining in-memory universe"
                );
                return true;
            }
            this.deps.logger.error({ err: rootCause }, "Failed to refresh universe");
            return false;
        }
    }

    private async mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
        const queue = items.slice();
        const workers = Array.from({ length: Math.max(1, limit) }, async () => {
            while (queue.length > 0) {
                const item = queue.shift();
                if (item === undefined) return;
                try {
                    await fn(item);
                } catch (err) {
                    this.deps.logger.warn({ err: String(err) }, "Concurrent task failed");
                }
            }
        });
        await Promise.all(workers);
    }

    private getActiveTokenSet(): Set<string> | null {
        if (this.config.activeTokenLimit <= 0) return null;
        const windowMs = this.config.activeTokenWindowMinutes * 60 * 1000;
        const minTs = Date.now() - windowMs;
        const activeFromLiveFeed = Array.from(this.tokenLastSeenTs.entries())
            .filter(([, ts]) => ts >= minTs)
            .sort((a, b) => b[1] - a[1])
            .slice(0, this.config.activeTokenLimit)
            .map(([tokenId]) => tokenId);
        if (activeFromLiveFeed.length > 0) {
            return new Set(activeFromLiveFeed);
        }
        const rows = this.activeTokensStmt.all({
            minTs,
            limit: this.config.activeTokenLimit
        }) as Array<{ tokenId: string }>;
        if (!rows.length) return null;
        return new Set(rows.map((r) => r.tokenId));
    }

    private updateWsConnected(): void {
        this.state.wsConnected = this.clobWsConnected;
    }

    private markWsEvent(tokenId: string, recvTsMs: number): void {
        this.state.lastUpdate = recvTsMs;
        this.wsEventSeq += 1;
        this.tokenLastEventSeq.set(tokenId, this.wsEventSeq);
        this.tokenLastSeenTs.set(tokenId, recvTsMs);
    }

    private shouldLogClobEvent(msgType: string): boolean {
        if (msgType === "trade") return true;
        const rate = this.config.clobEventsSampleRate;
        if (rate <= 0) return false;
        if (rate >= 1) return true;
        return Math.random() < rate;
    }

    private startClobWs(): void {
        if (this.tokenIds.length === 0) {
            this.deps.logger.warn("No token IDs available for CLOB WS subscription");
            return;
        }

        this.clobWs?.close();
        this.deps.logger.info(
            { tokenCount: this.tokenIds.length, url: this.config.clobWsUrl },
            "Starting CLOB WebSocket for orderbook updates"
        );

        this.clobWs = new ClobWsClient({
            url: this.config.clobWsUrl,
            assetIds: this.tokenIds,
            handlers: {
                log: this.deps.logger,
                onConnect: () => {
                    this.clobWsConnected = true;
                    this.updateWsConnected();
                    this.deps.logger.info("CLOB WS connected");
                },
                onDisconnect: () => {
                    this.clobWsConnected = false;
                    this.updateWsConnected();
                    this.deps.logger.warn("CLOB WS disconnected");
                },
                onError: (err) => {
                    this.deps.logger.warn({ err: String(err) }, "CLOB WS error");
                },
                onBook: (book) => {
                    this.markWsEvent(book.tokenId, book.recvTsMs);
                    this.deps.store.upsertSnapshot({
                        tokenId: book.tokenId,
                        marketId: this.tokenToMarket.get(book.tokenId) ?? book.marketId ?? null,
                        hash: book.hash ?? null,
                        bids: book.bids,
                        asks: book.asks,
                        recvTsMs: book.recvTsMs
                    });
                    this.readyTokens.add(book.tokenId);
                    this.noOrderbookTokens.delete(book.tokenId);
                },
                onPriceChange: (tokenId, changes, recvTsMs) => {
                    this.markWsEvent(tokenId, recvTsMs);
                    for (const change of changes) {
                        this.deps.store.applyDelta({
                            tokenId,
                            side: change.side === "BUY" ? "bids" : "asks",
                            price: change.price,
                            size: change.size,
                            hash: change.hash ?? null,
                            recvTsMs
                        });
                    }
                },
                onTrade: (trade) => {
                    this.markWsEvent(trade.tokenId, trade.recvTsMs);
                    this.logClobEvent(trade.recvTsMs, trade.tokenId, "trade", {
                        event_type: "trade",
                        token_id: trade.tokenId,
                        market: trade.marketId,
                        price: trade.price,
                        size: trade.size,
                        side: trade.side,
                        timestamp: trade.timestamp ?? trade.recvTsMs
                    });
                }
            }
        });

        this.clobWs.connect();
    }

    private async primeSnapshots(): Promise<void> {
        this.snapshotInProgress = true;
        this.readyTokens.clear();
        const concurrency = 5;
        const snapshotTokenIds = this.tokenIds.filter((tokenId) => !this.noOrderbookTokens.has(tokenId));
        const skippedKnownNoBook = this.tokenIds.length - snapshotTokenIds.length;
        const newlyMissingOrderbooks: string[] = [];
        let idx = 0;

        this.deps.logger.info(
            {
                tokenCount: this.tokenIds.length,
                primingCount: snapshotTokenIds.length,
                skippedKnownNoBook
            },
            "Priming snapshots via REST"
        );

        while (idx < snapshotTokenIds.length) {
            const slice = snapshotTokenIds.slice(idx, idx + concurrency);
            await Promise.all(
                slice.map(async (tokenId) => {
                    try {
                        const recvTsMs = Date.now();
                        // Update lastUpdate during REST priming to prevent stale guard from triggering
                        this.state.lastUpdate = recvTsMs;
                        this.markWsEvent(tokenId, recvTsMs);
                        const book = await this.rest.getBook(tokenId, this.deps.logger);

                        const bids = (book.bids ?? [])
                            .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
                            .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size));
                        const asks = (book.asks ?? [])
                            .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
                            .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size));

                        const globalSeq = this.logClobEvent(recvTsMs, tokenId, "rest_book", {
                            event_type: "rest_book",
                            token_id: tokenId,
                            hash: book.hash,
                            bids: book.bids,
                            asks: book.asks
                        });

                        this.deps.store.upsertSnapshot({
                            tokenId,
                            marketId: this.tokenToMarket.get(tokenId) ?? null,
                            hash: book.hash ?? null,
                            bids,
                            asks,
                            lastEventGlobalSeq: globalSeq,
                            recvTsMs
                        });
                        this.readyTokens.add(tokenId);
                        this.noOrderbookTokens.delete(tokenId);
                    } catch (err) {
                        if (this.isNoOrderbookSnapshotError(err)) {
                            if (!this.noOrderbookTokens.has(tokenId)) {
                                newlyMissingOrderbooks.push(tokenId);
                            }
                            this.noOrderbookTokens.add(tokenId);
                            return;
                        }
                        this.deps.logger.warn({ err: String(err), tokenId }, "REST snapshot failed");
                    }
                })
            );
            idx += concurrency;
        }
        this.snapshotInProgress = false;
        if (newlyMissingOrderbooks.length > 0) {
            this.deps.logger.info(
                {
                    count: newlyMissingOrderbooks.length,
                    sampleTokenIds: newlyMissingOrderbooks.slice(0, 12)
                },
                "Snapshot skipped tokens with no active CLOB orderbook (404)"
            );
        }
        this.deps.logger.info({ readyCount: this.readyTokens.size }, "Snapshot priming complete");
    }

    private isNoOrderbookSnapshotError(err: unknown): boolean {
        const text = String(err).toLowerCase();
        return text.includes("clob /book error: 404") && text.includes("no orderbook exists");
    }

    private logClobEvent(ts: number, tokenId: string, type: string, payload: unknown): number {
        if (!this.shouldLogClobEvent(type)) {
            const cachedSeq = this.tokenLastEventSeq.get(tokenId);
            if (cachedSeq != null) return cachedSeq;
            this.wsEventSeq += 1;
            const seq = this.wsEventSeq;
            this.tokenLastEventSeq.set(tokenId, seq);
            return seq;
        }

        const res = this.insertClobEventStmt.run({
            recvTsMs: ts,
            connId: this.connectionId,
            tokenId,
            msgType: type,
            payloadJson: JSON.stringify(payload)
        });
        const globalSeq = Number(res.lastInsertRowid);
        this.tokenLastEventSeq.set(tokenId, globalSeq);
        return globalSeq;
    }
}
