"use client";

import * as React from "react";
import { Drawer } from "./Drawer";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface WalletFormState {
    name: string;
    startingBalance: string;
    sizeMultiplier: string;
    maxOpenPositions: string;
    minConfidence: string;
    minEdge: string;
    autoOpenLimit: string;
    autoTradeEnabled: boolean;
    makerEnabled: boolean;
    maxDailyLossUsd: string;
    maxDrawdownPct: string;
    cooldownMinutes: string;
    marketAllowlist: string;
    marketFilterIncludeMarketIds: string;
    marketFilterExcludeMarketIds: string;
    marketFilterMinVolumeUsd: string;
    marketFilterMaxVolumeUsd: string;
    marketFilterMinLiquidityUsd: string;
    marketFilterMaxLiquidityUsd: string;
    marketFilterRequireActive: boolean;
    marketFilterAllowTakerBuy: boolean;
    marketFilterAllowTakerSell: boolean;
    marketFilterAllowMakerBid: boolean;
    marketFilterAllowMakerAsk: boolean;
    // Maker-specific parameters
    makerQuoteSize: string;
    makerQuoteWidthBps: string;
    makerMinSpread: string;
    makerMaxSpread: string;
    makerMinDepth: string;
    makerInventoryMaxAbs: string;
    makerInventorySkewBps: string;
    // Position-level defaults (empty string = use global defaults)
    defaultStopLossPct: string;
    defaultTakeProfitPct: string;
    defaultMaxLossAbs: string;
    defaultMaxHoldSec: string;
}

interface WalletSettingsDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    initialState?: WalletFormState;
    onSave: (data: WalletFormState) => void;
    isCreating?: boolean;
}

const DEFAULT_FORM: WalletFormState = {
    name: "",
    startingBalance: "10000",
    sizeMultiplier: "1",
    maxOpenPositions: "5",
    minConfidence: "0.65",
    minEdge: "0.015",
    autoOpenLimit: "5",
    autoTradeEnabled: true,
    makerEnabled: false,
    maxDailyLossUsd: "",
    maxDrawdownPct: "",
    cooldownMinutes: "",
    marketAllowlist: "",
    marketFilterIncludeMarketIds: "",
    marketFilterExcludeMarketIds: "",
    marketFilterMinVolumeUsd: "",
    marketFilterMaxVolumeUsd: "",
    marketFilterMinLiquidityUsd: "",
    marketFilterMaxLiquidityUsd: "",
    marketFilterRequireActive: false,
    marketFilterAllowTakerBuy: true,
    marketFilterAllowTakerSell: true,
    marketFilterAllowMakerBid: true,
    marketFilterAllowMakerAsk: true,
    makerQuoteSize: "50",
    makerQuoteWidthBps: "20",
    makerMinSpread: "0.002",
    makerMaxSpread: "0.02",
    makerMinDepth: "20",
    makerInventoryMaxAbs: "500",
    makerInventorySkewBps: "15",
    defaultStopLossPct: "",
    defaultTakeProfitPct: "",
    defaultMaxLossAbs: "",
    defaultMaxHoldSec: ""
};

// Slider configuration with friendly descriptions at different levels
type SliderLevel = { label: string; color: string; description: string };

const getConfidenceLevel = (value: number): SliderLevel => {
    if (value >= 0.8) return { label: "Very Picky", color: "text-neon-green", description: "Only the most confident signals. Few trades, high quality." };
    if (value >= 0.7) return { label: "Selective", color: "text-emerald-300", description: "Good confidence required. Moderate trade frequency." };
    if (value >= 0.6) return { label: "Balanced", color: "text-green-400", description: "Reasonable confidence. Good balance of quality and quantity." };
    if (value >= 0.5) return { label: "Opportunistic", color: "text-yellow-400", description: "Lower bar for entry. More trades, some may be weaker." };
    return { label: "Aggressive", color: "text-orange-400", description: "Take most opportunities. High volume, variable quality." };
};

