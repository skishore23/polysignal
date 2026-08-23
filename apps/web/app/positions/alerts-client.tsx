"use client";

import { useParams, useSearchParams } from "next/navigation";
import { AlertsFeed } from "../../components/AlertsFeed";
import { AlertsSetup } from "../../components/AlertsSetup";

export function AlertsClient({ walletId }: { walletId?: number | null }) {
  const searchParams = useSearchParams();
  const params = useParams<{ walletId?: string }>();
  const walletIdParam = searchParams.get("walletId");
  const routeWalletId = params?.walletId ? Number(params.walletId) : null;
  const walletIdFinal = walletId ?? (Number.isFinite(routeWalletId) ? routeWalletId : walletIdParam ? Number(walletIdParam) : null);

  return (
    <>
      <AlertsFeed walletId={walletIdFinal} />
      <AlertsSetup />
    </>
  );
}
