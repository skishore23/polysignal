import path from "node:path";
import { existsSync } from "node:fs";
import { openDatabase } from "@polysignal/storage";

const cwd = process.cwd();
const looksLikeRepoRoot = (p: string): boolean =>
  existsSync(path.join(p, "package.json")) && existsSync(path.join(p, "apps", "web"));

// Next runtime usually runs from apps/web (repo root is cwd/../..), while scripts run from repo root.
const inferredRepoRoot = (() => {
  if (looksLikeRepoRoot(cwd)) return cwd;
  const candidate = path.resolve(cwd, "..", "..");
  if (looksLikeRepoRoot(candidate)) return candidate;
  return cwd;
})();

const repoRoot =
  process.env.REPO_ROOT != null && process.env.REPO_ROOT !== ""
    ? path.resolve(process.env.REPO_ROOT)
    : inferredRepoRoot;

const dbPath =
  process.env.DB_PATH != null && process.env.DB_PATH !== ""
    ? path.isAbsolute(process.env.DB_PATH)
      ? process.env.DB_PATH
      : path.join(repoRoot, process.env.DB_PATH)
    : path.join(repoRoot, "data", "dev.db");

let cached:
  | {
      sqlite: ReturnType<typeof openDatabase>["sqlite"];
      db: ReturnType<typeof openDatabase>["db"];
    }
  | null = null;

// Migrations are run separately via `scripts/migrate.ts` before app starts.
// This avoids lock contention between web and worker processes.
const initDb = (): void => {
  if (cached) return;
  cached = openDatabase(dbPath);
};

export function getDb(): {
  sqlite: ReturnType<typeof openDatabase>["sqlite"];
  db: ReturnType<typeof openDatabase>["db"];
} {
  if (!cached) {
    initDb();
  }
  if (!cached) {
    throw new Error(`DB init failed: openDatabase(${dbPath}) returned no handle`);
  }
  return cached;
}