const getEdgeLevel = (value: number): SliderLevel => {
    if (value >= 0.025) return { label: "High Edge Only", color: "text-neon-green", description: "Only trade when expected profit is 2.5%+. Very selective." };
    if (value >= 0.02) return { label: "Good Edge", color: "text-emerald-300", description: "Require 2%+ expected edge. Quality over quantity." };
    if (value >= 0.015) return { label: "Moderate Edge", color: "text-green-400", description: "1.5%+ edge required. Balanced approach." };
    if (value >= 0.01) return { label: "Small Edge OK", color: "text-yellow-400", description: "Accept 1%+ edge. More frequent trading." };
    return { label: "Any Edge", color: "text-orange-400", description: "Take any positive edge. Maximum opportunities." };
};

const getSizeLevel = (value: number): SliderLevel => {
    if (value >= 2.5) return { label: "Large Positions", color: "text-red-400", description: "2.5x size. High risk/reward. Not for beginners." };
    if (value >= 2) return { label: "Aggressive Sizing", color: "text-orange-400", description: "2x position size. Amplified gains and losses." };
    if (value >= 1.5) return { label: "Moderate Plus", color: "text-yellow-400", description: "1.5x size. Slightly larger positions." };
    if (value >= 1) return { label: "Standard", color: "text-green-400", description: "Normal position sizing. Recommended starting point." };
    return { label: "Conservative", color: "text-emerald-300", description: "Smaller positions. Lower risk per trade." };
};

const getMaxPositionsLevel = (value: number): SliderLevel => {
    if (value >= 20) return { label: "Many Positions", color: "text-purple-400", description: "Up to 20+ open. Highly diversified but capital-intensive." };
    if (value >= 12) return { label: "Diversified", color: "text-emerald-300", description: "10-15 positions. Good diversification." };
    if (value >= 8) return { label: "Balanced", color: "text-green-400", description: "5-10 positions. Moderate concentration." };
    if (value >= 4) return { label: "Focused", color: "text-yellow-400", description: "3-5 positions. More concentrated bets." };
    return { label: "Concentrated", color: "text-orange-400", description: "1-3 positions. High conviction plays only." };
};

const getQuoteSizeLevel = (value: number): SliderLevel => {
    if (value >= 100) return { label: "Large Quotes", color: "text-rose-400", description: "$100+ per quote. High PnL potential, high inventory risk." };
    if (value >= 70) return { label: "Above Average", color: "text-amber-400", description: "$70-100 quotes. Good profit scaling." };
    if (value >= 50) return { label: "Standard", color: "text-green-400", description: "$50 quotes. Balanced risk/reward." };
    if (value >= 30) return { label: "Conservative", color: "text-yellow-400", description: "$30-50 quotes. Lower risk, lower reward." };
    return { label: "Small Quotes", color: "text-orange-400", description: "Under $30. Minimal risk, slower profit." };
};

const getSpreadWidthLevel = (value: number): SliderLevel => {
    if (value >= 30) return { label: "Wide Spreads", color: "text-rose-400", description: "30+ bps. High profit per fill, fewer fills." };
    if (value >= 22) return { label: "Above Average", color: "text-amber-400", description: "22-30 bps. Good profit margin." };
    if (value >= 18) return { label: "Balanced", color: "text-green-400", description: "18-22 bps. Standard spread capture." };
    if (value >= 12) return { label: "Tight", color: "text-yellow-400", description: "12-18 bps. More fills, less per fill." };
    return { label: "Very Tight", color: "text-orange-400", description: "Under 12 bps. Maximum fills, thin margins." };
};

const getInventoryLevel = (value: number): SliderLevel => {
    if (value >= 800) return { label: "High Limit", color: "text-rose-400", description: "$800+ max inventory. Large directional exposure risk." };
    if (value >= 600) return { label: "Above Average", color: "text-orange-400", description: "$600-800 limit. Increased capacity." };
    if (value >= 400) return { label: "Standard", color: "text-green-400", description: "$400-600 limit. Balanced risk." };
    if (value >= 250) return { label: "Conservative", color: "text-emerald-300", description: "$250-400 limit. Lower risk exposure." };
    return { label: "Minimal", color: "text-amber-400", description: "Under $250. Very low directional risk." };
};

