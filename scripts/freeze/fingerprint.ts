#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { boolArg, parseCliArgs, resolveRepoRoot, stringArg } from "../lib/db.js";

type FreezeManifest = {
  version: number;
  paths: string[];
};

type FileFingerprint = {
  path: string;
  sha256: string;
  sizeBytes: number;
};

type FreezeBaseline = {
  version: number;
  generatedAtIso: string;
  manifestPath: string;
  fingerprintSha256: string;
  files: FileFingerprint[];
};

const sha256 = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");

const toAbs = (repoRoot: string, maybeRelative: string): string =>
  path.isAbsolute(maybeRelative) ? maybeRelative : path.join(repoRoot, maybeRelative);

const args = parseCliArgs();
const repoRoot = resolveRepoRoot();
const manifestPath = toAbs(repoRoot, stringArg(args, "manifest", "configs/freeze-manifest.json"));
const baselinePath = toAbs(repoRoot, stringArg(args, "baseline", "data/freeze/fingerprint.baseline.json"));
const writeMode = boolArg(args, "write", false);

if (!existsSync(manifestPath)) {
  console.error(`[freeze:fingerprint] FAIL missing manifest path=${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as FreezeManifest;
if (!manifest || !Array.isArray(manifest.paths) || manifest.paths.length === 0) {
  console.error(`[freeze:fingerprint] FAIL invalid manifest path=${manifestPath}`);
  process.exit(1);
}

const files: FileFingerprint[] = [];
for (const relPath of manifest.paths) {
  const absPath = toAbs(repoRoot, relPath);
  if (!existsSync(absPath)) {
    console.error(`[freeze:fingerprint] FAIL missing file in manifest path=${relPath}`);
    process.exit(1);
  }
  const buf = readFileSync(absPath);
  files.push({
    path: relPath,
    sha256: sha256(buf),
    sizeBytes: buf.length
  });
}

const digest = createHash("sha256");
for (const file of files) {
  digest.update(`${file.path}|${file.sha256}|${file.sizeBytes}\n`);
}
const fingerprintSha256 = digest.digest("hex");

const current: FreezeBaseline = {
  version: 1,
  generatedAtIso: new Date().toISOString(),
  manifestPath: path.relative(repoRoot, manifestPath),
  fingerprintSha256,
  files
};

if (writeMode) {
  mkdirSync(path.dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, "utf-8");
  console.log(`[freeze:fingerprint] PASS wrote baseline=${baselinePath} fingerprint=${fingerprintSha256}`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error(`[freeze:fingerprint] FAIL missing baseline path=${baselinePath}`);
  console.error("  - run with --write once to initialize baseline");
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as FreezeBaseline;
if (baseline.fingerprintSha256 !== current.fingerprintSha256) {
  const prev = new Map<string, string>((baseline.files ?? []).map((file) => [file.path, file.sha256]));
  const changed: string[] = [];
  for (const file of current.files) {
    const prevHash = prev.get(file.path);
    if (prevHash == null) {
      changed.push(`added:${file.path}`);
    } else if (prevHash !== file.sha256) {
      changed.push(`modified:${file.path}`);
    }
  }
  for (const file of baseline.files ?? []) {
    if (!current.files.some((entry) => entry.path === file.path)) {
      changed.push(`removed:${file.path}`);
    }
  }
  console.error(`[freeze:fingerprint] FAIL baseline=${baselinePath}`);
  console.error(`  - expected=${baseline.fingerprintSha256}`);
  console.error(`  - actual=${current.fingerprintSha256}`);
  if (changed.length) {
    for (const entry of changed) {
      console.error(`  - ${entry}`);
    }
  }
  process.exit(1);
}

console.log(`[freeze:fingerprint] PASS baseline=${baselinePath} fingerprint=${current.fingerprintSha256}`);
