import { spawn } from "node:child_process";
import path from "node:path";
import type Database from "better-sqlite3";
import { reconcileShadowOrderDecisionRefs } from "@polysignal/storage";
import type { Logger } from "./logger";
import type { VerificationConfig } from "./config";

type VerificationDeps = {
  repoRoot: string;
  logger: Logger;
  sqlite: Database.Database;
};

type ScriptResult = {
  ok: boolean;
  code: number | null;
  output: string;
};

type InvariantScript = {
  label: string;
  scriptPath: string;
  args?: string[];
  required?: boolean;
};

function getTsxPath(repoRoot: string): string {
  const bin = process.platform === "win32" ? "tsx.cmd" : "tsx";
  return path.join(repoRoot, "node_modules", ".bin", bin);
}

function runScript(
  repoRoot: string,
  scriptPath: string,
  args: string[],
  logger: Logger,
  label: string
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const tsxPath = getTsxPath(repoRoot);
    const child = spawn(tsxPath, [scriptPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, REPO_ROOT: repoRoot },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("close", (code) => {
      const ok = code === 0;
      if (ok) {
        logger.info({ label }, "Verification passed");
      } else {
        const lines = output
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-12);
        logger.error({ label, code, output: lines }, "Verification failed");
      }
      resolve({ ok, code, output });
    });
  });
}

export async function runStartupVerification(
  config: VerificationConfig,
  deps: VerificationDeps
): Promise<void> {
  if (!config.startup.enabled) return;

  const reconciled = reconcileShadowOrderDecisionRefs(deps.sqlite);
  if (reconciled > 0) {
    deps.logger.info({ reconciled }, "Reconciled shadow_orders decision linkage invariants");
  }

  if (config.marketData.cleanupNullFeatures) {
    const cleanupSummary = cleanupInvalidFeatures(
      deps.sqlite,
      config.marketData.cleanupBatchSize,
      config.marketData.cleanupMaxBatches
    );
    if (cleanupSummary.deletedFeatures > 0 || cleanupSummary.deletedLatest > 0) {
      deps.logger.warn(
        cleanupSummary,
        "Startup cleanup removed invalid feature rows (NULL mid/spread)"
      );
    }
  }

  const realismRequired = config.realism.enforcement === "hard";
  const startupScripts: InvariantScript[] = [
    {
      label: "startup:no-signal-schema",
      scriptPath: path.join(deps.repoRoot, "scripts", "invariants", "no-signal-schema.ts"),
      required: true
    },
    {
      label: "startup:runtime-liveness",
      scriptPath: path.join(deps.repoRoot, "scripts", "invariants", "runtime-liveness.ts"),
      args: ["--feed-max-age-sec", "120"],
      required: realismRequired && config.realism.requireRuntimeLiveness
    },
    {
      label: "startup:decision-chain-integrity",
      scriptPath: path.join(deps.repoRoot, "scripts", "invariants", "decision-chain-integrity.ts"),
      required: true
    },
    {
      label: "startup:decision-log-append-only",
      scriptPath: path.join(deps.repoRoot, "scripts", "invariants", "decision-log-append-only.ts"),
      args: ["--allow-empty-rebase"],
      required: false
    },
    {
      label: "startup:maker-real-fill-activity",
      scriptPath: path.join(deps.repoRoot, "scripts", "invariants", "maker-real-fill-activity.ts"),
      args: [
        "--window-hours",
        "24",
        "--min-fill-rate",
        String(config.realism.makerRealFillRateMin),
        "--min-real-fills",
        String(config.realism.makerRealFillsPerDayMin)
      ],
      required: realismRequired
    },
    {
      label: "startup:taker-close-balance",
      scriptPath: path.join(deps.repoRoot, "scripts", "invariants", "taker-close-balance.ts"),
      args: [
        "--window-hours",
        "24",
        "--min-close-ratio",
        String(config.realism.takerCloseRatioMin),
        "--max-one-sided",
        String(config.realism.takerOneSidedMax)
      ],
      required: realismRequired
    }
  ];
  const scriptsToRun =
    config.startup.quick
      ? startupScripts.filter((entry) => (entry.required ?? true))
      : startupScripts;
  deps.logger.info(
    { quick: config.startup.quick, scripts: scriptsToRun.map((entry) => entry.label) },
    "Running startup verification (decision-only invariants)"
  );
  const failed = await runInvariantScripts(deps.repoRoot, deps.logger, scriptsToRun);
  if (failed && config.startup.hardFail) {
    throw new Error("Startup verification failed");
  }
}

