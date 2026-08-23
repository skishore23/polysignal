#!/usr/bin/env tsx

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

type EdgeKind = "import" | "re_export";

type ImportEdge = {
  from: string;
  to: string;
  specifier: string;
  kind: EdgeKind;
};

type GraphOutput = {
  generatedAt: string;
  scope: string[];
  entrypoints: string[];
  stats: {
    files: number;
    edges: number;
    reachableFromEntrypoints: number;
    unreachableFromEntrypoints: number;
  };
  nodes: string[];
  edges: ImportEdge[];
};

type SourceExports = {
  file: string;
  named: Set<string>;
  hasDefault: boolean;
  hasStarReexport: boolean;
};

const repoRoot = process.cwd();
const outDir = path.join(repoRoot, "reports", "refactor-baseline");
mkdirSync(outDir, { recursive: true });

const toRel = (filePath: string): string => path.relative(repoRoot, filePath).replaceAll("\\", "/");

const prodFile = (filePath: string): boolean => {
  const rel = toRel(filePath);
  if (!rel.endsWith(".ts")) return false;
  if (rel.endsWith(".d.ts")) return false;
  if (rel.includes("/dist/")) return false;
  if (rel.includes("/tests/")) return false;
  if (rel.includes("/test/")) return false;
  if (rel.endsWith(".test.ts")) return false;
  if (rel.endsWith(".spec.ts")) return false;
  return true;
};

const parseJson = (filePath: string): unknown => JSON.parse(readFileSync(filePath, "utf8"));

const readRootReferences = (): string[] => {
  const rootTsconfig = parseJson(path.join(repoRoot, "tsconfig.json")) as {
    references?: Array<{ path?: string }>;
  };
  return (rootTsconfig.references ?? [])
    .map((r) => r.path)
    .filter((p): p is string => typeof p === "string");
};

const allowedScopePrefixes = [
  "apps/worker",
  "packages/book",
  "packages/data",
  "packages/features",
  "packages/storage",
  "packages/types",
  "packages/utils"
];

const inScope = (relPath: string): boolean => allowedScopePrefixes.some((prefix) => relPath.startsWith(prefix));

const projectConfigs = readRootReferences()
  .filter((ref) => inScope(ref))
  .map((ref) => path.join(repoRoot, ref, "tsconfig.json"));

const baseOptions = ts.parseJsonConfigFileContent(
  ts.parseConfigFileTextToJson(
    path.join(repoRoot, "tsconfig.base.json"),
    readFileSync(path.join(repoRoot, "tsconfig.base.json"), "utf8")
  ).config,
  ts.sys,
  repoRoot
).options;

const fileSet = new Set<string>();
for (const configPath of projectConfigs) {
  const parsed = ts.parseJsonConfigFileContent(
    ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, "utf8")).config,
    ts.sys,
    path.dirname(configPath)
  );
  for (const file of parsed.fileNames) {
    const abs = path.resolve(file);
    if (prodFile(abs) && inScope(toRel(abs))) {
      fileSet.add(abs);
    }
  }
}

const sourceExports = new Map<string, SourceExports>();
const importGraph = new Map<string, ImportEdge[]>();
const reverseGraph = new Map<string, Set<string>>();

for (const file of fileSet) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges: ImportEdge[] = [];
  const exportsInfo: SourceExports = {
    file,
    named: new Set<string>(),
    hasDefault: false,
    hasStarReexport: false
  };

  const addReverse = (to: string, from: string): void => {
    const existing = reverseGraph.get(to) ?? new Set<string>();
    existing.add(from);
    reverseGraph.set(to, existing);
  };

  const addEdge = (specifier: string, kind: EdgeKind): void => {
    const resolved = ts.resolveModuleName(specifier, file, baseOptions, ts.sys).resolvedModule;
    if (!resolved) return;
    let resolvedFile = path.resolve(resolved.resolvedFileName);
    if (resolvedFile.endsWith(".d.ts")) {
      const asTs = resolvedFile.replace(/\.d\.ts$/, ".ts");
      if (fileSet.has(asTs)) resolvedFile = asTs;
    }
    if (!fileSet.has(resolvedFile)) return;
    edges.push({
      from: toRel(file),
      to: toRel(resolvedFile),
      specifier,
      kind
    });
    addReverse(resolvedFile, file);
  };

  source.forEachChild((node) => {
    if (ts.isImportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        addEdge(node.moduleSpecifier.text, "import");
      }
      return;
    }

    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        addEdge(node.moduleSpecifier.text, "re_export");
      }
      if (!node.exportClause) {
        exportsInfo.hasStarReexport = true;
      } else if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exportsInfo.named.add(element.name.text);
        }
      }
      return;
    }

    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      const isExported = Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
      const isDefault = Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
      if (!isExported || !node.name) return;
      if (isDefault) exportsInfo.hasDefault = true;
      exportsInfo.named.add(node.name.text);
      return;
    }

    if (ts.isVariableStatement(node)) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      const isExported = Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
      const isDefault = Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
      if (!isExported) return;
      if (isDefault) exportsInfo.hasDefault = true;
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) exportsInfo.named.add(decl.name.text);
      }
    }
  });

  sourceExports.set(file, exportsInfo);
  importGraph.set(file, edges);
}

const defaultEntrypoints = [
  "apps/worker/src/index.ts",
  "apps/worker/src/main.ts",
  "apps/worker/src/tools/replayTick.ts",
  "apps/worker/src/mockFeed.ts"
]
  .map((p) => path.join(repoRoot, p))
  .filter((p) => fileSet.has(p));

