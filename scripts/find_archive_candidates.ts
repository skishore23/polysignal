import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

type RefEvidence = {
  file: string;
  line: number;
  text: string;
};

type ScriptCandidate = {
  path: string;
  referencedByPackageScripts: boolean;
  referencedByWorker: RefEvidence[];
  referencedElsewhere: RefEvidence[];
  runtimeCritical: boolean;
  archiveEligible: boolean;
};

type ConfigCandidate = {
  path: string;
  referencedByPackageScripts: boolean;
  referencedByWorker: RefEvidence[];
  referencedByWeb: RefEvidence[];
  runtimeCritical: boolean;
  archiveEligible: boolean;
};

type DocCandidate = {
  path: string;
  referencedByAnchors: RefEvidence[];
  unlinked: boolean;
  archiveEligible: boolean;
};

type ScanResult = {
  generatedAt: string;
  rules: {
    runtimeCriticalSignals: string[];
    docsUnlinkedRule: string;
  };
  summary: {
    scripts: { total: number; archiveEligible: number };
    configs: { total: number; archiveEligible: number };
    docs: { total: number; archiveEligible: number };
  };
  candidates: {
    scripts: ScriptCandidate[];
    configs: ConfigCandidate[];
    docs: DocCandidate[];
  };
};

const repoRoot = process.cwd();
const baselineDir = path.join(repoRoot, "reports", "refactor-baseline");
const outJsonPath = path.join(baselineDir, "archive_candidates.json");
const outMdPath = path.join(baselineDir, "archive_cleanup_plan.md");

function normalizeRel(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function toRel(absOrRel: string): string {
  if (path.isAbsolute(absOrRel)) {
    return normalizeRel(path.relative(repoRoot, absOrRel));
  }
  return normalizeRel(absOrRel);
}

function readUtf8(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf-8");
}

function collectRefs(patterns: string[], targetFiles: string[]): RefEvidence[] {
  const hits: RefEvidence[] = [];
  for (const file of targetFiles) {
    const abs = path.join(repoRoot, file);
    if (!statSafe(abs)?.isFile()) continue;
    const lines = readFileSync(abs, "utf-8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (patterns.some((p) => line.includes(p))) {
        hits.push({ file, line: i + 1, text: line.trim() });
      }
    }
  }
  return hits;
}