// Slider component with dynamic feedback
function SmartSlider({ 
    label, 
    value, 
    onChange, 
    min, 
    max, 
    step, 
    getLevelFn,
    unit = "",
    showValue = true
}: { 
    label: string;
    value: number;
    onChange: (v: number) => void;
    min: number;
    max: number;
    step: number;
    getLevelFn: (v: number) => SliderLevel;
    unit?: string;
    showValue?: boolean;
}) {
    const level = getLevelFn(value);

    return (
        <div className="space-y-2 p-3 bg-secondary/20 rounded-none border border-border/30">
            <div className="flex items-center justify-between">
                <Label className="text-xs font-medium text-foreground">{label}</Label>
                <div className="flex items-center gap-2">
                    <span className={`text-xs font-semibold ${level.color}`}>{level.label}</span>
                    {showValue && (
                        <span className="text-xs text-muted-foreground font-mono bg-secondary/50 px-1.5 py-0.5 rounded-none">
                            {value}{unit}
                        </span>
                    )}
                </div>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                className="w-full h-2 bg-secondary rounded-none appearance-none cursor-pointer accent-primary"
            />
            <p className="text-[11px] text-muted-foreground leading-snug">{level.description}</p>
        </div>
    );
}

function SectionHeader({ title, badge, description }: { title: string; badge?: string; description: string }) {
    return (
        <div className="space-y-1 pb-2 border-b border-border/30">
            <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">{title}</span>
                {badge && <span className="text-[10px] px-1.5 py-0.5 rounded-none bg-primary/10 text-primary font-mono">{badge}</span>}
            </div>
            <p className="text-xs text-muted-foreground">{description}</p>
        </div>
    );
}