const reachable = new Set<string>();
const stack = [...defaultEntrypoints];
while (stack.length > 0) {
  const current = stack.pop();
  if (!current || reachable.has(current)) continue;
  reachable.add(current);
  for (const edge of importGraph.get(current) ?? []) {
    const next = path.join(repoRoot, edge.to);
    if (!reachable.has(next)) stack.push(next);
  }
}

const unreachable = Array.from(fileSet)
  .filter((f) => !reachable.has(f))
  .sort((a, b) => toRel(a).localeCompare(toRel(b)));

const allEdges = Array.from(importGraph.values()).flat();
const allNodes = Array.from(fileSet).map(toRel).sort();

const probableDeadBarrels = Array.from(fileSet)
  .filter((f) => path.basename(f) === "index.ts")
  .filter((f) => {
    const info = sourceExports.get(f);
    if (!info) return false;
    const hasOnlyReexports = info.hasStarReexport || info.named.size > 0;
    const inbound = reverseGraph.get(f)?.size ?? 0;
    return hasOnlyReexports && inbound === 0 && !reachable.has(f);
  })
  .map(toRel)
  .sort();

const duplicateUtilities = (() => {
  const byName = new Map<string, string[]>();
  for (const file of fileSet) {
    const rel = toRel(file);
    if (!rel.includes("/utils/")) continue;
    const name = path.basename(rel);
    const list = byName.get(name) ?? [];
    list.push(rel);
    byName.set(name, list);
  }
  return Array.from(byName.entries())
    .filter(([, files]) => files.length > 1)
    .map(([name, files]) => ({ name, files: files.sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
})();

const importedNamedByFile = new Map<string, Set<string>>();
for (const file of fileSet) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!node.moduleSpecifier || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
    const resolved = ts.resolveModuleName(node.moduleSpecifier.text, file, baseOptions, ts.sys).resolvedModule;
    if (!resolved) return;
    let resolvedFile = path.resolve(resolved.resolvedFileName);
    if (resolvedFile.endsWith(".d.ts")) {
      const asTs = resolvedFile.replace(/\.d\.ts$/, ".ts");
      if (fileSet.has(asTs)) resolvedFile = asTs;
    }
    if (!fileSet.has(resolvedFile)) return;
    if (!node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) return;
    const imported = importedNamedByFile.get(resolvedFile) ?? new Set<string>();
    for (const element of node.importClause.namedBindings.elements) {
      imported.add(element.propertyName?.text ?? element.name.text);
    }
    importedNamedByFile.set(resolvedFile, imported);
  });
}

const unusedExportHints = Array.from(sourceExports.entries())
  .flatMap(([file, exp]) => {
    const imported = importedNamedByFile.get(file) ?? new Set<string>();
    const hints = Array.from(exp.named)
      .filter((name) => !imported.has(name))
      .sort();
    if (hints.length === 0) return [];
    return [{ file: toRel(file), unused: hints }];
  })
  .sort((a, b) => a.file.localeCompare(b.file));

const cycles: string[][] = [];
const temp = new Set<string>();
const perm = new Set<string>();
const dfsStack: string[] = [];
const dfs = (file: string): void => {
  if (perm.has(file)) return;
  if (temp.has(file)) {
    const idx = dfsStack.indexOf(file);
    if (idx >= 0) cycles.push(dfsStack.slice(idx).concat(file).map(toRel));
    return;
  }
  temp.add(file);
  dfsStack.push(file);
  for (const edge of importGraph.get(file) ?? []) {
    dfs(path.join(repoRoot, edge.to));
  }
  dfsStack.pop();
  temp.delete(file);
  perm.add(file);
};
for (const file of fileSet) {
  dfs(file);
}

const graphOutput: GraphOutput = {
  generatedAt: new Date().toISOString(),
  scope: allowedScopePrefixes,
  entrypoints: defaultEntrypoints.map(toRel),
  stats: {
    files: fileSet.size,
    edges: allEdges.length,
    reachableFromEntrypoints: reachable.size,
    unreachableFromEntrypoints: unreachable.length
  },
  nodes: allNodes,
  edges: allEdges
};

writeFileSync(path.join(outDir, "import_graph.json"), `${JSON.stringify(graphOutput, null, 2)}\n`, "utf8");
writeFileSync(
  path.join(outDir, "reachable_from_worker_entrypoints.txt"),
  `${Array.from(reachable).map(toRel).sort().join("\n")}\n`,
  "utf8"
);
writeFileSync(path.join(outDir, "unreachable_ts_files.txt"), `${unreachable.map(toRel).join("\n")}\n`, "utf8");
writeFileSync(
  path.join(outDir, "probably_dead_barrels.txt"),
  `${probableDeadBarrels.join("\n")}${probableDeadBarrels.length ? "\n" : ""}`,
  "utf8"
);
writeFileSync(
  path.join(outDir, "circular_deps.txt"),
  cycles.length
    ? `${cycles.map((cycle, i) => `cycle_${i + 1}: ${cycle.join(" -> ")}`).join("\n")}\n`
    : "none\n",
  "utf8"
);
writeFileSync(
  path.join(outDir, "duplicate_utilities.txt"),
  duplicateUtilities.length
    ? `${duplicateUtilities.map((entry) => `${entry.name}: ${entry.files.join(", ")}`).join("\n")}\n`
    : "none\n",
  "utf8"
);
writeFileSync(
  path.join(outDir, "unused_export_hints.txt"),
  unusedExportHints.length
    ? `${unusedExportHints
        .map((entry) => `${entry.file}: ${entry.unused.join(", ")}`)
        .join("\n")}\n`
    : "none\n",
  "utf8"
);

console.log(
  `[analyze_import_graph] files=${fileSet.size} edges=${allEdges.length} reachable=${reachable.size} unreachable=${unreachable.length}`
);
