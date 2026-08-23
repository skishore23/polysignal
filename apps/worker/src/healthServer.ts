import http from "node:http";
import type { LoopHealthInfo } from "./state/loopTracker";

export type HealthState = {
  startedAt: number;
  marketsTracked: number;
  tokensTracked: number;
  wsConnected: boolean;
  lastUpdate: number | null;
  loopStates: Record<string, LoopHealthInfo>;
};

export function startHealthServer(port: number, state: HealthState): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      const body = JSON.stringify({
        status: "ok",
        uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
        marketsTracked: state.marketsTracked,
        tokensTracked: state.tokensTracked,
        wsConnected: state.wsConnected,
        lastUpdate: state.lastUpdate,
        loopStates: state.loopStates
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      res.end(body);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.listen(port);
  return server;
}
