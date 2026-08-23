export class TimeSeriesBuffer {
  private readonly maxLen: number;
  private ts: number[] = [];
  private values: number[] = [];

  constructor(maxLen: number) {
    this.maxLen = maxLen;
  }

  push(ts: number, value: number): void {
    this.ts.push(ts);
    this.values.push(value);
    if (this.ts.length > this.maxLen) {
      this.ts.shift();
      this.values.shift();
    }
  }

  latest(): { ts: number; value: number } | null {
    if (!this.ts.length) return null;
    const idx = this.ts.length - 1;
    const ts = this.ts[idx];
    const value = this.values[idx];
    if (ts == null || value == null) return null;
    return { ts, value };
  }

  valueAtOrBefore(targetTs: number): number | null {
    for (let i = this.ts.length - 1; i >= 0; i -= 1) {
      const ts = this.ts[i];
      const value = this.values[i];
      if (ts == null || value == null) continue;
      if (ts <= targetTs) return value;
    }
    return null;
  }

  valuesSince(targetTs: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.ts.length; i += 1) {
      const ts = this.ts[i];
      const value = this.values[i];
      if (ts == null || value == null) continue;
      if (ts >= targetTs) out.push(value);
    }
    return out;
  }

  pointsSince(targetTs: number): { ts: number; value: number }[] {
    const out: { ts: number; value: number }[] = [];
    for (let i = 0; i < this.ts.length; i += 1) {
      const ts = this.ts[i];
      const value = this.values[i];
      if (ts == null || value == null) continue;
      if (ts >= targetTs) out.push({ ts, value });
    }
    return out;
  }

  size(): number {
    return this.ts.length;
  }
}
