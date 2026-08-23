"use client";

import * as React from "react";
import { cn } from "../lib/utils";
import { X } from "lucide-react";

interface DrawerProps {
    isOpen: boolean;
    onClose: () => void;
    children: React.ReactNode;
    title?: string;
    className?: string; // Add className prop
}

export function Drawer({ isOpen, onClose, children, title, className }: DrawerProps) {
    const [visible, setVisible] = React.useState(isOpen);
    const [animateIn, setAnimateIn] = React.useState(false);

    React.useEffect(() => {
        if (isOpen) {
            setVisible(true);
            // Small delay to allow render before transition
            requestAnimationFrame(() => setAnimateIn(true));
        } else {
            setAnimateIn(false);
            const timer = setTimeout(() => setVisible(false), 300); // Match transition duration
            return () => clearTimeout(timer);
        }
    }, [isOpen]);

    if (!visible) return null;

    return (
        <div className="fixed inset-0 z-50 flex flex-col justify-end isolate">
            {/* Backdrop */}
            <div
                className={cn(
                    "absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300",
                    animateIn ? "opacity-100" : "opacity-0"
                )}
                onClick={onClose}
            />

            {/* Sheet */}
            <div
                className={cn(
                    "relative w-full bg-card border-t border-border rounded-t-2xl shadow-xl transition-transform duration-300 ease-out max-h-[85vh] flex flex-col",
                    animateIn ? "translate-y-0" : "translate-y-full",
                    className
                )}
            >
                {/* Handle */}
                <div className="flex-none p-2 flex justify-center cursor-pointer" onClick={onClose}>
                    <div className="w-12 h-1.5 rounded-full bg-muted-foreground/20" />
                </div>

                {/* Header */}
                <div className="flex-none px-4 pb-2 flex items-center justify-between border-b border-border/50">
                    <h3 className="font-semibold text-lg tracking-tight">{title}</h3>
                    <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-full">
                        <X className="h-5 w-5 text-muted-foreground" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 safe-area-bottom">
                    {children}
                </div>
            </div>
        </div>
    );
}
