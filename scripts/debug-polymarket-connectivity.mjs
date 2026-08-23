/**
 * Connectivity probe for Polymarket endpoints.
 *
 * Usage:
 *   node scripts/debug-polymarket-connectivity.mjs
 *   node scripts/debug-polymarket-connectivity.mjs --json
 */
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import WebSocket from "ws";

const asErrorMessage = (err) => {
  if (err instanceof Error) return err.message;
  return String(err);
};

const run = async (fn) => {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: asErrorMessage(err) };
  }
};

const withTiming = async (name, target, fn) => {
  const started = Date.now();
  const out = await run(fn);
  const ms = Date.now() - started;
  if (out.ok) {
    return { name, target, status: "ok", ms, details: out.value };
  }
  return { name, target, status: "fail", ms, details: { error: out.error } };
};

const probeDns = (host) =>
  dns.lookup(host, { all: true }).then((rows) => ({
    addresses: rows.map((r) => `${r.address} (IPv${r.family})`)
  }));

const probeTcp = (host, port, timeoutMs = 8_000) =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`tcp timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      const remoteAddress = socket.remoteAddress ?? "";
      const remotePort = socket.remotePort ?? port;
      cleanup();
      resolve({ remote: `${remoteAddress}:${remotePort}` });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
  });

const probeTls = (host, port = 443, timeoutMs = 10_000, servername = host) =>
  new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername,
      rejectUnauthorized: true
    });
    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`tls timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const cipher = socket.getCipher();
      const protocol = socket.getProtocol();
      const authorized = socket.authorized;
      const authorizationError = socket.authorizationError ?? null;
      cleanup();
      resolve({
        protocol,
        cipher: cipher?.name ?? null,
        authorized,
        authorizationError
      });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
  });

const probeHttps = async (url, timeoutMs = 10_000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json,text/plain,*/*" }
    });
    const body = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      bodyPreview: body.slice(0, 140)
    };
  } finally {
    clearTimeout(timer);
  }
};

const probeWsOpen = (url, timeoutMs = 10_000) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    const cleanup = () => {
      ws.removeAllListeners();
      ws.close();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`ws timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    ws.once("open", () => {
      clearTimeout(timer);
      cleanup();
      resolve({ opened: true });
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`unexpected response: ${res.statusCode}`));
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
  });

const parseHost = (url) => new URL(url).hostname;

async function main() {
  const asJson = process.argv.includes("--json");
  const targets = [
    { name: "control-example", httpsUrl: "https://example.com/" },
    { name: "gamma-api", httpsUrl: "https://gamma-api.polymarket.com/markets?limit=1&active=true&closed=false" },
    { name: "clob-rest", httpsUrl: "https://clob.polymarket.com/book?token_id=0" },
    { name: "clob-ws-market", wsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market" }
  ];

  const results = [];

  for (const target of targets) {
    const reference = target.httpsUrl ?? target.wsUrl;
    if (!reference) continue;
    const host = parseHost(reference);
    results.push(await withTiming(`${target.name}:dns`, host, () => probeDns(host)));
    results.push(await withTiming(`${target.name}:tcp443`, host, () => probeTcp(host, 443)));
    results.push(await withTiming(`${target.name}:tls443`, host, () => probeTls(host, 443)));
    if (target.httpsUrl) {
      results.push(await withTiming(`${target.name}:https`, target.httpsUrl, () => probeHttps(target.httpsUrl)));
    }
    if (target.wsUrl) {
      results.push(await withTiming(`${target.name}:ws-open`, target.wsUrl, () => probeWsOpen(target.wsUrl)));
    }
  }

  let sniDifferential = null;
  const gammaDns = results.find((r) => r.name === "gamma-api:dns" && r.status === "ok");
  if (gammaDns && gammaDns.status === "ok") {
    const addresses = Array.isArray(gammaDns.details?.addresses)
      ? gammaDns.details.addresses
      : [];
    const firstIpRaw = typeof addresses[0] === "string" ? addresses[0] : null;
    const firstIp = firstIpRaw ? firstIpRaw.split(" ")[0] : null;
    if (firstIp) {
      const cloudflareSni = await withTiming("gamma-api:sni-cloudflare", `${firstIp}:443`, () =>
        probeTls(firstIp, 443, 10_000, "cloudflare.com")
      );
      const polymarketSni = await withTiming("gamma-api:sni-polymarket", `${firstIp}:443`, () =>
        probeTls(firstIp, 443, 10_000, "gamma-api.polymarket.com")
      );
      results.push(cloudflareSni, polymarketSni);
      sniDifferential = {
        ip: firstIp,
        cloudflareSni: cloudflareSni.status,
        polymarketSni: polymarketSni.status
      };
    }
  }

  const failed = results.filter((r) => r.status === "fail");
  const failNames = new Set(failed.map((r) => r.name));
  const dnsFail = (prefix) => failNames.has(`${prefix}:dns`);
  const httpsFail = (prefix) => failNames.has(`${prefix}:https`);
  const tlsFail = (prefix) => failNames.has(`${prefix}:tls443`);
  const wsFail = (prefix) => failNames.has(`${prefix}:ws-open`);

  let diagnosis = "mixed";
  const controlDnsFailed = dnsFail("control-example");
  const allPolymarketDnsFailed =
    dnsFail("gamma-api") && dnsFail("clob-rest") && dnsFail("clob-ws-market");
  const allPolymarketTlsFailed =
    tlsFail("gamma-api") && tlsFail("clob-rest") && tlsFail("clob-ws-market");
  const polymarketHttpsFailed = httpsFail("gamma-api") && httpsFail("clob-rest");
  const polymarketWsFailed = wsFail("clob-ws-market");

  if (
    sniDifferential &&
    sniDifferential.cloudflareSni === "ok" &&
    sniDifferential.polymarketSni === "fail"
  ) {
    diagnosis = "polymarket_sni_block_or_geofence";
  } else if (controlDnsFailed && allPolymarketDnsFailed) {
    diagnosis = "dns_unavailable_on_host";
  } else if (!controlDnsFailed && allPolymarketDnsFailed) {
    diagnosis = "polymarket_domain_resolution_blocked";
  } else if (!allPolymarketDnsFailed && allPolymarketTlsFailed) {
    diagnosis = "tls_path_or_middlebox_reset";
  } else if (!polymarketHttpsFailed && polymarketWsFailed) {
    diagnosis = "websocket_path_blocked";
  } else if (!polymarketHttpsFailed && !polymarketWsFailed) {
    diagnosis = "connectivity_ok";
  }

  const summary = {
    ts: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    ok: results.filter((r) => r.status === "ok").length,
    fail: results.filter((r) => r.status === "fail").length,
    diagnosis,
    sniDifferential,
    results
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(
    `[probe] ${summary.ts} node=${summary.node} platform=${summary.platform} diagnosis=${summary.diagnosis}`
  );
  for (const row of results) {
    const status = row.status.toUpperCase().padEnd(4, " ");
    const ms = `${row.ms}ms`.padStart(6, " ");
    const details =
      row.status === "ok"
        ? JSON.stringify(row.details)
        : `error=${String(row.details.error ?? "unknown")}`;
    console.log(`${status} ${ms}  ${row.name}  ${details}`);
  }
  console.log(`[probe] ok=${summary.ok} fail=${summary.fail}`);
}

main().catch((err) => {
  console.error(`[probe] fatal: ${asErrorMessage(err)}`);
  process.exit(1);
});
