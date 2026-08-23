/**
 * Resolve maker_enabled and auto_trade_enabled for wallet create/update.
 * On update: preserve existing flags when not sent so partial updates never flip wallets to maker-only.
 */

export type WalletFlagsInput = {
  makerEnabled?: boolean | null;
  autoTradeEnabled?: boolean | null;
};

export type ExistingWalletFlags = {
  makerEnabled?: number | null;
  autoTradeEnabled?: number | null;
};

/**
 * Returns { makerEnabled: 0|1, autoTradeEnabled: 0|1 }.
 * - For create (existing === undefined): defaults to taker-only when not sent.
 * - For update (existing set): preserves existing when body omits the flag.
 */
export function resolveWalletMakerTakerFlags(
  body: WalletFlagsInput,
  existing?: ExistingWalletFlags | null
): { makerEnabled: number; autoTradeEnabled: number } {
  if (existing != null) {
    const makerEnabled =
      body.makerEnabled != null ? (body.makerEnabled ? 1 : 0) : (existing.makerEnabled ?? 0);
    const autoTradeEnabled =
      body.autoTradeEnabled != null ? (body.autoTradeEnabled ? 1 : 0) : (existing.autoTradeEnabled ?? 1);
    return { makerEnabled, autoTradeEnabled };
  }
  const makerEnabled = body.makerEnabled != null ? (body.makerEnabled ? 1 : 0) : 0;
  const autoTradeEnabled = body.autoTradeEnabled != null ? (body.autoTradeEnabled ? 1 : 0) : 1;
  return { makerEnabled, autoTradeEnabled };
}
