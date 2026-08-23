import { getMarketDetail } from "../../../../../lib/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const isDev = process.env.NODE_ENV === "development";

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const url = new URL(req.url);
  const tokenId = url.searchParams.get("token");
  const encoder = new TextEncoder();
  let closed = false;
  let interval: NodeJS.Timeout | null = null;
  let lastPayload: string | null = null;

  const cleanup = () => {
    closed = true;
    if (interval) clearInterval(interval);
  };

  const stream = new ReadableStream({
    start(controller) {
      if (!tokenId) {
        controller.enqueue(encoder.encode("event: error\ndata: {\"error\":\"missing token\"}\n\n"));
        cleanup();
        controller.close();
        return;
      }
      const send = () => {
        if (closed) return;
        try {
          const detail = getMarketDetail(tokenId, {
            featureLimit: 240,
            decisionLimit: 120
          });
          const payload = JSON.stringify({
            features: detail.features.map((f) => ({
              ts: f.ts,
              mid: f.mid,
              obi: f.obi,
              micropriceMinusMid: f.micropriceMinusMid,
              spread: f.spread,
              accel1m: f.accel1m,
              skew30m: f.skew30m,
              entropy30m: f.entropy30m
            })),
            decisions: detail.decisions
          });
          if (payload !== lastPayload) {
            lastPayload = payload;
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
          } else {
            controller.enqueue(encoder.encode(`event: ping\ndata: {}\n\n`));
          }
        } catch (err) {
          if (isDev) console.error("[SSE] Market detail error:", err);
        }
      };

      send();
      interval = setInterval(send, 2000);

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
