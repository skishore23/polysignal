import { getDb } from "../../../lib/db";
import { experimentRuns, desc } from "@polysignal/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function runId(ts: number, gitHash: string | null): string {
  const iso = new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
  const hash = (gitHash ?? "doc").slice(0, 7);
  return `${iso}_${hash}`;
}

export type LedgerEntry = {
  id: number;
  runId: string;
  ts: number;
  gitHash: string | null;
  hypothesis: string;
  scope: string | null;
  confidence: string | null;
  paramsJson: string | null;
  resultsJson: string | null;
  verdict: string;
  nextAction: string | null;
  notes: string | null;
  runContextJson: string | null;
};

export async function GET(): Promise<Response> {
  const { db } = getDb();
  const rows = db
    .select()
    .from(experimentRuns)
    .orderBy(desc(experimentRuns.ts))
    .all();

  const entries: LedgerEntry[] = rows.map((row) => ({
    id: row.id,
    runId: runId(row.ts, row.gitHash),
    ts: row.ts,
    gitHash: row.gitHash ?? null,
    hypothesis: row.hypothesis,
    scope: row.scope ?? null,
    confidence: row.confidence ?? null,
    paramsJson: row.paramsJson ?? null,
    resultsJson: row.resultsJson ?? null,
    verdict: row.verdict,
    nextAction: row.nextAction ?? null,
    notes: row.notes ?? null,
    runContextJson: row.runContextJson ?? null
  }));

  return Response.json({ entries });
}
