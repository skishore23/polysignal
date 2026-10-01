import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTempDb, destroyTempDb, type TempDb } from '../helpers/db-temp';
import { postAccountingEvent } from '../../packages/storage/src/accounting';

const state = vi.hoisted(() => ({ sqlite: undefined as Database.Database | undefined }));
vi.mock('../../apps/web/lib/db', () => ({ getDb: () => ({ sqlite: state.sqlite }) }));
import { GET, POST } from '../../apps/web/app/api/accounting-report/route';

let db: TempDb;
beforeAll(async () => {
  db = await createTempDb();
  state.sqlite = db.sqlite;
  postAccountingEvent(db.sqlite, {
    eventKey: 'opening',
    accountKey: 'wallet:7',
    kind: 'OPENING',
    source: 'api-fixture',
    sourceRef: 'opening',
    eventTs: 1000,
    receiptTs: 1000,
    processingOrder: 0,
    finality: 'SIMULATED',
    cashDelta: 100,
    feeEvidence: 'NOT_APPLICABLE',
    ruleVersion: 'fixture-v1',
    roundingPolicy: 'exact',
    collateralAsset: 'USDC',
  });
});
afterAll(async () => {
  await destroyTempDb(db);
});

it('generates, freezes and retrieves the same paper report', async () => {
  const live = await GET(
    new Request('http://localhost/api/accounting-report?walletId=7&valuationTs=1000'),
  );
  expect(live.status).toBe(200);
  const report = await live.json();
  expect(report).toMatchObject({
    accountKey: 'wallet:7',
    cash: 100,
    complete: true,
    netPnl: 0,
    scope: 'paper-shadow',
  });
  const saved = await POST(
    new Request('http://localhost/api/accounting-report', {
      method: 'POST',
      body: JSON.stringify({ walletId: 7, valuationTs: 1000 }),
    }),
  );
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual(report);
  const retrieved = await GET(
    new Request(`http://localhost/api/accounting-report?reportId=${report.reportId}`),
  );
  expect(retrieved.status).toBe(200);
  expect(await retrieved.json()).toEqual(report);
  expect(
    (await GET(new Request('http://localhost/api/accounting-report?reportId=absent'))).status,
  ).toBe(404);
});

it('rejects malformed or coerced scope values', async () => {
  for (const body of [
    null,
    {},
    { walletId: 7, valuationTs: null },
    { walletId: 7, valuationTs: false },
    { walletId: 7, valuationTs: '' },
    { walletId: -1, valuationTs: 1000 },
  ]) {
    expect(
      (
        await POST(
          new Request('http://localhost/api/accounting-report', {
            method: 'POST',
            body: JSON.stringify(body),
          }),
        )
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await POST(
        new Request('http://localhost/api/accounting-report', { method: 'POST', body: 'not-json' }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await GET(new Request('http://localhost/api/accounting-report?walletId=7&valuationTs=')))
      .status,
  ).toBe(400);
});
