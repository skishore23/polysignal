import { getDb } from "../../../../lib/db";
import { eq, alerts, settings } from "@polysignal/storage";


export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const isValidWebhookUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    tokenId?: string | null;
    marketId?: string | null;
    message?: string;
  };

  const { db } = getDb();
  const ts = Date.now();
  const payload = {
    message: body.message ?? "Test alert",
    reason: "manual_test"
  };

  const result = db.insert(alerts).values({
    ts,
    type: "TEST_ALERT",
    tokenId: body.tokenId ?? null,
    marketId: body.marketId ?? null,
    payload: JSON.stringify(payload),
    delivered: 0
  }).returning().all();

  const id = result[0]?.id;
  if (!id) {
    return Response.json({ error: "Failed to create alert" }, { status: 500 });
  }

  const row = db.select().from(settings).where(eq(settings.key, "webhook_url")).all()[0];
  const webhook = row?.value ?? "";
  if (webhook && isValidWebhookUrl(webhook)) {
    try {
      const resp = await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ts, type: "TEST_ALERT", tokenId: body.tokenId ?? null, marketId: body.marketId ?? null, payload })
      });
      if (resp.ok) {
        db.update(alerts)
          .set({ delivered: 1 })
          .where(eq(alerts.id, id))
          .run();
      }
    } catch {
      // ignore webhook delivery errors for test alerts
    }
  }

  return Response.json({ id });
}
