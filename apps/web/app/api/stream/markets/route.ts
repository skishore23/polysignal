import { getUniverseSnapshot } from "../../../../lib/queries";
import { getDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const isDev = process.env.NODE_ENV === "development";

const getFeedFreshnessSec = (): number => {
  const { sqlite } = getDb();
  const row = sqlite.prepare("SELECT MAX(ts) as maxTs FROM latest_features").get() as { maxTs: number | null } | undefined;
  if (!row?.maxTs) return 999;
  return Math.round((Date.now() - row.maxTs) / 1000);
};

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let closed = false;
  let interval: NodeJS.Timeout | null = null;
  let lastPayload: string | null = null;
  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit") ?? 200);
  const limit = Number.isFinite(limitParam) ? Math.max(50, Math.min(500, limitParam)) : 200;

  const cleanup = () => {
    closed = true;
    if (interval) clearInterval(interval);
  };

  const stream = new ReadableStream({
    start(controller) {
      let updateCount = 0;
      let pingCount = 0;
      const send = () => {
        if (closed) return;
        try {
          const rows = getUniverseSnapshot(limit);
          const feedFreshnessSec = getFeedFreshnessSec();
          const payload = { rows, meta: { feedFreshnessSec, ts: Date.now() } };
          const next = JSON.stringify(payload);
          if (next !== lastPayload) {
            lastPayload = next;
            updateCount++;
            if (isDev && updateCount % 10 === 1) {
              console.log('[SSE] Data update #' + updateCount, { rows: rows.length, feedFreshnessSec });
            }
            controller.enqueue(encoder.encode(`data: ${next}\n\n`));
          } else {
            pingCount++;
            controller.enqueue(encoder.encode(`event: ping\ndata: {}\n\n`));
          }
        } catch (err) {
          if (isDev) console.error('[SSE] Markets error:', err);
        }
      };

      send();
      interval = setInterval(send, 1500);

      req.signal.addEventListener("abort", () => {
        cleanup();
        controller.close();
      });
    },
    cancel() {
      cleanup();
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    }
  });
}
