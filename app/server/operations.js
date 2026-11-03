import { SCHEMA_VERSION } from "./db.js";

const reconciliationTables = [
  "direct_executions",
  "direct_lifecycle_actions",
  "direct_archive_actions",
  "direct_moderation_actions",
  "direct_resume_actions",
  "direct_budget_actions",
  "direct_ab_actions",
  "direct_ab_decision_actions",
  "optimizer_actions",
];

function count(db, sql, ...parameters) {
  return Number(db.prepare(sql).get(...parameters)?.count || 0);
}

export function operationalSnapshot(db, now = Date.now()) {
  db.prepare("SELECT 1").get();
  const schemaVersion = Number(
      db.prepare("SELECT MAX(version) AS version FROM schema_version").get()
        ?.version || 0,
    ),
    pending = count(
      db,
      "SELECT COUNT(*) AS count FROM jobs WHERE status='pending'",
    ),
    ready = count(
      db,
      "SELECT COUNT(*) AS count FROM jobs WHERE status='pending' AND available_at<=?",
      now,
    ),
    running = count(
      db,
      "SELECT COUNT(*) AS count FROM jobs WHERE status='running'",
    ),
    stale = count(
      db,
      "SELECT COUNT(*) AS count FROM jobs WHERE status='running' AND available_at<=?",
      now,
    ),
    failed = count(
      db,
      "SELECT COUNT(*) AS count FROM jobs WHERE status='failed'",
    ),
    reconciliationRequired = reconciliationTables.reduce(
      (total, table) =>
        total +
        count(
          db,
          `SELECT COUNT(*) AS count FROM ${table} WHERE status='needs_reconciliation'`,
        ),
      0,
    ),
    schemaReady = schemaVersion === SCHEMA_VERSION;
  return {
    ok: schemaReady,
    ready: schemaReady,
    degraded: stale > 0 || reconciliationRequired > 0,
    database: { schemaVersion, expectedSchemaVersion: SCHEMA_VERSION },
    queues: { pending, ready, running, stale, failed },
    reconciliation: { required: reconciliationRequired },
  };
}

export function operationalExitCode(snapshot) {
  if (!snapshot?.ready) return 1;
  return snapshot.degraded ? 2 : 0;
}
