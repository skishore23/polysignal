import {
    getEvidenceChain as getDbEvidenceChain,
    getDecisionChain as getDbDecisionChain,
    getSystemRejects as getDbSystemRejects,
    getEvidenceStats as getDbEvidenceStats,
    EvidenceEvent,
    getTokenInfo as getDbTokenInfo,
    TokenInfo,
    getTokenEvidenceStats as getDbTokenEvidenceStats,
    TokenEvidenceStats
} from "./queries";

export type { EvidenceEvent, EvidenceEventType, TokenInfo, TokenEvidenceStats, SystemRejectEvent } from "./queries";

export type EvidenceStats = {
    count: number;
    signalCount: number;
    latestTs: number | null;
};

export function getEvidenceChain(limit = 10, filterId?: string | null): EvidenceEvent[] {
    return getDbEvidenceChain(limit, filterId);
}

export function getDecisionChain(limit = 50, filterId?: string | null): EvidenceEvent[] {
    return getDbDecisionChain(limit, filterId);
}

export function getSystemRejects(limit = 50, since?: number) {
    return getDbSystemRejects(limit, since);
}

export function getEvidenceStats(): EvidenceStats {
    return getDbEvidenceStats();
}

export function getTokenInfo(tokenId: string): TokenInfo | null {
    return getDbTokenInfo(tokenId);
}

export function getTokenEvidenceStats(tokenId: string): TokenEvidenceStats {
    return getDbTokenEvidenceStats(tokenId);
}
