/**
 * Evidence-first, category-theory-inspired audit utilities.
 *
 * Audits are composable morphisms: they map (db, context) -> violations.
 * - identityAudit is the identity morphism (returns no violations).
 * - composeAudits provides associative composition via concatenation.
 */

import type Database from "better-sqlite3";

export type AuditContext = {
  sinceTs?: number;
  epsilon?: number;
};

export type AuditViolationCode =
  | "FILL_ORPHAN"
  | "FILL_INVALID"
  | "TAKER_PRICE_MISMATCH"
  | "TAKER_SIZE_MISMATCH"
  | "ORDER_DECISION_GROUP_MISSING"
  | "ORDER_DECISION_LOG_MISSING";

export type AuditViolation = {
  code: AuditViolationCode;
  entity: "shadow_fills" | "shadow_orders" | "decision_log";
  message: string;
  walletId?: number | null;
  orderId?: number | null;
  fillId?: number | null;
  decisionGroupId?: string | null;
  expected?: number | string | null;
  actual?: number | string | null;
};

export type AuditFn = (db: Database.Database, ctx?: AuditContext) => AuditViolation[];

export const identityAudit: AuditFn = () => [];

export const composeAudits =
  (...audits: AuditFn[]): AuditFn =>
  (db, ctx) =>
    audits.flatMap((audit) => audit(db, ctx));

const tableExists = (db: Database.Database, name: string): boolean => {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return row !== undefined;
};

export const auditShadowFillIntegrity: AuditFn = (db, ctx) => {
  if (!tableExists(db, "shadow_fills") || !tableExists(db, "shadow_orders")) return [];
  const epsilon = ctx?.epsilon ?? 1e-9;
  const params: Record<string, number> = {};
  const sinceClause = ctx?.sinceTs ? "WHERE f.ts >= @sinceTs" : "";
  if (ctx?.sinceTs) params.sinceTs = ctx.sinceTs;

  const rows = db
    .prepare(
      `SELECT
         f.id as fillId,
         f.order_id as orderId,
         f.price as fillPrice,
         f.size as fillSize,
         o.id as orderExists,
         o.wallet_id as walletId,
         o.kind as kind,
         o.price as orderPrice,
         o.size as orderSize
       FROM shadow_fills f
       LEFT JOIN shadow_orders o ON o.id = f.order_id
       ${sinceClause}`
    )
    .all(params) as Array<{
    fillId: number;
    orderId: number;
    fillPrice: number | null;
    fillSize: number | null;
    orderExists: number | null;
    walletId: number | null;
    kind: string | null;
    orderPrice: number | null;
    orderSize: number | null;
  }>;

  const violations: AuditViolation[] = [];

  for (const row of rows) {
    if (!row.orderExists) {
      violations.push({
        code: "FILL_ORPHAN",
        entity: "shadow_fills",
        walletId: row.walletId ?? null,
        orderId: row.orderId,
        fillId: row.fillId,
        message: "Fill references missing shadow_orders row."
      });
      continue;
    }

    if (!Number.isFinite(row.fillPrice ?? NaN) || !Number.isFinite(row.fillSize ?? NaN)) {
      violations.push({
        code: "FILL_INVALID",
        entity: "shadow_fills",
        walletId: row.walletId ?? null,
        orderId: row.orderId,
        fillId: row.fillId,
        message: "Fill has invalid price or size.",
        expected: "> 0",
        actual: `${row.fillPrice}/${row.fillSize}`
      });
      continue;
    }

    if ((row.fillPrice ?? 0) <= 0 || (row.fillSize ?? 0) <= 0) {
      violations.push({
        code: "FILL_INVALID",
        entity: "shadow_fills",
        walletId: row.walletId ?? null,
        orderId: row.orderId,
        fillId: row.fillId,
        message: "Fill price and size must be positive.",
        expected: "> 0",
        actual: `${row.fillPrice}/${row.fillSize}`
      });
    }

    if (row.kind === "TAKER_BUY" || row.kind === "TAKER_SELL") {
      if (row.orderPrice != null && row.fillPrice != null) {
        const diff = Math.abs(row.fillPrice - row.orderPrice);
        if (diff > epsilon) {
          violations.push({
            code: "TAKER_PRICE_MISMATCH",
            entity: "shadow_fills",
            walletId: row.walletId ?? null,
            orderId: row.orderId,
            fillId: row.fillId,
            message: "Taker fill price deviates from order price.",
            expected: row.orderPrice,
            actual: row.fillPrice
          });
        }
      }

      if (row.orderSize != null && row.fillSize != null && row.fillSize - row.orderSize > epsilon) {
        violations.push({
          code: "TAKER_SIZE_MISMATCH",
          entity: "shadow_fills",
          walletId: row.walletId ?? null,
          orderId: row.orderId,
          fillId: row.fillId,
          message: "Taker fill size exceeds order size.",
          expected: row.orderSize,
          actual: row.fillSize
        });
      }
    }
  }

  return violations;
};

export const auditDecisionLinkIntegrity: AuditFn = (db, ctx) => {
  if (!tableExists(db, "shadow_orders") || !tableExists(db, "decision_log")) return [];
  const params: Record<string, number> = {};
  const sinceClause = ctx?.sinceTs ? "AND o.ts >= @sinceTs" : "";
  if (ctx?.sinceTs) params.sinceTs = ctx.sinceTs;

  const rows = db
    .prepare(
      `SELECT o.id as orderId, o.wallet_id as walletId, o.decision_group_id as decisionGroupId
       FROM shadow_orders o
       WHERE o.kind IN ('TAKER_BUY','TAKER_SELL','MAKER_BID','MAKER_ASK')
       ${sinceClause}`
    )
    .all(params) as Array<{
    orderId: number;
    walletId: number | null;
    decisionGroupId: string | null;
  }>;

  const decisionStmt = db.prepare(
    `SELECT id
     FROM decision_log
     WHERE decision_group_id = ?
     LIMIT 1`
  );

  const violations: AuditViolation[] = [];
  for (const row of rows) {
    if (row.decisionGroupId == null || row.decisionGroupId.trim() === "") {
      violations.push({
        code: "ORDER_DECISION_GROUP_MISSING",
        entity: "shadow_orders",
        walletId: row.walletId ?? null,
        orderId: row.orderId,
        decisionGroupId: row.decisionGroupId,
        message: "shadow_orders row has no decision_group_id."
      });
      continue;
    }

    const linked = decisionStmt.get(row.decisionGroupId) as { id: number } | undefined;
    if (!linked) {
      violations.push({
        code: "ORDER_DECISION_LOG_MISSING",
        entity: "decision_log",
        walletId: row.walletId ?? null,
        orderId: row.orderId,
        decisionGroupId: row.decisionGroupId,
        message: "shadow_orders.decision_group_id has no corresponding decision_log row."
      });
    }
  }
  return violations;
};
