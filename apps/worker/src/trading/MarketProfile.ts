export type MarketProfile = "CRYPTO_15M" | "CRYPTO_5M" | "SPORTS" | "UNKNOWN" | "FEE_FREE";
export type MarketScope = "PROFILE_KNOWN_ONLY" | "ALL";

type MarketProfileInput = {
  question?: string | null;
  slug?: string | null;
  eventTitle?: string | null;
  category?: string | null;
  tags?: unknown;
  eventStartDate?: string | number | null;
  eventEndDate?: string | number | null;
  feeRateBps?: number | null;
  takerBaseFee?: number | null;
};

const CRYPTO_PATTERN = /\b(crypto|bitcoin|btc|ethereum|eth|solana|sol|doge|xrp|ada|bnb)\b/i;
const FIFTEEN_MIN_PATTERN = /\b(?:15\s*(?:minute|min|m)|quarter[\s-]*hour)\b/i;
const FIVE_MIN_PATTERN = /\b(?:5\s*(?:minute|min|m)|five[\s-]*minute)\b/i;
const SPORTS_PATTERN = /\b(ncaab|serie\s*a)\b/i;

const normalizeText = (value: string | null | undefined): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const toEpochMs = (value: string | number | null | undefined): number | null => {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const extractTagText = (tags: unknown): string => {
  if (!Array.isArray(tags)) return "";
  return tags
    .map((tag) => {
      if (tag == null) return "";
      if (typeof tag === "string") return tag;
      if (typeof tag === "object") {
        const record = tag as Record<string, unknown>;
        return [record.label, record.slug, record.name].filter((v): v is string => typeof v === "string").join(" ");
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
};

export const classifyMarketProfile = (input: MarketProfileInput): MarketProfile => {
  const tagText = extractTagText(input.tags);
  const haystack = [input.question, input.slug, input.eventTitle]
    .concat([input.category, tagText])
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .join(" ");

  const startMs = toEpochMs(input.eventStartDate);
  const endMs = toEpochMs(input.eventEndDate);
  const durationMin = startMs != null && endMs != null && endMs > startMs ? (endMs - startMs) / 60_000 : null;
  const looksFiveMinute =
    FIVE_MIN_PATTERN.test(haystack) || (durationMin != null && durationMin >= 4 && durationMin <= 6);
  const looksFifteenMinute =
    (FIFTEEN_MIN_PATTERN.test(haystack) || (durationMin != null && durationMin >= 12 && durationMin <= 18)) &&
    !looksFiveMinute;
  const looksCrypto = CRYPTO_PATTERN.test(haystack);
  const looksCrypto5m = looksCrypto && looksFiveMinute;
  const looksCrypto15m = CRYPTO_PATTERN.test(haystack) && looksFifteenMinute;
  // Token fee metadata distinguishes an explicit free schedule from an
  // unavailable schedule. Market-level fields alone cannot price a token.
  if (input.feeRateBps == null || !Number.isFinite(input.feeRateBps) || input.feeRateBps < 0) return "UNKNOWN";
  if (input.feeRateBps === 0) return "FEE_FREE";

  if (looksCrypto15m) {
    return "CRYPTO_15M";
  }
  if (looksCrypto5m) {
    return "CRYPTO_5M";
  }
  if (SPORTS_PATTERN.test(haystack)) {
    return "SPORTS";
  }
  return "UNKNOWN";
};

export const isProfileTradableInScope = (profile: MarketProfile, scope: MarketScope): boolean => {
  if (scope === "ALL") {
    return profile !== "UNKNOWN";
  }
  return profile === "CRYPTO_15M" || profile === "CRYPTO_5M" || profile === "SPORTS";
};

export const isFeeEnabledProfile = (profile: MarketProfile): boolean =>
  profile === "CRYPTO_15M" || profile === "CRYPTO_5M" || profile === "SPORTS" || profile === "UNKNOWN";

export const isShadowOnlyProfile = (profile: MarketProfile): boolean => profile === "CRYPTO_5M";
