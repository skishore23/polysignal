import type { ConnectionState, SSEClientConfig } from "./types";

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30000;
const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1000;

export class SSEClient {
  private es: EventSource | null = null;
  private state: ConnectionState = "disconnected";
  private reconnectDelay: number;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly heartbeatTimeoutMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly initialReconnectDelayMs: number;

  constructor(private readonly config: SSEClientConfig) {
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.maxReconnectDelayMs = config.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.initialReconnectDelayMs = config.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS;
    this.reconnectDelay = this.initialReconnectDelayMs;
  }

  connect(): void {
    if (this.disposed) return;
    this.clearTimers();
    this.setState("connecting");

    this.es = new EventSource(this.config.url);

    this.es.onopen = () => {
      if (this.disposed) return;
      this.setState("connected");
      this.reconnectDelay = this.initialReconnectDelayMs;
      this.resetHeartbeat();
    };

    this.es.onmessage = (ev) => {
      if (this.disposed) return;
      this.resetHeartbeat();

      // Skip ping events - they're just for keepalive
      if (ev.data === "{}" || ev.data.trim() === "") return;

      try {
        const data = JSON.parse(ev.data);
        this.config.onMessage(data);
      } catch (err) {
        this.config.onError?.(new Error(`Failed to parse SSE message: ${String(err)}`));
      }
    };

    this.es.onerror = () => {
      if (this.disposed) return;
      this.closeConnection();
      this.scheduleReconnect();
    };
  }

  disconnect(): void {
    this.disposed = true;
    this.clearTimers();
    this.closeConnection();
    this.setState("disconnected");
  }

  getState(): ConnectionState {
    return this.state;
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.config.onStateChange?.(state);
  }

  private closeConnection(): void {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private resetHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }
    this.heartbeatTimer = setTimeout(() => {
      this.handleHeartbeatTimeout();
    }, this.heartbeatTimeoutMs);
  }

  private handleHeartbeatTimeout(): void {
    if (this.disposed) return;
    this.closeConnection();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.setState("reconnecting");

    this.reconnectTimer = setTimeout(() => {
      if (this.disposed) return;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelayMs);
  }
}
