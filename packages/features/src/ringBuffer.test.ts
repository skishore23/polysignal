import { describe, expect, it } from "vitest";
import { TimeSeriesBuffer } from "./ringBuffer";

describe("TimeSeriesBuffer", () => {
  it("returns value at or before timestamp", () => {
    const buf = new TimeSeriesBuffer(5);
    buf.push(1000, 1);
    buf.push(2000, 2);
    buf.push(3000, 3);

    expect(buf.valueAtOrBefore(2500)).toBe(2);
    expect(buf.valueAtOrBefore(3000)).toBe(3);
    expect(buf.valueAtOrBefore(500)).toBeNull();
  });

  it("returns points since timestamp", () => {
    const buf = new TimeSeriesBuffer(5);
    buf.push(1000, 1);
    buf.push(2000, 2);
    buf.push(3000, 3);

    const points = buf.pointsSince(2000);
    expect(points).toEqual([
      { ts: 2000, value: 2 },
      { ts: 3000, value: 3 }
    ]);
  });
});
