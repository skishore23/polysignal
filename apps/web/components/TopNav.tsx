"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "../lib/utils";

const NAV_LINKS = [
    { name: "Markets", href: "/" },
    { name: "Wallets", href: "/positions" },
    { name: "Performance", href: "/performance" },
    { name: "Regimes", href: "/regimes" },
    { name: "Decision Chain", href: "/chain" },
];

export function TopNav() {
    const pathname = usePathname();

    return (
        <nav className="flex gap-1 text-xs font-mono uppercase tracking-widest">
            {NAV_LINKS.map((link) => {
                const isActive = pathname === link.href;
                return (
                    <Link
                        key={link.href}
                        className={cn(
                            "px-4 py-1.5 relative transition-all duration-200 group rounded-sm hover:bg-secondary/50",
                            isActive
                                ? "text-neon-green bg-secondary/80 font-bold"
                                : "text-muted-foreground hover:text-foreground"
                        )}
                        href={link.href}
                        prefetch={false}
                    >
                        {isActive && (
                            <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-neon-green shadow-[0_0_8px_rgba(74,222,128,0.6)]" />
                        )}
                        {link.name}
                    </Link>
                );
            })}
        </nav>
    );
}
