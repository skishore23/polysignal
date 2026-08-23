export type CanonicalOrderStatus =
  | "PENDING"
  | "OPEN"
  | "PARTIAL"
  | "FILLED"
  | "CANCELLED"
  | "REJECTED";

const ORDER_STATUSES: ReadonlySet<CanonicalOrderStatus> = new Set([
  "PENDING",
  "OPEN",
  "PARTIAL",
  "FILLED",
  "CANCELLED",
  "REJECTED"
]);

const TERMINAL_STATUSES: ReadonlySet<CanonicalOrderStatus> = new Set([
  "FILLED",
  "CANCELLED",
  "REJECTED"
]);

const ALLOWED_TRANSITIONS: Readonly<Record<CanonicalOrderStatus, ReadonlySet<CanonicalOrderStatus>>> = {
  PENDING: new Set(["PENDING", "OPEN", "PARTIAL", "FILLED", "CANCELLED", "REJECTED"]),
  OPEN: new Set(["OPEN", "PARTIAL", "FILLED", "CANCELLED", "REJECTED"]),
  PARTIAL: new Set(["PARTIAL", "FILLED", "CANCELLED"]),
  FILLED: new Set(["FILLED"]),
  CANCELLED: new Set(["CANCELLED"]),
  REJECTED: new Set(["REJECTED"])
};

export const normalizeOrderStatus = (value: unknown): CanonicalOrderStatus | null => {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toUpperCase();
  return ORDER_STATUSES.has(candidate as CanonicalOrderStatus)
    ? (candidate as CanonicalOrderStatus)
    : null;
};

export const isTerminalOrderStatus = (status: CanonicalOrderStatus): boolean =>
  TERMINAL_STATUSES.has(status);

export const isActiveOrderStatus = (status: CanonicalOrderStatus | null): boolean =>
  status == null || !isTerminalOrderStatus(status);

export const canTransitionOrderStatus = (
  from: CanonicalOrderStatus | null,
  to: CanonicalOrderStatus
): boolean => {
  if (from == null) return true;
  return ALLOWED_TRANSITIONS[from].has(to);
};
