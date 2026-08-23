#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name: string, fallback: string): string => {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  return argv[idx + 1] ?? fallback;
};

const inputPath = path.resolve(arg("--input", "reports/refactor-baseline/.baseline_smoke_raw.log"));
const excerptPath = path.resolve(
  arg("--excerpt", "reports/refactor-baseline/baseline_smoke_log_excerpt.jsonl")
);
const metricsPath = path.resolve(arg("--metrics", "reports/refactor-baseline/baseline_key_metrics.json"));
const maxExcerpt = Number(arg("--max-excerpt", "200"));

type LoopTrace = {
  loop: "maker" | "taker";
  regimeLoad?: {
    reasonCode?: string | null;
  };
  outcome?: {
    placedOrders?: number;
    whyIdle?: {
      code?: string;
    } | null;
  };
};

const lines = readFileSync(inputPath, "utf8").split(/\r?\n/g).filter(Boolean);

const loopTickCounts: Record<string, number> = { maker: 0, taker: 0 };
const placedOrdersByLoop: Record<string, number> = { maker: 0, taker: 0 };
const regimeLoadReasonCounts = new Map<string, number>();
const idleReasonCounts = new Map<string, number>();

const excerptRows: unknown[] = [];
const addCount = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, "");

const parseLineJson = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // noop
  }
  return null;
};

const braceDelta = (value: string): number => {
  let delta = 0;
  let inString = false;
  let escaped = false;

  for (const ch of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") delta += 1;
    if (ch === "}") delta -= 1;
  }

  return delta;
};

const parsePrettyLoopTrace = (
  sourceLines: string[],
  startIndex: number
): { loopTrace: LoopTrace | null; endIndex: number; rawText: string } => {
  const startLine = stripAnsi(sourceLines[startIndex] ?? "");
  const marker = "loopTrace:";
  const markerIndex = startLine.indexOf(marker);
  if (markerIndex === -1) {
    return { loopTrace: null, endIndex: startIndex, rawText: "" };
  }

  const firstChunk = startLine.slice(markerIndex + marker.length).trimStart();
  if (!firstChunk.startsWith("{")) {
    return { loopTrace: null, endIndex: startIndex, rawText: "" };
  }

  const chunks: string[] = [firstChunk];
  let delta = braceDelta(firstChunk);
  let index = startIndex + 1;

  while (index < sourceLines.length && delta > 0) {
    const cleanLine = stripAnsi(sourceLines[index] ?? "").trimStart();
    chunks.push(cleanLine);
    delta += braceDelta(cleanLine);
    index += 1;
  }

  const rawText = chunks.join("\n");
  try {
    const parsed = JSON.parse(rawText) as LoopTrace;
    return { loopTrace: parsed, endIndex: Math.max(startIndex, index - 1), rawText };
  } catch {
    return { loopTrace: null, endIndex: Math.max(startIndex, index - 1), rawText };
  }
};

const captureLoopTrace = (loopTrace: LoopTrace): void => {
  if (loopTrace.loop !== "maker" && loopTrace.loop !== "taker") return;
  loopTickCounts[loopTrace.loop] += 1;
  const placedOrders = Number(loopTrace.outcome?.placedOrders ?? 0);
  placedOrdersByLoop[loopTrace.loop] += Number.isFinite(placedOrders) ? placedOrders : 0;
  const regimeCode = loopTrace.regimeLoad?.reasonCode;
  if (regimeCode) addCount(regimeLoadReasonCounts, regimeCode);
  const idleCode = loopTrace.outcome?.whyIdle?.code;
  if (idleCode) addCount(idleReasonCounts, idleCode);
};

const messageMarkers = [
  "Worker started",
  "Execution policy",
  "RegimeGate",
  "Running startup verification",
  "Verification passed",
  "Verification failed"
];

for (let i = 0; i < lines.length; i += 1) {
  const cleanLine = stripAnsi(lines[i] ?? "");
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = parseLineJson(cleanLine);
  } catch {
    parsed = null;
  }

  if (parsed) {
    const msg = typeof parsed.msg === "string" ? parsed.msg : "";
    const loopTrace = parsed.loopTrace as LoopTrace | undefined;

    if (loopTrace?.loop === "maker" || loopTrace?.loop === "taker") {
      captureLoopTrace(loopTrace);
    }

    const shouldCapture =
      Boolean(loopTrace) ||
      messageMarkers.some((marker) => msg.includes(marker));

    if (shouldCapture && excerptRows.length < maxExcerpt) {
      excerptRows.push(parsed);
    }
    continue;
  }

  if (cleanLine.includes("loopTrace: {")) {
    const { loopTrace, endIndex, rawText } = parsePrettyLoopTrace(lines, i);
    if (loopTrace) {
      captureLoopTrace(loopTrace);
      if (excerptRows.length < maxExcerpt) {
        excerptRows.push({ msg: "loopTrace", loopTrace });
      }
    } else if (rawText && excerptRows.length < maxExcerpt) {
      excerptRows.push({ msg: "loopTrace_parse_failed", raw: rawText });
    }
    i = endIndex;
    continue;
  }

  if (messageMarkers.some((marker) => cleanLine.includes(marker)) && excerptRows.length < maxExcerpt) {
    excerptRows.push({ msg: cleanLine.trim() });
  }
}

const toObject = (map: Map<string, number>): Record<string, number> =>
  Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .reduce<Record<string, number>>((acc, [k, v]) => {
      acc[k] = v;
      return acc;
    }, {});

writeFileSync(
  excerptPath,
  `${excerptRows.map((row) => JSON.stringify(row)).join("\n")}${excerptRows.length ? "\n" : ""}`,
  "utf8"
);

writeFileSync(
  metricsPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      loopTickCounts,
      placedOrdersByLoop,
      regimeLoadReasonCounts: toObject(regimeLoadReasonCounts),
      idleReasonCounts: toObject(idleReasonCounts)
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(
  `[extract-baseline-metrics] makerTicks=${loopTickCounts.maker} takerTicks=${loopTickCounts.taker} excerpt=${excerptRows.length}`
);
