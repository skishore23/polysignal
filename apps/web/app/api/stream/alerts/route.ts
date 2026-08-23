import { getAlerts } from "../../../../lib/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const isDev = process.env.NODE_ENV === "development";

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let closed = false;
  let lastId = 0;
  let interval: NodeJS.Timeout | null = null;

  const cleanup = () => {
    closed = true;
    if (interval) clearInterval(interval);
  };

  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        if (closed) return;
        try {
          const alerts = getAlerts(lastId);
          if (alerts.length) {
            lastId = alerts[alerts.length - 1].id as number;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(alerts)}\n\n`));
          } else {
            controller.enqueue(encoder.encode(`event: ping\ndata: {}\n\n`));
          }
        } catch (err) {
          if (isDev) console.error("[SSE] Alerts error:", err);
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
