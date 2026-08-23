export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export type SSEClientConfig = {
  url: string;
  onMessage: (data: unknown) => void;
  onStateChange?: (state: ConnectionState) => void;
  onError?: (error: Error) => void;
  heartbeatTimeoutMs?: number;
  maxReconnectDelayMs?: number;
  initialReconnectDelayMs?: number;
};
