"use client";

import * as React from "react";
import { ChevronDown, Plus, Wallet as WalletIcon, Settings } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

interface Wallet {
    id: number;
    name: string;
    makerEnabled?: number | boolean;
}

function walletLabel(w: Wallet): string {
    return w.name;
}

function walletTypeLabel(w: Wallet): string {
    return w.makerEnabled ? "Maker" : "Taker";
}

interface WalletContextBarProps {
    wallets: Wallet[];
    activeWalletId: number | null;
    onSelect: (id: number) => void;
    onEdit: (id: number) => void;
    onCreate: () => void;
    /** When true, render compact inline (for page header, no sticky bar) */
    inline?: boolean;
}

export function WalletContextBar({ wallets, activeWalletId, onSelect, onEdit, onCreate, inline }: WalletContextBarProps) {
    const [isOpen, setIsOpen] = React.useState(false);
    const activeWallet = wallets.find((w) => w.id === activeWalletId);

    const selectorAndActions = (
        <div className={cn("flex items-center gap-2", !inline && "max-w-8xl px-4 h-12 justify-between")}>
            <div className="relative">
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    className={cn(
                        "flex items-center gap-2 hover:bg-secondary/50 rounded-sm transition-colors group",
                        inline ? "px-3 py-2 border border-border/40" : "px-2 py-1.5"
                    )}
                >
                    <div className="h-6 w-6 rounded-sm bg-neon-green/10 flex items-center justify-center border border-neon-green/20 group-hover:border-neon-green/50 transition-colors">
                        <WalletIcon className="h-3.5 w-3.5 text-neon-green" />
                    </div>
                    <span className="font-mono font-bold text-sm tracking-tight text-foreground uppercase">
                        {activeWallet ? walletLabel(activeWallet) : "Select Wallet"}
                    </span>
                    {activeWallet && (
                        <span
                            className={cn(
                                "text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border",
                                activeWallet.makerEnabled
                                    ? "bg-neon-green/10 text-neon-green border-neon-green/30"
                                    : "bg-secondary/40 text-muted-foreground border-border/60"
                            )}
                        >
                            {walletTypeLabel(activeWallet)}
                        </span>
                    )}
                    <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200", isOpen && "rotate-180")} />
                </button>
                {isOpen && (
                    <>
                        <div className="fixed inset-0 z-40 bg-transparent" onClick={() => setIsOpen(false)} />
                        <div className={cn("absolute top-full mt-1 w-64 bg-card border border-border/60 rounded-sm shadow-xl z-50 animate-in fade-in slide-in-from-top-1", inline ? "right-0" : "left-0")}>
                            <div className="p-1 max-h-[300px] overflow-y-auto">
                                {wallets.map(w => (
                                    <button
                                        key={w.id}
                                        onClick={() => {
                                            onSelect(w.id);
                                            setIsOpen(false);
                                        }}
                                        className={cn(
                                            "w-full text-left px-3 py-2 text-xs font-mono rounded-sm flex items-center justify-between group",
                                            activeWalletId === w.id ? "bg-neon-green/10 text-neon-green" : "hover:bg-secondary/50 text-muted-foreground hover:text-foreground"
                                        )}
                                    >
                                        <span className="flex items-center gap-2">
                                            {w.name}
                                            <span
                                                className={cn(
                                                    "text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border",
                                                    w.makerEnabled
                                                        ? "bg-neon-green/10 text-neon-green border-neon-green/30"
                                                        : "bg-secondary/40 text-muted-foreground border-border/60"
                                                )}
                                            >
                                                {walletTypeLabel(w)}
                                            </span>
                                        </span>
                                        {activeWalletId === w.id && <div className="h-1.5 w-1.5 rounded-full bg-neon-green shadow-[0_0_5px_rgba(74,222,128,0.5)]" />}
                                    </button>
                                ))}
                            </div>
                            <div className="p-2 border-t border-border/40 bg-secondary/20">
                                <button
                                    onClick={() => {
                                        onCreate();
                                        setIsOpen(false);
                                    }}
                                    className="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold bg-neon-green hover:bg-emerald-500 text-black rounded-sm transition-colors shadow-sm"
                                >
                                    <Plus className="h-3.5 w-3.5" /> Create New Wallet
                                </button>
                            </div>
                        </div>
                    </>
                )}
            </div>
            {activeWallet && (
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 rounded-sm hover:bg-secondary/80 text-muted-foreground hover:text-foreground"
                    onClick={() => onEdit(activeWallet.id)}
                >
                    <Settings className="h-4 w-4" />
                </Button>
            )}
        </div>
    );

    if (inline) return selectorAndActions;
    return (
        <div className="w-full border-b border-border/40 bg-background/95 backdrop-blur-xl sticky top-[57px] z-10">
            {selectorAndActions}
        </div>
    );
}
