import type { Logger } from "../logger";

export type LoopStatus =
  | "idle"
  | "starting"
  | "running"
  | "stale"
  | "recovering"
  | "error"
  | "stopped";

export type LoopHealthInfo = {
  state: LoopStatus;
  reason?: string;
  updatedAt: number;
};

export type LoopHealthMap = Record<string, LoopHealthInfo>;

export class LoopTracker {
  private current: LoopHealthInfo;

  constructor(
    private readonly name: string,
    private readonly healthMap: LoopHealthMap,
    private readonly logger: Logger
  ) {
    const now = Date.now();
    this.current = { state: "idle", updatedAt: now };
    this.healthMap[this.name] = { ...this.current };
  }

  private update(state: LoopStatus, reason?: string): void {
    const now = Date.now();
    if (this.current.state === state && this.current.reason === reason) {
      this.current = { ...this.current, updatedAt: now };
      this.healthMap[this.name] = { ...this.current };
      return;
    }
    this.current = { state, reason, updatedAt: now };
    this.healthMap[this.name] = { ...this.current };
    this.logger.info({ loop: this.name, state, reason }, "Loop state change");
  }

  public markStarting(reason?: string): void {
    this.update("starting", reason);
  }

  public markRunning(reason?: string): void {
    this.update("running", reason);
  }

  public markStale(reason?: string): void {
    this.update("stale", reason);
  }

  public markRecovering(reason?: string): void {
    this.update("recovering", reason);
  }

  public markError(reason?: string): void {
    this.update("error", reason);
  }

  public markStopped(reason?: string): void {
    this.update("stopped", reason);
  }

  public getState(): LoopHealthInfo {
    return { ...this.current };
  }
}
