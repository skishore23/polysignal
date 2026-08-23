import { sleep } from "@polysignal/utils";
import type { Logger } from "../logger";

export type TaskHandler = () => Promise<void>;

export interface TaskSchedulerOptions {
    name: string;
    intervalMs: number;
    logger: Logger;
    onError?: (err: unknown) => void;
}

/**
 * A robust scheduler that executes a task at a specified interval,
 * ensuring no overlap between executions (wait for completion before next delay).
 */
export class TaskScheduler {
    private running = false;
    private stopping = false;
    private timeoutId: NodeJS.Timeout | null = null;
    private readonly name: string;
    private readonly intervalMs: number;
    private readonly logger: Logger;
    private readonly handler: TaskHandler;
    private readonly onError: ((err: unknown) => void) | undefined;

    constructor(handler: TaskHandler, options: TaskSchedulerOptions) {
        this.handler = handler;
        this.name = options.name;
        this.intervalMs = options.intervalMs;
        this.logger = options.logger;
        this.onError = options.onError;
    }

    public start(): void {
        if (this.running) return;
        this.running = true;
        this.stopping = false;
        this.logger.info({ task: this.name }, "Task scheduler started");
        void this.loop();
    }

    public stop(): void {
        this.logger.info({ task: this.name }, "Task scheduler stopping...");
        this.stopping = true;
        this.running = false;
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
    }

    private async loop(): Promise<void> {
        while (this.running && !this.stopping) {
            const start = Date.now();
            try {
                await this.handler();
            } catch (err) {
                this.logger.error({ err, task: this.name }, "Task execution failed");
                if (this.onError) {
                    try {
                        this.onError(err);
                    } catch (handlerErr) {
                        this.logger.error({ err: handlerErr, task: this.name }, "Error handler failed");
                    }
                }
            }

            if (this.stopping) break;

            const elapsed = Date.now() - start;
            const delay = Math.max(0, this.intervalMs - elapsed); // Aim for fixed cadence, or strict delay? 
            // User request said "Wait for previous execution to finish before scheduling the next delay"
            // So let's do simple delay AFTER execution to prevent overlap.
            // If we want fixed interval, we'd subtract elapsed. But to be safest:
            await sleep(this.intervalMs);
        }
        this.logger.info({ task: this.name }, "Task scheduler stopped");
    }
}
