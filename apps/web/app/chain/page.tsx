import { EvidenceTimeline } from "../../components/EvidenceTimeline";
import { SignalProvenanceGraph } from "../../components/SignalProvenanceGraph";
import { getDecisionChain, getSystemRejects, getEvidenceStats, getTokenInfo, getTokenEvidenceStats } from "../../lib/evidence";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Tooltip } from "../../components/ui/tooltip";
import { Info, ArrowLeft, TrendingUp, TrendingDown, Activity, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { Badge } from "../../components/ui/badge";

type Props = {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export default async function EvidencePage(props: Props) {
    const searchParams = await props.searchParams;
    const filterId = typeof searchParams.id === "string" ? searchParams.id : null;

    // Server-side data fetch: decision timeline (decision → order → fill → markout) and system rejects (unlinked)
    const events = getDecisionChain(filterId ? 50 : 25, filterId);
    const systemRejects = getSystemRejects(50);
    const stats = getEvidenceStats();
    const tokenInfo = filterId ? getTokenInfo(filterId) : null;
    const tokenStats = filterId ? getTokenEvidenceStats(filterId) : null;

    const StatLabel = ({ label, tooltip }: { label: string; tooltip: string }) => (
        <div className="flex items-center gap-1">
            <span className="text-[9px] text-muted-foreground font-mono uppercase">{label}</span>
            <Tooltip content={tooltip}>
                <Info className="h-3 w-3 text-muted-foreground/60 cursor-help" />
            </Tooltip>
        </div>
    );

    return (
        <div className="p-4 md:p-6 lg:p-10 max-w-8xl space-y-8">
            {/* Page header */}
            <div className="flex flex-col gap-4">
                {filterId && (
                    <Link 
                        href="/chain" 
                        className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors w-fit"
                    >
                        <ArrowLeft className="h-3 w-3" />
                        Back to all evidence
                    </Link>
                )}
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                    <div>
                        {filterId && tokenInfo ? (
                            <>
                                <h1 className="text-xl font-bold tracking-tight font-display text-foreground leading-tight">
                                    {tokenInfo.question ?? "Unknown Market"}
                                </h1>
                                <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                                    Question: can this token&apos;s decision trail be traced to outcome?
                                </p>
                                <div className="flex items-center gap-2 mt-2">
                                    <Badge variant="neutral" className="border-border text-muted-foreground bg-transparent border text-xs">
                                        {tokenInfo.outcome ?? "Unknown Outcome"}
                                    </Badge>
                                    <span className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-widest">
                                        Decision Chain
                                    </span>
                                </div>
                            </>
                        ) : (
                            <>
                                <h1 className="text-2xl font-bold tracking-tight font-display text-foreground">
                                    DECISION CHAIN
                                </h1>
                                <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest mt-1">
                                    Invariant Trail · Decision Provenance · Execution Verification
                                </p>
                                <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                                    Question: where do decisions fail, and which links are missing in the lifecycle?
                                </p>
                            </>
                        )}
                    </div>
                </div>
            </div>

            <div className="flex flex-col lg:flex-row gap-6 items-start">
                <Card className="flex-1 w-full min-w-0 border-border/40 bg-card/10">
                    <CardHeader className="border-b border-border/40">
                        <CardTitle className="text-lg font-bold tracking-tight">
                            {filterId ? "DECISION PIPELINE" : "PROVENANCE GRAPH"}
                        </CardTitle>
                        <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                            {filterId 
                                ? "How decisions are generated for this token"
                                : "Decision pipeline visualization"
                            }
                        </p>
                    </CardHeader>
                    <CardContent className="p-6">
                        <SignalProvenanceGraph />
                    </CardContent>
                </Card>

                <Card className="w-full lg:w-[350px] bg-card/30 border-border/40">
                    <CardHeader className="border-b border-border/40">
                        <CardTitle className="text-lg font-bold tracking-tight">
                            {filterId ? "TOKEN STATS" : "CHAIN STATS"}
                        </CardTitle>
                        <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                            {filterId ? "Decision performance for this token" : "System audit trail summary"}
                        </p>
                    </CardHeader>
                    <CardContent className="p-6 space-y-6">
                        {filterId && tokenStats ? (
                            <>
                                {/* Token-specific stats */}
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="border border-border/40 p-3 bg-card/20">
                                        <div className="flex items-center gap-2 mb-1">
                                            <Activity className="h-3 w-3 text-muted-foreground" />
                                            <StatLabel label="Decisions" tooltip="Total BUY/SELL submit decisions recorded for this token." />
                                        </div>
                                        <div className="text-xl font-bold font-mono text-foreground">{tokenStats.signalCount}</div>
                                        <div className="text-[10px] text-muted-foreground font-mono">
                                            <span className="text-neon-green">{tokenStats.buyCount} BUY</span>
                                            {" · "}
                                            <span className="text-rose-500">{tokenStats.sellCount} SELL</span>
                                        </div>
                                    </div>
                                    <div className="border border-border/40 p-3 bg-card/20">
                                        <div className="flex items-center gap-2 mb-1">
                                            <CheckCircle2 className="h-3 w-3 text-muted-foreground" />
                                            <StatLabel label="Model Conf" tooltip="Heuristic confidence from edge vs buffer, penalized by volatility/entropy." />
                                        </div>
                                        <div className="text-xl font-bold font-mono text-foreground">
                                            {tokenStats.signalCount > 0 ? `${(tokenStats.avgConfidence * 100).toFixed(0)}%` : "—"}
                                        </div>
                                        <div className="text-[10px] text-muted-foreground font-mono">
                                            avg submit confidence proxy
                                        </div>
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-3">
                                    <div className="border border-border/40 p-3 bg-card/20">
                                        <div className="flex items-center gap-2 mb-1">
                                            <TrendingUp className="h-3 w-3 text-muted-foreground" />
                                            <StatLabel label="Avg Delta" tooltip="Average predicted move magnitude for recorded decisions." />
                                        </div>
                                        <div className="text-xl font-bold font-mono text-neon-blue">
                                            {tokenStats.signalCount > 0 ? `${(tokenStats.avgDeltaHat * 100).toFixed(2)}%` : "—"}
                                        </div>
                                        <div className="text-[10px] text-muted-foreground font-mono">
                                            predicted move
                                        </div>
                                    </div>
                                    <div className="border border-border/40 p-3 bg-card/20">
                                        <div className="flex items-center gap-2 mb-1">
                                            <Info className="h-3 w-3 text-muted-foreground" />
                                            <StatLabel label="Trail" tooltip="Count of decision chain entries (evidence records) stored for this token." />
                                        </div>
                                        <div className="text-xl font-bold font-mono text-foreground">{tokenStats.evidenceCount}</div>
                                        <div className="text-[10px] text-muted-foreground font-mono">
                                            records stored
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-3 pt-2 border-t border-border/20">
                                    <div className="flex justify-between items-center text-xs font-mono">
                                        <span className="text-muted-foreground flex items-center gap-1">
                                            <span>First Decision</span>
                                            <Tooltip content="Timestamp of the earliest recorded submit decision for this token.">
                                                <Info className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                                            </Tooltip>
                                        </span>
                                        <span className="text-foreground" suppressHydrationWarning>
                                            {tokenStats.firstSignalTs ? new Date(tokenStats.firstSignalTs).toLocaleString() : "—"}
                                        </span>
                                    </div>
                                    <div className="flex justify-between items-center text-xs font-mono">
                                        <span className="text-muted-foreground flex items-center gap-1">
                                            <span>Latest Decision</span>
                                            <Tooltip content="Timestamp of the most recent recorded submit decision for this token.">
                                                <Info className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                                            </Tooltip>
                                        </span>
                                        <span className="text-neon-blue" suppressHydrationWarning>
                                            {tokenStats.latestSignalTs ? new Date(tokenStats.latestSignalTs).toLocaleString() : "—"}
                                        </span>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <>
                                {/* System-wide stats */}
                                <Card className="bg-primary/5 border-primary/20">
                                    <CardContent className="p-4">
                                        <div className="flex items-start gap-3">
                                            <Info className="h-4 w-4 text-neon-green mt-0.5" />
                                            <div className="space-y-1">
                                                <h4 className="text-sm font-bold text-foreground">Why the Decision Chain Matters?</h4>
                                                <p className="text-xs text-muted-foreground leading-relaxed">
                                            This page shows persisted decision evidence and links it across decision, order, fill,
                                            and markout events where available. Use it to audit causality and inspect skip reasons.
                                                </p>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>

                                <div className="space-y-4">
                                    <div className="flex justify-between items-center text-xs font-mono">
                                        <span className="text-muted-foreground flex items-center gap-1">
                                            <span>Chain Records</span>
                                            <Tooltip content="Total evidence entries stored across all tokens.">
                                                <Info className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                                            </Tooltip>
                                        </span>
                                        <span className="text-foreground">{stats.count.toLocaleString()}</span>
                                    </div>
                                    <div className="flex justify-between items-center text-xs font-mono">
                                        <span className="text-muted-foreground flex items-center gap-1">
                                            <span>Submitted Decisions</span>
                                            <Tooltip content="Total submit decisions generated across all tokens and horizons.">
                                                <Info className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                                            </Tooltip>
                                        </span>
                                        <span className="text-foreground">{stats.signalCount.toLocaleString()}</span>
                                    </div>
                                    <div className="flex justify-between items-center text-xs font-mono">
                                        <span className="text-muted-foreground flex items-center gap-1">
                                            <span>Latest</span>
                                            <Tooltip content="Timestamp of the most recent chain entry.">
                                                <Info className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                                            </Tooltip>
                                        </span>
                                        <span className="text-neon-blue" suppressHydrationWarning>
                                            {stats.latestTs ? new Date(stats.latestTs).toLocaleString() : "—"}
                                        </span>
                                    </div>
                                </div>
                            </>
                        )}
                    </CardContent>
                </Card>
            </div>

            <Card className="border-border/40 bg-card/10">
                <CardHeader className="border-b border-border/40">
                    <CardTitle className="text-lg font-bold tracking-tight">
                        Linked lifecycle
                    </CardTitle>
                    <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                        Decision → order → fill → markout
                    </p>
                </CardHeader>
                <CardContent className="p-6">
                    {events.length > 0 ? (
                        <EvidenceTimeline events={events} />
                    ) : (
                        <div className="text-center py-12 text-muted-foreground font-mono text-xs">
                            <Activity className="h-8 w-8 mb-3 opacity-30" />
                            <p>No chain records found for this token.</p>
                            <p className="text-[10px] mt-1 opacity-60">
                                Chain entries are generated when decisions are recorded.
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card className="border-border/40 bg-card/10">
                <CardHeader className="border-b border-border/40">
                    <CardTitle className="text-lg font-bold tracking-tight">
                        System rejects (unlinked)
                    </CardTitle>
                    <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest mt-1">
                        SKIP reasons by time · not linked to a specific decision group
                    </p>
                </CardHeader>
                <CardContent className="p-6">
                    {systemRejects.length > 0 ? (
                        <EvidenceTimeline events={systemRejects} />
                    ) : (
                        <div className="text-center py-8 text-muted-foreground font-mono text-xs">
                            <p>No system rejects in decision_log.</p>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
