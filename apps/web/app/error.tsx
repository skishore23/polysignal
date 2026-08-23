"use client";

import { useEffect } from "react";

type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function Error({ error, reset }: ErrorProps) {
  useEffect(() => {
    // Log error to console in development, could send to error tracking service in production
    if (process.env.NODE_ENV === "development") {
      console.error("App error:", error);
    }
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-card/30 border border-border/40 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
          <h2 className="text-lg font-bold tracking-tight text-foreground">
            SYSTEM ERROR
          </h2>
        </div>
        <p className="text-sm text-muted-foreground font-mono">
          An unexpected error occurred. The system will attempt to recover.
        </p>
        {error.digest && (
          <p className="text-[10px] text-muted-foreground/60 font-mono">
            Error ID: {error.digest}
          </p>
        )}
        <button
          onClick={reset}
          className="w-full px-4 py-2 bg-secondary/80 border border-border/50 text-foreground text-sm font-mono uppercase tracking-widest hover:bg-secondary transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