function statSafe(target: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

function listTopLevelFiles(relDir: string, extensions: string[]): string[] {
  const dirAbs = path.join(repoRoot, relDir);
  const out: string[] = [];
  for (const entry of readdirSync(dirAbs)) {
    const rel = normalizeRel(path.join(relDir, entry));
    const abs = path.join(repoRoot, rel);
    const st = statSafe(abs);
    if (!st?.isFile()) continue;
    if (extensions.length > 0 && !extensions.some((ext) => rel.endsWith(ext))) continue;
    out.push(rel);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function listDocsRootMd(): string[] {
  return listTopLevelFiles("docs", [".md"]).filter((f) => !f.startsWith("docs/archive/"));
}

function stableStringify(input: unknown): string {
  return JSON.stringify(input, null, 2) + "\n";
}

function main(): void {
  const packageJson = JSON.parse(readUtf8("package.json")) as { scripts?: Record<string, string> };
  const packageScriptsText = JSON.stringify(packageJson.scripts ?? {}, null, 2);

  const workerFiles: string[] = [];
  const webFiles: string[] = [];

  const workerRoot = path.join(repoRoot, "apps", "worker", "src");
  const webRoot = path.join(repoRoot, "apps", "web");

  const walk = (dirAbs: string, out: string[]): void => {
    for (const entry of readdirSync(dirAbs)) {
      const abs = path.join(dirAbs, entry);
      const st = statSafe(abs);
      if (!st) continue;
      if (st.isDirectory()) {
        walk(abs, out);
        continue;
      }
      if (!st.isFile()) continue;
      if (!/\.(ts|tsx|js|mjs|json|md|sh)$/.test(entry)) continue;
      out.push(toRel(abs));
    }
  };

  walk(workerRoot, workerFiles);
  walk(webRoot, webFiles);

  const scriptsTop = listTopLevelFiles("scripts", [".ts", ".js", ".mjs", ".sh"])
    .filter((f) => !f.startsWith("scripts/archive/"))
    .filter((f) => !f.startsWith("scripts/lib/"));

  const scriptCandidates: ScriptCandidate[] = scriptsTop.map((file) => {
    const base = path.basename(file);
    const patterns = [file, base];
    const referencedByPackageScripts = patterns.some((p) => packageScriptsText.includes(p));
    const referencedByWorker = collectRefs(patterns, workerFiles).filter((ref) => !ref.file.endsWith(file));
    const broadFiles = [
      "README.md",
      "agent.md",
      "skills.md",
      ...listDocsRootMd(),
      ...webFiles,
      ...listTopLevelFiles("scripts", [".ts", ".js", ".mjs", ".sh"])
    ].filter((f, idx, arr) => arr.indexOf(f) === idx && f !== file);
    const referencedElsewhere = collectRefs(patterns, broadFiles);

    const runtimeCritical = referencedByPackageScripts || referencedByWorker.length > 0;

    return {
      path: file,
      referencedByPackageScripts,
      referencedByWorker,
      referencedElsewhere,
      runtimeCritical,
      archiveEligible: !runtimeCritical
    };
  });

  const configCandidates: ConfigCandidate[] = listTopLevelFiles("configs", [".json"]).map((file) => {
    const base = path.basename(file);
    const patterns = [file, base];
    const referencedByPackageScripts = patterns.some((p) => packageScriptsText.includes(p));
    const referencedByWorker = collectRefs(patterns, workerFiles);
    const referencedByWeb = collectRefs(patterns, webFiles);
    const runtimeCritical = referencedByPackageScripts || referencedByWorker.length > 0;
    const hasAnyRef = runtimeCritical || referencedByWeb.length > 0;
    return {
      path: file,
      referencedByPackageScripts,
      referencedByWorker,
      referencedByWeb,
      runtimeCritical,
      archiveEligible: !hasAnyRef
    };
  });

  const docsTop = listDocsRootMd();
  const anchorFiles = docsTop
    .filter((d) => !d.startsWith("docs/archive/"))
    .concat(["README.md", "agent.md", "skills.md"]);

  const docCandidates: DocCandidate[] = docsTop.map((docPath) => {
    const base = path.basename(docPath);
    const patterns = [docPath, base];
    const refs = collectRefs(
      patterns,
      anchorFiles.filter((f, idx, arr) => arr.indexOf(f) === idx && f !== docPath)
    );
    const unlinked = refs.length === 0;
    return {
      path: docPath,
      referencedByAnchors: refs,
      unlinked,
      archiveEligible: unlinked
    };
  });

  const result: ScanResult = {
    generatedAt: new Date().toISOString(),
    rules: {
      runtimeCriticalSignals: [
        "Referenced by package.json scripts",
        "Referenced by apps/worker/src/**"
      ],
      docsUnlinkedRule:
        "Eligible if zero references from README.md, agent.md, skills.md, and non-archive docs/*.md"
    },
    summary: {
      scripts: {
        total: scriptCandidates.length,
        archiveEligible: scriptCandidates.filter((x) => x.archiveEligible).length
      },
      configs: {
        total: configCandidates.length,
        archiveEligible: configCandidates.filter((x) => x.archiveEligible).length
      },
      docs: {
        total: docCandidates.length,
        archiveEligible: docCandidates.filter((x) => x.archiveEligible).length
      }
    },
    candidates: {
      scripts: scriptCandidates,
      configs: configCandidates,
      docs: docCandidates
    }
  };

  mkdirSync(baselineDir, { recursive: true });
  writeFileSync(outJsonPath, stableStringify(result), "utf-8");

  const scriptEligible = scriptCandidates.filter((x) => x.archiveEligible).map((x) => `- \`${x.path}\``);
  const configEligible = configCandidates.filter((x) => x.archiveEligible).map((x) => `- \`${x.path}\``);
  const docEligible = docCandidates.filter((x) => x.archiveEligible).map((x) => `- \`${x.path}\``);

  const md = [
    "# Archive Cleanup Candidates",
    "",
    `Generated: ${result.generatedAt}`,
    "",
    "## Rules",
    "- Runtime-critical if referenced by package scripts or worker source.",
    "- Docs eligible when unlinked from README/agent/skills/non-archive docs.",
    "",
    "## Summary",
    `- Scripts: ${result.summary.scripts.archiveEligible}/${result.summary.scripts.total} archive-eligible`,
    `- Configs: ${result.summary.configs.archiveEligible}/${result.summary.configs.total} archive-eligible`,
    `- Docs: ${result.summary.docs.archiveEligible}/${result.summary.docs.total} archive-eligible`,
    "",
    "## Script Candidates",
    ...(scriptEligible.length > 0 ? scriptEligible : ["- None"]),
    "",
    "## Config Candidates",
    ...(configEligible.length > 0 ? configEligible : ["- None"]),
    "",
    "## Doc Candidates",
    ...(docEligible.length > 0 ? docEligible : ["- None"]),
    ""
  ].join("\n");

  writeFileSync(outMdPath, md, "utf-8");

  process.stdout.write(`Wrote ${toRel(outJsonPath)}\n`);
  process.stdout.write(`Wrote ${toRel(outMdPath)}\n`);
}

main();
