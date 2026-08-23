import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: unknown[]) {
  return twMerge(clsx(inputs));
}

export function formatPct(value: number | null, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "-";
  return `${(value * 100).toFixed(digits)}%`;
}

const defaultNumberFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 6
});

export function formatNum(value: number | null, digits?: number): string {
  if (value == null || Number.isNaN(value)) return "-";
  if (digits != null) {
    const clamp = Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value;
    return clamp.toFixed(digits);
  }
  const clamp = Math.abs(value) < 0.5 * 10 ** -6 ? 0 : value;
  return defaultNumberFormat.format(clamp);
}
