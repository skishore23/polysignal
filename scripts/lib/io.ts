import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function ensureDir(dirPath: string): string {
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function stableJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (input == null) return input;
    if (Array.isArray(input)) return input.map((item) => normalize(item));
    if (typeof input !== "object") return input;
    if (seen.has(input as object)) return "[Circular]";
    seen.add(input as object);
    const entries = Object.entries(input as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, normalize(val)]);
    return Object.fromEntries(entries);
  };
  return JSON.stringify(normalize(value), null, 2);
}

export function writeJsonFile(filePath: string, value: unknown): string {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, stableJsonStringify(value) + "\n", "utf-8");
  return filePath;
}

function csvEscape(value: unknown): string {
  if (value == null) return "";
  const raw = String(value);
  if (!/[",\n]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, "\"\"")}"`;
}

export function writeCsvFile(
  filePath: string,
  rows: Array<Record<string, unknown>>,
  headers?: string[]
): string {
  ensureDir(path.dirname(filePath));
  const cols =
    headers && headers.length > 0
      ? [...headers]
      : Array.from(
          new Set(
            rows.flatMap((row) => Object.keys(row))
          )
        ).sort((a, b) => a.localeCompare(b));

  const lines: string[] = [];
  lines.push(cols.map((col) => csvEscape(col)).join(","));
  for (const row of rows) {
    const line = cols.map((col) => csvEscape(row[col])).join(",");
    lines.push(line);
  }

  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  return filePath;
}

export type ScriptOutputOptions = {
  json: boolean;
  outDir?: string;
  outFileName?: string;
};

export function emitScriptOutput(
  payload: unknown,
  textLines: string[],
  options: ScriptOutputOptions
): { outFile: string | null } {
  let outFile: string | null = null;
  if (options.outDir && options.outDir !== "") {
    ensureDir(options.outDir);
    const fileName = options.outFileName ?? "output.json";
    outFile = writeJsonFile(path.join(options.outDir, fileName), payload);
  }

  if (options.json) {
    process.stdout.write(stableJsonStringify(payload) + "\n");
  } else {
    process.stdout.write(textLines.join("\n") + "\n");
    if (outFile) {
      process.stdout.write(`[out] ${outFile}\n`);
    }
  }

  return { outFile };
}

