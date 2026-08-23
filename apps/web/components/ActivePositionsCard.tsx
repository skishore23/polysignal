"use client";

import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { formatNum, formatPct } from "../lib/utils";
import { Badge } from "./ui/badge";

interface ActivePositionsCardProps {
    positions: any[];
    title?: string;
    headerRight?: ReactNode;
}

export function ActivePositionsCard({ positions, title = "Active Positions", headerRight }: ActivePositionsCardProps) {
    const rows = positions.map((p) => {
        const isLong = p.side === "LONG";
        const mark = p.mid ?? p.entryPrice; // Fallback if no live mark

        // Use pre-calculated unrealized PnL if available (maker positions)
        // Otherwise calculate from mark-to-market
        let pnl: number;
        let pnlAbs: number;

        if (typeof p.unrealized === "number" && p.entryPrice && p.size) {
            // Maker/taker position with pre-calculated unrealized
            pnlAbs = p.unrealized;
            const notional = p.entryPrice * p.size;
            pnl = notional !== 0 ? pnlAbs / notional : 0;
        } else {
            // Calculate from mark
            pnl = mark && p.entryPrice
                ? isLong
                    ? (mark - p.entryPrice) / p.entryPrice
                    : (p.entryPrice - mark) / p.entryPrice
                : 0;
            pnlAbs = mark && p.size
                ? pnl * p.entryPrice * p.size
                : 0;
        }

        return { ...p, pnl, pnlAbs, mark };
    });

    return (
        <Card className="bg-card/40 backdrop-blur-sm border-border/50">
            <CardHeader className="py-3 border-b border-border/40 flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-mono uppercase tracking-wider text-muted-foreground">{title}</CardTitle>
                <div className="flex items-center gap-2">
                    <span className="text-xs font-mono bg-secondary/50 px-2 py-0.5 rounded-sm">{positions.length} OPEN</span>
                    {headerRight}
                </div>
            </CardHeader>
            <CardContent className="p-0">
                <Table>
                    <TableHeader className="bg-secondary/20">
                        <TableRow className="hover:bg-transparent border-border/40">
                            <TableHead className="h-8 text-[10px] uppercase font-mono w-[40%]">Market</TableHead>
                            <TableHead className="h-8 text-[10px] uppercase font-mono text-right w-[15%]">Size</TableHead>
                            <TableHead className="h-8 text-[10px] uppercase font-mono text-right w-[15%]">Entry</TableHead>
                            <TableHead className="h-8 text-[10px] uppercase font-mono text-right w-[15%]">PnL</TableHead>
                            <TableHead className="h-8 text-[10px] uppercase font-mono text-right w-[15%]">Time</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={5} className="text-center py-8 text-xs text-muted-foreground font-mono">
                                    No active positions
                                </TableCell>
                            </TableRow>
                        )}
                        {rows.map((row) => (
                            <TableRow key={row.id} className="border-border/40 hover:bg-secondary/10">
                                <TableCell className="font-mono text-xs">
                                    <div className="flex flex-col gap-1">
                                        <div className="flex items-center gap-2">
                                            <Badge variant="neutral" className={row.side === "LONG" ? "text-neon-green bg-neon-green/10 border-neon-green/20 text-[10px] px-1.5" : "text-rose-500 bg-rose-500/10 border-rose-500/20 text-[10px] px-1.5"}>
                                                {row.side}
                                            </Badge>
                                            {row.outcome && (
                                                <span className="font-bold text-foreground text-xs">{row.outcome}</span>
                                            )}
                                        </div>
                                        <span className="text-[10px] text-muted-foreground leading-tight line-clamp-2" title={row.question ?? row.tokenId}>
                                            {row.question ?? `${row.tokenId.slice(0, 8)}...${row.tokenId.slice(-6)}`}
                                        </span>
                                    </div>
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs tabular-nums">{formatNum(row.size)}</TableCell>
                                <TableCell className="text-right font-mono text-xs text-muted-foreground">{formatNum(row.entryPrice)}</TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                    <div className="flex flex-col items-end">
                                        <span className={formatNum(row.pnl) === "0" ? "text-muted-foreground" : row.pnl > 0 ? "text-neon-green" : "text-rose-500"}>
                                            {formatPct(row.pnl)}
                                        </span>
                                    </div>
                                </TableCell>
                                <TableCell className="text-right font-mono text-[10px] text-muted-foreground" suppressHydrationWarning>
                                    {Math.floor((Date.now() - row.tsOpen) / 60000)}m
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    );
}
