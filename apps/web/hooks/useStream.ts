"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { SSEClient } from "../lib/sse/client";
import type { ConnectionState } from "../lib/sse/types";

export type UseStreamOptions<T> = {
  url: string;
  enabled?: boolean;
  transform?: (raw: unknown) => T;
  onMessage?: (data: T) => void;
};

export type UseStreamResult<T> = {
  data: T | null;
  connectionState: ConnectionState;
  error: Error | null;
  reconnect: () => void;
};

export function useStream<T>(options: UseStreamOptions<T>): UseStreamResult<T> {
  const { url, enabled = true, transform, onMessage } = options;

  const [data, setData] = useState<T | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<Error | null>(null);
  const clientRef = useRef<SSEClient | null>(null);

  const handleMessage = useCallback(
    (raw: unknown) => {
      const transformed = transform ? transform(raw) : (raw as T);
      setData(transformed);
      setError(null);
      onMessage?.(transformed);
    },
    [transform, onMessage],
  );

  useEffect(() => {
    if (!enabled) {
      setConnectionState("disconnected");
      return;
    }

    const client = new SSEClient({
      url,
      onMessage: handleMessage,
      onStateChange: setConnectionState,
      onError: setError,
    });

    clientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [url, enabled, handleMessage]);

  const reconnect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.disconnect();
    }
    const client = new SSEClient({
      url,
      onMessage: handleMessage,
      onStateChange: setConnectionState,
      onError: setError,
    });
    clientRef.current = client;
    client.connect();
  }, [url, handleMessage]);

  return { data, connectionState, error, reconnect };
}
