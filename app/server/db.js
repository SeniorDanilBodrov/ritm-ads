import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { PostgresSyncDatabase } from "./postgres-sync.js";

export const SCHEMA_VERSION = 31;

export function openDatabase(filename) {
  const postgres = /^postgres(?:ql)?:\/\//i.test(filename);
  if (!postgres && filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true });
  const db = postgres
    ? new PostgresSyncDatabase(filename, {
        ssl: process.env.POSTGRES_SSL !== "false",
      })
    : new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO schema_version VALUES(1);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, subject TEXT UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS businesses(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commands(business_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(business_id,key));
    CREATE TABLE IF NOT EXISTS connections(business_id TEXT NOT NULL REFERENCES businesses(id), provider TEXT NOT NULL, encrypted TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(business_id,provider));
    CREATE TABLE IF NOT EXISTS oauth_states(hash TEXT PRIMARY KEY, provider TEXT NOT NULL, session_hash TEXT NOT NULL, user_id TEXT, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), kind TEXT NOT NULL, status TEXT NOT NULL, available_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, error TEXT);
    CREATE INDEX IF NOT EXISTS events_business ON events(business_id,at);
    CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status,available_at);`);
  const version = db
    .prepare("SELECT MAX(version) AS version FROM schema_version")
    .get().version;
  if (version < 2) {
    transaction(db, () => {
      db.exec(
        "ALTER TABLE oauth_states ADD COLUMN business_id TEXT REFERENCES businesses(id)",
      );
      db.exec("INSERT INTO schema_version VALUES(2)");
    });
  }
  if (version < 3)
    transaction(db, () => {
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS jobs_shadow_active ON jobs(business_id) WHERE kind='shadow_analysis' AND status IN ('pending','running')",
      );
      db.exec("INSERT INTO schema_version VALUES(3)");
    });
  if (version < 4)
    transaction(db, () => {
      db.exec(`CREATE TABLE report_snapshots(
      id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
      scope TEXT NOT NULL,source TEXT NOT NULL,login TEXT NOT NULL,date_from TEXT NOT NULL,date_to TEXT NOT NULL,
      currency TEXT NOT NULL,include_vat INTEGER NOT NULL,received_at TEXT NOT NULL,request_id TEXT,
      raw_hash TEXT NOT NULL,raw_tsv TEXT NOT NULL,rows_json TEXT NOT NULL,totals_json TEXT NOT NULL,
      previous_id TEXT REFERENCES report_snapshots(id),comparison_json TEXT NOT NULL);
      CREATE INDEX report_business_scope ON report_snapshots(business_id,scope);
      CREATE UNIQUE INDEX jobs_report_active ON jobs(business_id) WHERE kind='report_sync' AND status IN ('pending','running');
      INSERT INTO schema_version VALUES(4);`);
    });
  if (version < 5)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_changes(
      id TEXT PRIMARY KEY REFERENCES jobs(id),business_id TEXT NOT NULL REFERENCES businesses(id),
      idempotency_key TEXT NOT NULL,mode TEXT NOT NULL,plan_json TEXT NOT NULL,commands_json TEXT NOT NULL,
      result_json TEXT,reconciliation_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(business_id,idempotency_key));
      CREATE INDEX direct_changes_business ON direct_changes(business_id,created_at);
      INSERT INTO schema_version VALUES(5);`);
    });
  if (version < 6)
    transaction(db, () => {
      const update = db.prepare(
        "UPDATE connections SET metadata=? WHERE business_id=? AND provider=?",
      );
      for (const row of db
        .prepare("SELECT business_id,provider,metadata FROM connections")
        .all()) {
        const metadata = JSON.parse(row.metadata);
        if (!metadata.connectionId)
          update.run(
            JSON.stringify({ ...metadata, connectionId: randomUUID() }),
            row.business_id,
            row.provider,
          );
      }
      db.exec("INSERT INTO schema_version VALUES(6)");
    });
  if (version < 7)
    transaction(db, () => {
      db.exec(`CREATE TABLE creative_assets(
      id TEXT PRIMARY KEY REFERENCES jobs(id),business_id TEXT NOT NULL REFERENCES businesses(id),
      idempotency_key TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,
      prompt TEXT NOT NULL,style TEXT NOT NULL,seed INTEGER NOT NULL,
      mime_type TEXT,storage_name TEXT,byte_size INTEGER,sha256 TEXT,metadata_json TEXT,
      approved_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(business_id,idempotency_key));
      CREATE INDEX creative_assets_business ON creative_assets(business_id,created_at);
      INSERT INTO schema_version VALUES(7);`);
    });
  if (version < 8)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_preflights(
      id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
      change_id TEXT NOT NULL REFERENCES direct_changes(id),
      idempotency_key TEXT NOT NULL,checked_at TEXT NOT NULL,report_json TEXT NOT NULL,
      UNIQUE(business_id,idempotency_key));
      CREATE INDEX direct_preflights_change ON direct_preflights(change_id,checked_at);
      INSERT INTO schema_version VALUES(8);`);
    });
  if (version < 9)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_approvals(
      change_id TEXT PRIMARY KEY REFERENCES direct_changes(id),
      business_id TEXT NOT NULL REFERENCES businesses(id),
      preflight_id TEXT NOT NULL REFERENCES direct_preflights(id),
      plan_fingerprint TEXT NOT NULL,connection_id TEXT NOT NULL,
      confirmed_at TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT);
      INSERT INTO schema_version VALUES(9);`);
    });
  if (version < 10)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_executions(
      change_id TEXT PRIMARY KEY REFERENCES direct_changes(id),
      business_id TEXT NOT NULL REFERENCES businesses(id),
      connection_id TEXT NOT NULL,plan_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,inflight_key TEXT,suspend_verified INTEGER NOT NULL DEFAULT 0,
      calls_json TEXT NOT NULL,started_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      error_code TEXT,reconciliation_json TEXT);
      CREATE INDEX direct_executions_business ON direct_executions(business_id,updated_at);
      CREATE UNIQUE INDEX direct_executions_active_business ON direct_executions(business_id)
        WHERE status IN ('running','needs_reconciliation');
      INSERT INTO schema_version VALUES(10);`);
    });
  if (version < 11)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_lifecycle_actions(
      id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
      change_id TEXT NOT NULL REFERENCES direct_changes(id),
      connection_id TEXT NOT NULL,campaign_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,
      before_state TEXT,after_state TEXT,write_attempted INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(business_id,idempotency_key));
      CREATE UNIQUE INDEX direct_lifecycle_active_campaign ON direct_lifecycle_actions(business_id,campaign_id)
        WHERE status IN ('checking','sending','needs_reconciliation');
      INSERT INTO schema_version VALUES(11);`);
    });
  if (version < 12)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_budget_checks(
      id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
      change_id TEXT NOT NULL REFERENCES direct_changes(id),
      connection_id TEXT NOT NULL,campaign_id INTEGER NOT NULL,
      checked_at TEXT NOT NULL,result_json TEXT NOT NULL);
      CREATE INDEX direct_budget_checks_change ON direct_budget_checks(change_id,checked_at);
      INSERT INTO schema_version VALUES(12);`);
    });
  if (version < 13)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_shadow_reviews(
      id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
      change_id TEXT NOT NULL REFERENCES direct_changes(id),
      connection_id TEXT NOT NULL,request_key TEXT NOT NULL,
      created_at TEXT NOT NULL,result_json TEXT NOT NULL,
      UNIQUE(business_id,request_key));
      CREATE INDEX direct_shadow_reviews_change ON direct_shadow_reviews(change_id,created_at);
      INSERT INTO schema_version VALUES(13);`);
    });
  if (version < 14)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_control_reviews(
      id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
      change_id TEXT NOT NULL REFERENCES direct_changes(id),
      connection_id TEXT NOT NULL,request_key TEXT NOT NULL,
      checked_at TEXT NOT NULL,result_json TEXT NOT NULL,
      UNIQUE(business_id,request_key));
      CREATE INDEX direct_control_reviews_change ON direct_control_reviews(change_id,checked_at);
      INSERT INTO schema_version VALUES(14);`);
    });
  if (version < 15)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_archive_actions(
      id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
      change_id TEXT NOT NULL REFERENCES direct_changes(id),
      connection_id TEXT NOT NULL,campaign_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,status TEXT NOT NULL,
      before_state TEXT,after_state TEXT,write_attempted INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(business_id,idempotency_key));
      CREATE UNIQUE INDEX direct_archive_active_campaign ON direct_archive_actions(business_id,campaign_id)
        WHERE status IN ('checking','sending','needs_reconciliation');
      CREATE INDEX direct_archive_change ON direct_archive_actions(change_id,created_at);
      INSERT INTO schema_version VALUES(15);`);
    });
  if (version < 16)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_ab_plans(
      id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
      change_id TEXT NOT NULL UNIQUE REFERENCES direct_changes(id),
      connection_id TEXT NOT NULL,campaign_id INTEGER NOT NULL,
      control_ad_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,plan_json TEXT NOT NULL,created_at TEXT NOT NULL,
      UNIQUE(business_id,idempotency_key));
      CREATE INDEX direct_ab_business ON direct_ab_plans(business_id,created_at);
      INSERT INTO schema_version VALUES(16);`);
    });
  if (version < 17)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_moderation_actions(
      id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
      change_id TEXT NOT NULL REFERENCES direct_changes(id),
      connection_id TEXT NOT NULL,campaign_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,ad_ids_json TEXT NOT NULL,
      status TEXT NOT NULL,write_attempted INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(business_id,idempotency_key));
      CREATE UNIQUE INDEX direct_moderation_active_campaign ON direct_moderation_actions(business_id,campaign_id)
        WHERE status IN ('checking','sending','needs_reconciliation');
      INSERT INTO schema_version VALUES(17);`);
    });
  if (version < 18)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_resume_actions(
      id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
      change_id TEXT NOT NULL REFERENCES direct_changes(id),
      connection_id TEXT NOT NULL,campaign_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,status TEXT NOT NULL,
      write_attempted INTEGER NOT NULL DEFAULT 0,error_code TEXT,
      before_state TEXT,after_state TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(business_id,idempotency_key));
      CREATE UNIQUE INDEX direct_resume_active_campaign ON direct_resume_actions(business_id,campaign_id)
        WHERE status IN ('checking','sending','needs_reconciliation');
      INSERT INTO schema_version VALUES(18);`);
    });
  if (version < 19)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_budget_actions(
      id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
      change_id TEXT NOT NULL REFERENCES direct_changes(id),
      connection_id TEXT NOT NULL,campaign_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,check_id TEXT NOT NULL,
      previous_limit INTEGER NOT NULL,requested_limit INTEGER NOT NULL,
      confirmed_limit INTEGER,status TEXT NOT NULL,
      write_attempted INTEGER NOT NULL DEFAULT 0,error_code TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(business_id,idempotency_key));
      CREATE UNIQUE INDEX direct_budget_action_active_campaign ON direct_budget_actions(business_id,campaign_id)
        WHERE status IN ('checking','sending','needs_reconciliation');
      CREATE INDEX direct_budget_action_change ON direct_budget_actions(change_id,created_at);
      INSERT INTO schema_version VALUES(19);`);
    });
  if (version < 20)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_ab_actions(
      id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
      plan_id TEXT NOT NULL REFERENCES direct_ab_plans(id),
      change_id TEXT NOT NULL REFERENCES direct_changes(id),
      connection_id TEXT NOT NULL,campaign_id INTEGER NOT NULL,ad_group_id INTEGER NOT NULL,
      control_ad_id TEXT NOT NULL,variant_ad_id TEXT,
      idempotency_key TEXT NOT NULL,status TEXT NOT NULL,
      write_attempted INTEGER NOT NULL DEFAULT 0,error_code TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(business_id,idempotency_key));
      CREATE UNIQUE INDEX direct_ab_action_active_plan ON direct_ab_actions(plan_id)
        WHERE status IN ('checking','sending','needs_reconciliation');
      CREATE INDEX direct_ab_action_change ON direct_ab_actions(change_id,created_at);
      INSERT INTO schema_version VALUES(20);`);
    });
  if (version < 21)
    transaction(db, () => {
      db.exec(`CREATE TABLE direct_ab_decision_actions(
      id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
      plan_id TEXT NOT NULL REFERENCES direct_ab_plans(id),
      change_id TEXT NOT NULL REFERENCES direct_changes(id),
      connection_id TEXT NOT NULL,campaign_id INTEGER NOT NULL,
      target_ad_id TEXT NOT NULL,operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,status TEXT NOT NULL,
      write_attempted INTEGER NOT NULL DEFAULT 0,error_code TEXT,
      before_state TEXT,after_state TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(business_id,idempotency_key));
      CREATE UNIQUE INDEX direct_ab_decision_active_plan ON direct_ab_decision_actions(plan_id)
        WHERE status IN ('checking','sending','needs_reconciliation');
      CREATE INDEX direct_ab_decision_change ON direct_ab_decision_actions(change_id,created_at);
      INSERT INTO schema_version VALUES(21);`);
    });
  if (version < 22)
    transaction(db, () => {
      db.exec(`ALTER TABLE creative_assets ADD COLUMN brief TEXT NOT NULL DEFAULT '';
      ALTER TABLE creative_assets ADD COLUMN goal TEXT NOT NULL DEFAULT 'leads';
      ALTER TABLE creative_assets ADD COLUMN format TEXT NOT NULL DEFAULT 'standard';
      ALTER TABLE creative_assets ADD COLUMN audience TEXT NOT NULL DEFAULT '';
      INSERT INTO schema_version VALUES(22);`);
    });
  if (version < 23)
    transaction(db, () => {
      db.exec(`ALTER TABLE creative_assets ADD COLUMN brand_placement TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE creative_assets ADD COLUMN company_name TEXT NOT NULL DEFAULT '';
      INSERT INTO schema_version VALUES(23);`);
    });
  if (version < 24)
    transaction(db, () => {
      db.exec(`ALTER TABLE creative_assets ADD COLUMN hook TEXT NOT NULL DEFAULT 'outcome';
      INSERT INTO schema_version VALUES(24);`);
    });
  if (version < 25)
    transaction(db, () => {
      db.exec(`ALTER TABLE report_snapshots ADD COLUMN metrica_json TEXT;
      INSERT INTO schema_version VALUES(25);`);
    });
  if (version < 26)
    transaction(db, () => {
      db.exec(`CREATE TABLE business_ad_lifecycle(
        business_id TEXT PRIMARY KEY REFERENCES businesses(id),
        status TEXT NOT NULL,change_id TEXT,reason TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO schema_version VALUES(26);`);
    });
  if (version < 27)
    transaction(db, () => {
      db.exec(`CREATE TABLE optimizer_actions(
        id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
        change_id TEXT NOT NULL,review_id TEXT NOT NULL UNIQUE,action TEXT NOT NULL,
        status TEXT NOT NULL,reason TEXT NOT NULL,guard_json TEXT NOT NULL,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE INDEX optimizer_actions_business ON optimizer_actions(business_id,created_at);
      INSERT INTO schema_version VALUES(27);`);
    });
  if (version < 28)
    transaction(db, () => {
      db.exec(`CREATE TABLE audience_experiments(
        id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),
        change_id TEXT NOT NULL,hypothesis TEXT NOT NULL,dimension TEXT NOT NULL,
        control_json TEXT NOT NULL,variant_json TEXT NOT NULL,
        criteria_json TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT,
        fingerprint TEXT NOT NULL,idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        UNIQUE(business_id,idempotency_key),UNIQUE(business_id,change_id)
      );
      CREATE TABLE audience_experiment_observations(
        id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL REFERENCES audience_experiments(id),
        snapshot_key TEXT NOT NULL,period_from TEXT NOT NULL,period_to TEXT NOT NULL,
        control_json TEXT NOT NULL,variant_json TEXT NOT NULL,
        source_json TEXT NOT NULL,observed_at TEXT NOT NULL,
        UNIQUE(experiment_id,snapshot_key)
      );
      CREATE INDEX audience_experiments_business ON audience_experiments(business_id,created_at);
      CREATE INDEX audience_observations_experiment ON audience_experiment_observations(experiment_id,observed_at);
      INSERT INTO schema_version VALUES(28);`);
    });
  if (version < 29)
    transaction(db, () => {
      db.exec(`ALTER TABLE direct_budget_actions ADD COLUMN rollback_key TEXT;
      ALTER TABLE direct_budget_actions ADD COLUMN rollback_status TEXT;
      ALTER TABLE direct_budget_actions ADD COLUMN rollback_write_attempted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE direct_budget_actions ADD COLUMN rollback_confirmed_limit INTEGER;
      ALTER TABLE direct_budget_actions ADD COLUMN rollback_error TEXT;
      ALTER TABLE direct_budget_actions ADD COLUMN rollback_updated_at TEXT;
      CREATE UNIQUE INDEX direct_budget_rollback_key
        ON direct_budget_actions(business_id,rollback_key) WHERE rollback_key IS NOT NULL;
      INSERT INTO schema_version VALUES(29);`);
    });
  if (version < 30)
    transaction(db, () => {
      db.exec(`CREATE TABLE campaign_ad_lifecycle(
        business_id TEXT NOT NULL REFERENCES businesses(id),
        change_id TEXT NOT NULL,
        status TEXT NOT NULL,reason TEXT NOT NULL,updated_at TEXT NOT NULL,
        PRIMARY KEY(business_id,change_id)
      );
      INSERT OR IGNORE INTO campaign_ad_lifecycle(business_id,change_id,status,reason,updated_at)
        SELECT business_id,change_id,status,reason,updated_at
        FROM business_ad_lifecycle WHERE change_id IS NOT NULL;
      CREATE INDEX campaign_ad_lifecycle_business ON campaign_ad_lifecycle(business_id,updated_at);
      INSERT INTO schema_version VALUES(30);`);
    });
  if (version < 31)
    transaction(db, () => {
      db.exec(`CREATE TABLE campaign_budget_allocations(
        business_id TEXT NOT NULL REFERENCES businesses(id),
        change_id TEXT NOT NULL,limit_kopecks INTEGER NOT NULL CHECK(limit_kopecks>0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(business_id,change_id)
      );
      INSERT OR IGNORE INTO campaign_budget_allocations(business_id,change_id,limit_kopecks,updated_at)
        SELECT dc.business_id,dc.id,json_extract(dc.plan_json,'$.budget'),dc.updated_at
        FROM direct_changes dc
        WHERE json_type(dc.plan_json,'$.budget')='integer'
          AND json_extract(dc.plan_json,'$.budget')>0;
      CREATE INDEX campaign_budget_allocations_business
        ON campaign_budget_allocations(business_id,updated_at);
      INSERT INTO schema_version VALUES(31);`);
    });
  return db;
}

export function transaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = action();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export class AppError extends Error {
  constructor(status, message, code = "invalid_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requireBusiness(db, userId, id) {
  const row = id
    ? db
        .prepare("SELECT * FROM businesses WHERE id=? AND user_id=?")
        .get(id, userId)
    : db
        .prepare(
          "SELECT * FROM businesses WHERE user_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(userId);
  if (!row)
    throw new AppError(
      404,
      "Бизнес не найден. Создайте его в настройках.",
      "business_missing",
    );
  return { ...row, state: JSON.parse(row.state) };
}

export function event(db, businessId, payload) {
  const value = { id: randomUUID(), at: new Date().toISOString(), ...payload };
  db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(
    value.id,
    businessId,
    value.at,
    JSON.stringify(value),
  );
  return value;
}

export function events(db, id) {
  return db
    .prepare(
      "SELECT payload FROM events WHERE business_id=? ORDER BY rowid DESC LIMIT 150",
    )
    .all(id)
    .map((r) => JSON.parse(r.payload));
}

// The command record and business mutation commit together. Same key, different
// payload is a conflict; retry after a lost HTTP response returns the original result.
export function command(db, userId, businessId, key, fingerprint, fn) {
  return transaction(db, () => {
    const business = requireBusiness(db, userId, businessId);
    const previous = db
      .prepare("SELECT * FROM commands WHERE business_id=? AND key=?")
      .get(business.id, key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError(
          409,
          "Этот запрос уже использован для другой операции.",
          "idempotency_conflict",
        );
      return JSON.parse(previous.response);
    }
    const result = fn(business);
    business.version++;
    db.prepare(
      "UPDATE businesses SET state=?,version=? WHERE id=? AND user_id=?",
    ).run(
      JSON.stringify(business.state),
      business.version,
      business.id,
      userId,
    );
    const response = { ok: true, version: business.version, ...result };
    db.prepare("INSERT INTO commands VALUES(?,?,?,?)").run(
      business.id,
      key,
      fingerprint,
      JSON.stringify(response),
    );
    return response;
  });
}
