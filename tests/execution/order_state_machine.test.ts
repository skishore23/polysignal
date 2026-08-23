import { describe, expect, it } from "vitest";
import {
  canTransitionOrderStatus,
  isActiveOrderStatus,
  isTerminalOrderStatus,
  normalizeOrderStatus
} from "../../apps/worker/src/execution/orderStateMachine.js";

describe("orderStateMachine", () => {
  it("normalizes only canonical statuses", () => {
    expect(normalizeOrderStatus("open")).toBe("OPEN");
    expect(normalizeOrderStatus("FILLED")).toBe("FILLED");
    expect(normalizeOrderStatus("matched")).toBeNull();
    expect(normalizeOrderStatus(null)).toBeNull();
  });

  it("enforces monotonic lifecycle transitions", () => {
    expect(canTransitionOrderStatus("OPEN", "PARTIAL")).toBe(true);
    expect(canTransitionOrderStatus("PARTIAL", "FILLED")).toBe(true);
    expect(canTransitionOrderStatus("FILLED", "OPEN")).toBe(false);
    expect(canTransitionOrderStatus("CANCELLED", "FILLED")).toBe(false);
  });

  it("marks terminal statuses as non-active", () => {
    expect(isTerminalOrderStatus("FILLED")).toBe(true);
    expect(isTerminalOrderStatus("CANCELLED")).toBe(true);
    expect(isActiveOrderStatus("OPEN")).toBe(true);
    expect(isActiveOrderStatus("PARTIAL")).toBe(true);
    expect(isActiveOrderStatus("REJECTED")).toBe(false);
  });
});
