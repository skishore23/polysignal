import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(): pino.Logger {
  const transport = process.env.NODE_ENV !== "production"
    ? pino.transport({
      target: "pino-pretty",
      options: { colorize: true }
    })
    : undefined;

  return pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      base: { service: "polysignal-worker" }
    },
    transport,
  );
}
