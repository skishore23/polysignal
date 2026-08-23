import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ReachabilityEntry = {
  hits: number;
  firstTs: number;
  lastTs: number;
};

type ReachabilityState = {
  enabled: boolean;
  outPath: string;
  entries: Map<string, ReachabilityEntry>;
  initialized: boolean;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const defaultOutPath = path.join(repoRoot, "docs", "refactor_baseline", "runtime_reachability.json");

const stateKey = "__polysignal_reachability_state__";
const globalObj = globalThis as Record<string, unknown>;

const createState = (): ReachabilityState => ({
  enabled: process.env.DEBUG_REACHABILITY === "1",
  outPath: process.env.DEBUG_REACHABILITY_OUT
    ? path.resolve(process.env.DEBUG_REACHABILITY_OUT)
    : defaultOutPath,
  entries: new Map<string, ReachabilityEntry>(),
  initialized: false
});

const state = (() => {
  const existing = globalObj[stateKey] as ReachabilityState | undefined;
  if (existing) return existing;
  const next = createState();
  globalObj[stateKey] = next;
  return next;
})();

const flushReachability = (): void => {
  if (!state.enabled) return;
  const modules = Array.from(state.entries.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([moduleOrFunction, entry]) => ({
      moduleOrFunction,
      hits: entry.hits,
      firstTs: entry.firstTs,
      lastTs: entry.lastTs
    }));

  const payload = {
    generatedAt: Date.now(),
    modules
  };

  mkdirSync(path.dirname(state.outPath), { recursive: true });
  writeFileSync(state.outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
};

const init = (): void => {
  if (!state.enabled || state.initialized) return;
  state.initialized = true;
  process.on("exit", flushReachability);
  process.on("SIGINT", flushReachability);
  process.on("SIGTERM", flushReachability);
};

export const reachabilityHit = (moduleOrFunction: string): void => {
  if (!state.enabled) return;
  init();
  const now = Date.now();
  const prior = state.entries.get(moduleOrFunction);
  if (!prior) {
    state.entries.set(moduleOrFunction, { hits: 1, firstTs: now, lastTs: now });
    return;
  }
  prior.hits += 1;
  prior.lastTs = now;
  state.entries.set(moduleOrFunction, prior);
};
