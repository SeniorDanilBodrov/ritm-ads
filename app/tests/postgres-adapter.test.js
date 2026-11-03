import assert from "node:assert/strict";
import test from "node:test";
import { translatePostgresSql } from "../server/postgres-sync.js";

test("PostgreSQL adapter preserves parameter order and portable SQLite reads", () => {
  const sql = translatePostgresSql(
    "SELECT json_extract(payload,'$.campaign.id') FROM jobs WHERE business_id=? AND rowid>?",
  );
  assert.equal(
    sql,
    "SELECT jsonb_extract_path_text(payload::jsonb,'campaign','id') FROM jobs WHERE business_id=$1 AND ctid>$2",
  );
});

test("PostgreSQL adapter translates SQLite safety syntax", () => {
  const sql = translatePostgresSql(
    "BEGIN IMMEDIATE; INSERT OR IGNORE INTO jobs(id) VALUES(?)",
  );
  assert.equal(
    sql,
    "BEGIN; INSERT INTO jobs(id) VALUES($1) ON CONFLICT DO NOTHING",
  );
});
