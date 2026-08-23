import path from "node:path";
import { spawn } from "node:child_process";
import type { Logger } from "../logger";
import { getRepoRoot } from "../config";
import { TaskScheduler } from "../utils/TaskScheduler";

export type RegimeReportConfig = {
  enabled: boolean;
  intervalMs: number;
  hours: number;
  horizonMs: number;
  bins: number;
  stepMs: number;
  sampleLimit: number;
  features: string[];
  outputDir: string;
  /** Skip writing regime files until at least this many fills in the window. */
  minFillsToWrite: number;
  /** Winsorization clip for markout std/se fields. */
  winsorClipBps: number;
};

type RegimeReportDeps = {
  sqlite: any;
  logger: Logger;
};

export class RegimeReportLoop {
  private readonly config: RegimeReportConfig;
  private readonly deps: RegimeReportDeps;
  private readonly scheduler: TaskScheduler;
  private inFlight = false;

  constructor(config: RegimeReportConfig, deps: RegimeReportDeps) {
    this.config = config;
    this.deps = deps;
    this.scheduler = new TaskScheduler(() => this.tick(), {
      name: "RegimeReportLoop",
      intervalMs: Math.max(30_000, this.config.intervalMs),
      logger: this.deps.logger
    });
  }

  public start(): void {
    if (!this.config.enabled) {
      this.deps.logger.info("RegimeReportLoop disabled");
      return;
    }
    this.deps.logger.info("Starting RegimeReportLoop...");
    this.scheduler.start();
  }

  public stop(): void {
    this.scheduler.stop();
  }

  private tail(text: string, maxLines = 12): string[] {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-maxLines)
  }

  private async tick(): Promise<void> {
    if (!this.config.enabled) return;
    if (this.inFlight) {
      this.deps.logger.warn("RegimeReportLoop tick skipped: previous refresh still running");
      return;
    }
    this.inFlight = true;
    const started = Date.now();

    try {
      const result = await this.runRefreshProcess();
      const durationMs = Date.now() - started;
      const output = this.tail(result.output);
      if (result.code === 0) {
        this.deps.logger.info(
          { durationMs, output },
          "Regime reports updated"
        );
      } else {
        this.deps.logger.error(
          { durationMs, code: result.code, signal: result.signal, output },
          "RegimeReportLoop failed"
        );
      }
    } catch (err) {
      this.deps.logger.error({ err }, "RegimeReportLoop failed");
    } finally {
      this.inFlight = false;
    }
  }

  private async runRefreshProcess(): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    output: string;
  }> {
    const repoRoot = getRepoRoot();
    const tsxBin = process.platform === "win32" ? "tsx.cmd" : "tsx";
    const tsxPath = path.join(repoRoot, "node_modules", ".bin", tsxBin);
    const scriptPath = path.join(repoRoot, "scripts", "regime-report-refresh.ts");
    const args = [
      scriptPath,
      "--hours", String(Math.max(1, this.config.hours)),
      "--horizon-ms", String(Math.max(1_000, this.config.horizonMs)),
      "--bins", String(Math.max(2, this.config.bins)),
      "--step-ms", String(Math.max(100, this.config.stepMs)),
      "--sample-limit", String(Math.max(1_000, this.config.sampleLimit)),
      "--features", this.config.features.join(","),
      "--output-dir", this.config.outputDir,
      "--min-fills", String(Math.max(0, this.config.minFillsToWrite)),
      "--winsor-clip-bps", String(this.config.winsorClipBps)
    ];
    const timeoutMs = Math.max(60_000, Math.min(15 * 60_000, this.config.intervalMs * 3));

    return await new Promise((resolve) => {
      const child = spawn(tsxPath, args, {
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

      const timer = setTimeout(() => {
        output += `\n[regime-report-loop] timeout_ms=${timeoutMs}`;
        child.kill("SIGTERM");
      }, timeoutMs);
      timer.unref();

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          code: null,
          signal: null,
          output: `${output}\n${err instanceof Error ? err.message : String(err)}`
        });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, output });
      });
    });
  }
}
