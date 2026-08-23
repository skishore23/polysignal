/**
 * Repro script for web dev process exits.
 *
 * Usage:
 *   node scripts/debug-web-dev-exit.mjs
 *   node scripts/debug-web-dev-exit.mjs --timeoutSec 25
 */
import { spawn } from "node:child_process";

const parseArg = (name, fallback) => {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const raw = process.argv[idx + 1];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

async function main() {
  const timeoutSec = parseArg("--timeoutSec", 20);
  const started = Date.now();
  const cmd = "npm";
  const args = ["run", "dev", "--workspace", "apps/web"];

  console.log(`[web-debug] spawning: ${cmd} ${args.join(" ")}`);
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderr += text;
    process.stderr.write(text);
  });

  const timer = setTimeout(() => {
    timedOut = true;
    console.log(`[web-debug] timeout after ${timeoutSec}s, sending SIGTERM`);
    child.kill("SIGTERM");
  }, timeoutSec * 1000);

  const { code, signal } = await new Promise((resolve) => {
    child.on("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });

  clearTimeout(timer);

  const runtimeMs = Date.now() - started;
  const sawFailedToStart = /Failed to start server/i.test(stdout + stderr);
  const sawEperm = /(EPERM|EACCES|listen)/i.test(stdout + stderr);

  console.log("[web-debug] summary");
  console.log(
    JSON.stringify(
      {
        code,
        signal,
        timedOut,
        runtimeMs,
        sawFailedToStart,
        sawEperm
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[web-debug] fatal: ${message}`);
  process.exit(1);
});