export function WalletSettingsDrawer({ isOpen, onClose, initialState, onSave, isCreating }: WalletSettingsDrawerProps) {
    const [form, setForm] = React.useState<WalletFormState>(DEFAULT_FORM);
    const [step, setStep] = React.useState<"basics" | "strategy">("basics");

    React.useEffect(() => {
        if (isOpen) {
            const formState = { ...DEFAULT_FORM, ...(initialState ?? {}) };
            const maker = Boolean(formState.makerEnabled);
            const taker = Boolean(formState.autoTradeEnabled);
            const sanitized = !maker && !taker
                ? { ...formState, autoTradeEnabled: true }
                : formState;
            setForm(sanitized);
            setStep("basics");
        }
    }, [isOpen, initialState]);

    const toggleTaker = () => {
        setForm((prev) => ({ ...prev, autoTradeEnabled: !prev.autoTradeEnabled }));
    };

    const toggleMaker = () => {
        setForm((prev) => ({ ...prev, makerEnabled: !prev.makerEnabled }));
    };

    const stepLabel = step === "basics" ? "Step 1 / 2" : "Step 2 / 2";
    const allowlistItems = form.marketAllowlist
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    const allowlistSummary = allowlistItems.length ? `${allowlistItems.length} markets` : "All markets";
    const riskSummary = form.maxDailyLossUsd || form.maxDrawdownPct || form.cooldownMinutes
        ? `${form.maxDailyLossUsd || "—"} / ${form.maxDrawdownPct || "—"}% / ${form.cooldownMinutes || "—"}m`
        : "Global defaults";
    const mode = form.makerEnabled ? "Maker" : form.autoTradeEnabled ? "Taker" : "—";

    return (
        <Drawer isOpen={isOpen} onClose={onClose} title={isCreating ? "Create Wallet" : "Wallet Settings"} className="bg-black/95 backdrop-blur-xl border-t border-border/60 rounded-none">
            <div className="space-y-6">
                <div className="relative overflow-hidden rounded-none border border-border/50 bg-[radial-gradient(120%_120%_at_0%_0%,rgba(34,197,94,0.12),transparent_55%),linear-gradient(135deg,rgba(0,0,0,0.96),rgba(2,4,6,0.94))] p-5">
                    <div className="relative space-y-3">
                        <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-[0.25em] text-muted-foreground">
                            <span>{isCreating ? "Create Wallet" : "Edit Wallet"}</span>
                            <span>{stepLabel}</span>
                        </div>
                        <div>
                            <h2 className="text-2xl font-display font-semibold tracking-tight text-foreground">
                                Wallet Builder
                            </h2>
                            <p className="text-xs text-muted-foreground font-mono mt-1">
                                Enable maker, taker, or both. Tune strategies on the next step.
                            </p>
                        </div>
                        <div className="grid grid-cols-2 gap-2 max-w-sm">
                            <button
                                type="button"
                                onClick={toggleTaker}
                                className={`px-3 py-2 rounded-none text-xs font-mono uppercase tracking-widest border transition-colors ${
                                    form.autoTradeEnabled
                                        ? "bg-neon-green/10 text-neon-green border-neon-green/40"
                                        : "bg-black/30 text-muted-foreground border-border/40 hover:text-foreground"
                                }`}
                            >
                                Taker
                            </button>
                            <button
                                type="button"
                                onClick={toggleMaker}
                                className={`px-3 py-2 rounded-none text-xs font-mono uppercase tracking-widest border transition-colors ${
                                    form.makerEnabled
                                        ? "bg-neon-green/10 text-neon-green border-neon-green/40"
                                        : "bg-black/30 text-muted-foreground border-border/40 hover:text-foreground"
                                }`}
                            >
                                Maker
                            </button>
                        </div>
                    </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-[1.6fr,0.9fr]">
                    <div className="space-y-6">
                        {step === "basics" && (
                            <div className="space-y-6">
                                <SectionHeader
                                    title="Wallet Basics"
                                    description="Name, bankroll, and guardrails."
                                />
                                <div className="grid gap-3 md:grid-cols-2">
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Wallet Name</Label>
                                        <Input
                                            value={form.name}
                                            onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))}
                                            className="bg-secondary/30"
                                            placeholder="Momentum-1"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Starting Balance ($)</Label>
                                        <Input
                                            value={form.startingBalance}
                                            onChange={(e) => setForm(p => ({ ...p, startingBalance: e.target.value }))}
                                            className="bg-secondary/30"
                                            placeholder="10000"
                                        />
                                    </div>
                                </div>

                                <SectionHeader
                                    title="Risk Limits"
                                    description="Optional per-wallet caps. Leave blank for global defaults."
                                />
                                <div className="grid gap-3 md:grid-cols-3">
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Max Daily Loss ($)</Label>
                                        <Input
                                            value={form.maxDailyLossUsd}
                                            onChange={(e) => setForm(p => ({ ...p, maxDailyLossUsd: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="500"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Max Drawdown (%)</Label>
                                        <Input
                                            value={form.maxDrawdownPct}
                                            onChange={(e) => setForm(p => ({ ...p, maxDrawdownPct: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="10"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Cooldown (min)</Label>
                                        <Input
                                            value={form.cooldownMinutes}
                                            onChange={(e) => setForm(p => ({ ...p, cooldownMinutes: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="60"
                                        />
                                    </div>
                                </div>

                                <SectionHeader
                                    title="Market Scope"
                                    description="Comma-separated market IDs. Blank means all markets."
                                />
                                <Input
                                    value={form.marketAllowlist}
                                    onChange={(e) => setForm(p => ({ ...p, marketAllowlist: e.target.value }))}
                                    className="bg-secondary/30 text-xs h-8"
                                    placeholder="market_id_1, market_id_2"
                                />

                                <SectionHeader
                                    title="Advanced Market Filters"
                                    description="Optional structured filters for per-wallet cohorts."
                                />
                                <div className="grid gap-3 md:grid-cols-2">
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Include Market IDs (CSV)</Label>
                                        <Input
                                            value={form.marketFilterIncludeMarketIds}
                                            onChange={(e) => setForm(p => ({ ...p, marketFilterIncludeMarketIds: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="553868, 553838"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Exclude Market IDs (CSV)</Label>
                                        <Input
                                            value={form.marketFilterExcludeMarketIds}
                                            onChange={(e) => setForm(p => ({ ...p, marketFilterExcludeMarketIds: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="553831, 559658"
                                        />
                                    </div>
                                </div>
                                <div className="grid gap-3 md:grid-cols-2">
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Min Volume USD</Label>
                                        <Input
                                            value={form.marketFilterMinVolumeUsd}
                                            onChange={(e) => setForm(p => ({ ...p, marketFilterMinVolumeUsd: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="1000000"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Max Volume USD</Label>
                                        <Input
                                            value={form.marketFilterMaxVolumeUsd}
                                            onChange={(e) => setForm(p => ({ ...p, marketFilterMaxVolumeUsd: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="10000000"
                                        />
                                    </div>
                                </div>
                                <div className="grid gap-3 md:grid-cols-2">
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Min Liquidity USD</Label>
                                        <Input
                                            value={form.marketFilterMinLiquidityUsd}
                                            onChange={(e) => setForm(p => ({ ...p, marketFilterMinLiquidityUsd: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="100000"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Max Liquidity USD</Label>
                                        <Input
                                            value={form.marketFilterMaxLiquidityUsd}
                                            onChange={(e) => setForm(p => ({ ...p, marketFilterMaxLiquidityUsd: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="5000000"
                                        />
                                    </div>
                                </div>
                                <div className="grid gap-3 md:grid-cols-2">
                                    <label className="flex items-center gap-2 text-xs text-muted-foreground border border-border/30 p-2">
                                        <input
                                            type="checkbox"
                                            checked={form.marketFilterRequireActive}
                                            onChange={(e) => setForm(p => ({ ...p, marketFilterRequireActive: e.target.checked }))}
                                        />
                                        Require Active Markets
                                    </label>
                                    <div className="grid grid-cols-2 gap-2">
                                        <label className="flex items-center gap-2 text-[11px] text-muted-foreground border border-border/30 p-2">
                                            <input
                                                type="checkbox"
                                                checked={form.marketFilterAllowTakerBuy}
                                                onChange={(e) => setForm(p => ({ ...p, marketFilterAllowTakerBuy: e.target.checked }))}
                                            />
                                            TAKER_BUY
                                        </label>
                                        <label className="flex items-center gap-2 text-[11px] text-muted-foreground border border-border/30 p-2">
                                            <input
                                                type="checkbox"
                                                checked={form.marketFilterAllowTakerSell}
                                                onChange={(e) => setForm(p => ({ ...p, marketFilterAllowTakerSell: e.target.checked }))}
                                            />
                                            TAKER_SELL
                                        </label>
                                        <label className="flex items-center gap-2 text-[11px] text-muted-foreground border border-border/30 p-2">
                                            <input
                                                type="checkbox"
                                                checked={form.marketFilterAllowMakerBid}
                                                onChange={(e) => setForm(p => ({ ...p, marketFilterAllowMakerBid: e.target.checked }))}
                                            />
                                            MAKER_BID
                                        </label>
                                        <label className="flex items-center gap-2 text-[11px] text-muted-foreground border border-border/30 p-2">
                                            <input
                                                type="checkbox"
                                                checked={form.marketFilterAllowMakerAsk}
                                                onChange={(e) => setForm(p => ({ ...p, marketFilterAllowMakerAsk: e.target.checked }))}
                                            />
                                            MAKER_ASK
                                        </label>
                                    </div>
                                </div>
                            </div>
                        )}

                        {step === "strategy" && form.autoTradeEnabled && (
                            <div className="space-y-6">
                                <SectionHeader
                                    title="Taker Strategy"
                                    badge="Directional"
                                    description="Act on signals. Size, quality, and cadence."
                                />
                                <div className="grid gap-3 md:grid-cols-3">
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Size Multiplier</Label>
                                        <Input
                                            value={form.sizeMultiplier}
                                            onChange={(e) => setForm(p => ({ ...p, sizeMultiplier: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="1"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Max Open Positions</Label>
                                        <Input
                                            value={form.maxOpenPositions}
                                            onChange={(e) => setForm(p => ({ ...p, maxOpenPositions: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="5"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Auto-Open Limit</Label>
                                        <Input
                                            value={form.autoOpenLimit}
                                            onChange={(e) => setForm(p => ({ ...p, autoOpenLimit: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="5"
                                        />
                                    </div>
                                </div>
                                <div className="grid gap-3 md:grid-cols-2">
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Min Confidence</Label>
                                        <Input
                                            value={form.minConfidence}
                                            onChange={(e) => setForm(p => ({ ...p, minConfidence: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="0.65"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Min Edge</Label>
                                        <Input
                                            value={form.minEdge}
                                            onChange={(e) => setForm(p => ({ ...p, minEdge: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="0.015"
                                        />
                                    </div>
                                </div>

                                <details className="group">
                                    <summary className="text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground flex items-center gap-2 p-2 bg-secondary/20 rounded-none">
                                        <span className="text-[10px]">▶</span>
                                        <span>Position Defaults</span>
                                        <span className="text-[10px] text-muted-foreground/60">(optional)</span>
                                    </summary>
                                    <div className="mt-2 p-3 bg-neon-green/5 rounded-none border border-neon-green/20 space-y-3">
                                        <div className="grid grid-cols-2 gap-3">
                                            <div className="space-y-1">
                                                <Label className="text-[10px] text-muted-foreground">Stop Loss %</Label>
                                                <Input
                                                    value={form.defaultStopLossPct}
                                                    onChange={(e) => setForm(p => ({ ...p, defaultStopLossPct: e.target.value }))}
                                                    className="bg-secondary/30 text-xs h-8"
                                                    placeholder="2"
                                                />
                                            </div>
                                            <div className="space-y-1">
                                                <Label className="text-[10px] text-muted-foreground">Take Profit %</Label>
                                                <Input
                                                    value={form.defaultTakeProfitPct}
                                                    onChange={(e) => setForm(p => ({ ...p, defaultTakeProfitPct: e.target.value }))}
                                                    className="bg-secondary/30 text-xs h-8"
                                                    placeholder="3"
                                                />
                                            </div>
                                            <div className="space-y-1">
                                                <Label className="text-[10px] text-muted-foreground">Max Loss ($)</Label>
                                                <Input
                                                    value={form.defaultMaxLossAbs}
                                                    onChange={(e) => setForm(p => ({ ...p, defaultMaxLossAbs: e.target.value }))}
                                                    className="bg-secondary/30 text-xs h-8"
                                                    placeholder="250"
                                                />
                                            </div>
                                            <div className="space-y-1">
                                                <Label className="text-[10px] text-muted-foreground">Max Hold (sec)</Label>
                                                <Input
                                                    value={form.defaultMaxHoldSec}
                                                    onChange={(e) => setForm(p => ({ ...p, defaultMaxHoldSec: e.target.value }))}
                                                    className="bg-secondary/30 text-xs h-8"
                                                    placeholder="3600"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </details>
                            </div>
                        )}

                        {step === "strategy" && form.makerEnabled && (
                            <div className="space-y-6">
                                <SectionHeader
                                    title="Maker Strategy"
                                    badge="Liquidity"
                                    description="Quote both sides. Control spread, size, and inventory."
                                />
                                <div className="flex items-center justify-between p-3 bg-secondary/20 rounded-none border border-border/30">
                                    <div>
                                        <Label className="text-[10px] text-muted-foreground">Execution Mode</Label>
                                        <p className="text-[10px] text-muted-foreground">Shadow-only</p>
                                    </div>
                                    <div className="px-3 py-1.5 text-xs rounded-none bg-neon-green/20 text-neon-green border border-neon-green/30">
                                        Shadow
                                    </div>
                                </div>
                                <div className="grid gap-3 md:grid-cols-3">
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Quote Size ($)</Label>
                                        <Input
                                            value={form.makerQuoteSize}
                                            onChange={(e) => setForm(p => ({ ...p, makerQuoteSize: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="50"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Quote Width (bps)</Label>
                                        <Input
                                            value={form.makerQuoteWidthBps}
                                            onChange={(e) => setForm(p => ({ ...p, makerQuoteWidthBps: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="20"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Inventory Max ($)</Label>
                                        <Input
                                            value={form.makerInventoryMaxAbs}
                                            onChange={(e) => setForm(p => ({ ...p, makerInventoryMaxAbs: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="500"
                                        />
                                    </div>
                                </div>
                                <div className="grid gap-3 md:grid-cols-3">
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Min Spread</Label>
                                        <Input
                                            value={form.makerMinSpread}
                                            onChange={(e) => setForm(p => ({ ...p, makerMinSpread: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="0.002"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Max Spread</Label>
                                        <Input
                                            value={form.makerMaxSpread}
                                            onChange={(e) => setForm(p => ({ ...p, makerMaxSpread: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="0.02"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-[10px] text-muted-foreground">Min Depth</Label>
                                        <Input
                                            value={form.makerMinDepth}
                                            onChange={(e) => setForm(p => ({ ...p, makerMinDepth: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="20"
                                        />
                                    </div>
                                </div>
                                <details className="group">
                                    <summary className="text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground flex items-center gap-2 p-2 bg-secondary/20 rounded-none">
                                        <span className="text-[10px]">▶</span>
                                        <span>Inventory Skew</span>
                                        <span className="text-[10px] text-muted-foreground/60">(optional)</span>
                                    </summary>
                                    <div className="mt-2 p-3 bg-neon-green/5 rounded-none border border-neon-green/20 space-y-2">
                                        <Label className="text-[10px] text-muted-foreground">Skew (bps)</Label>
                                        <Input
                                            value={form.makerInventorySkewBps}
                                            onChange={(e) => setForm(p => ({ ...p, makerInventorySkewBps: e.target.value }))}
                                            className="bg-secondary/30 text-xs h-8"
                                            placeholder="15"
                                        />
                                    </div>
                                </details>
                            </div>
                        )}
                    </div>

                    <div className="space-y-4">
                        <div className="rounded-none border border-border/40 bg-card/30 p-4">
                            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                                Summary
                            </div>
                            <div className="mt-3 space-y-2 text-xs font-mono text-muted-foreground">
                                <div className="flex items-center justify-between">
                                    <span>Mode</span>
                                    <span className="text-neon-green">{mode}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span>Name</span>
                                    <span className="text-foreground">{form.name || "Untitled"}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span>Balance</span>
                                    <span className="text-foreground">${form.startingBalance || "0"}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span>Risk</span>
                                    <span className="text-foreground">{riskSummary}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span>Allowlist</span>
                                    <span className="text-foreground">{allowlistSummary}</span>
                                </div>
                            </div>
                        </div>
                        <div className="rounded-none border border-border/40 bg-black/30 p-4">
                            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                                Guidance
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground font-mono">
                                Keep the first wallet simple. Tighten filters after you see stable edge.
                            </p>
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-between">
                    <Button
                        variant="outline"
                        onClick={() => setStep("basics")}
                        disabled={step === "basics"}
                    >
                        Back
                    </Button>
                    <div className="flex items-center gap-2">
                        {step === "basics" ? (
                            <Button variant="accent" onClick={() => setStep("strategy")}>
                                Continue
                            </Button>
                        ) : (
                            <Button variant="accent" onClick={() => onSave(form)}>
                                {isCreating ? "Create Wallet" : "Save Changes"}
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        </Drawer>
    );
}
