"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "../lib/utils";
import { LayoutGrid, FileText, TrendingUp, Wallet, Network } from "lucide-react";

const NAV_ITEMS = [
    { name: "Markets", href: "/", icon: LayoutGrid },
    { name: "Wallets", href: "/positions", icon: Wallet },
    { name: "Performance", href: "/performance", icon: TrendingUp },
    { name: "Regimes", href: "/regimes", icon: Network },
    { name: "Decision Chain", href: "/chain", icon: FileText },
];

export function BottomNav() {
    const pathname = usePathname();

    return (
        <nav
            className="fixed bottom-0 left-0 right-0 h-16 min-h-[64px] border-t border-border/60 bg-background/95 backdrop-blur-xl z-50 flex items-center justify-around px-1 pb-[env(safe-area-inset-bottom,0px)]"
            aria-label="Primary navigation"
        >
            {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = pathname === item.href;

                return (
                    <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                            "flex flex-col items-center justify-center w-full h-full gap-1.5 transition-all duration-200 relative group",
                            isActive ? "text-neon-green" : "text-muted-foreground/60 hover:text-foreground"
                        )}
                    >
                        {isActive && (
                            <div className="absolute top-0 w-12 h-0.5 bg-neon-green shadow-[0_0_10px_rgba(74,222,128,0.8)]" />
                        )}
                        <Icon className={cn("h-6 w-6 transition-transform", isActive && "scale-110 drop-shadow-[0_0_5px_rgba(74,222,128,0.4)]")} strokeWidth={1.5} />
                        <span className={cn("text-[9px] font-mono uppercase tracking-widest", isActive && "font-bold")}>{item.name}</span>
                    </Link>
                );
            })}
        </nav>
    );
}