export function startVerificationLoop(
  config: VerificationConfig,
  deps: VerificationDeps
): () => void {
  if (!config.background.enabled) {
    return () => {};
  }

  const intervalMs = Math.max(60_000, config.background.intervalMinutes * 60_000);
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      if (config.marketData.cleanupNullFeatures) {
        const cleanupSummary = cleanupInvalidFeatures(
          deps.sqlite,
          config.marketData.cleanupBatchSize,
          1
        );
        if (cleanupSummary.deletedFeatures > 0 || cleanupSummary.deletedLatest > 0) {
          deps.logger.warn(
            cleanupSummary,
            "Background cleanup removed invalid feature rows (NULL mid/spread)"
          );
        }
      }
      const realismRequired = config.realism.enforcement === "hard";
      const backgroundScripts: InvariantScript[] = [
        {
          label: "background:decision-chain-integrity",
          scriptPath: path.join(deps.repoRoot, "scripts", "invariants", "decision-chain-integrity.ts"),
          required: true
        },
        {
          label: "background:decisionedge-contract",
          scriptPath: path.join(deps.repoRoot, "scripts", "invariants", "decisionedge-contract.ts"),
          args: ["--window-min", "60"],
          required: false
        },
        {
          label: "background:maker-real-fill-activity",
          scriptPath: path.join(deps.repoRoot, "scripts", "invariants", "maker-real-fill-activity.ts"),
          args: [
            "--window-hours",
            "24",
            "--min-fill-rate",
            String(config.realism.makerRealFillRateMin),
            "--min-real-fills",
            String(config.realism.makerRealFillsPerDayMin)
          ],
          required: realismRequired
        },
        {
          label: "background:taker-close-balance",
          scriptPath: path.join(deps.repoRoot, "scripts", "invariants", "taker-close-balance.ts"),
          args: [
            "--window-hours",
            "24",
            "--min-close-ratio",
            String(config.realism.takerCloseRatioMin),
            "--max-one-sided",
            String(config.realism.takerOneSidedMax)
          ],
          required: realismRequired
        },
        {
          label: "background:runtime-liveness",
          scriptPath: path.join(deps.repoRoot, "scripts", "invariants", "runtime-liveness.ts"),
          args: ["--feed-max-age-sec", "120"],
          required: realismRequired && config.realism.requireRuntimeLiveness
        }
      ];
      const failed = await runInvariantScripts(deps.repoRoot, deps.logger, backgroundScripts);
      if (failed && config.background.hardFail) {
        deps.logger.fatal(
          { intervalMinutes: config.background.intervalMinutes },
          "Background verification failed with hardFail=true; exiting process"
        );
        process.exit(1);
      }
    } finally {
      running = false;
    }
  };

  const timeoutId = setTimeout(tick, 60_000);
  const intervalId = setInterval(tick, intervalMs);

  deps.logger.info(
    { intervalMinutes: config.background.intervalMinutes },
    "Verification loop started"
  );

  return () => {
    clearTimeout(timeoutId);
    clearInterval(intervalId);
    deps.logger.info("Verification loop stopped");
  };
}

async function runInvariantScripts(
  repoRoot: string,
  logger: Logger,
  scripts: InvariantScript[]
): Promise<boolean> {
  let failed = false;
  for (const script of scripts) {
    const result = await runScript(
      repoRoot,
      script.scriptPath,
      script.args ?? [],
      logger,
      script.label
    );
    if (!result.ok && (script.required ?? true)) {
      failed = true;
    }
  }
  return failed;
}

function cleanupInvalidFeatures(
  sqlite: Database.Database,
  batchSize: number,
  maxBatches: number
): { deletedFeatures: number; deletedLatest: number; batches: number } {
  const limit = Math.max(1000, batchSize || 10000);
  const batches = Math.max(1, maxBatches || 1);
  let deletedFeatures = 0;

  const deleteFeaturesStmt = sqlite.prepare(
    `DELETE FROM features
     WHERE id IN (
       SELECT id FROM features
       WHERE mid IS NULL OR spread IS NULL
       LIMIT ?
     )`
  );
  const deleteLatestStmt = sqlite.prepare(
    `DELETE FROM latest_features WHERE mid IS NULL OR spread IS NULL`
  );

  for (let i = 0; i < batches; i += 1) {
    const res = deleteFeaturesStmt.run(limit);
    deletedFeatures += res.changes;
    if (res.changes === 0) break;
  }

  const latestRes = deleteLatestStmt.run();

  return {
    deletedFeatures,
    deletedLatest: latestRes.changes,
    batches: Math.min(batches, deletedFeatures === 0 ? 1 : batches)
  };
}
