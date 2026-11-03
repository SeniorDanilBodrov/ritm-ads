import pg from "pg";
import { openDatabase, SCHEMA_VERSION } from "../server/db.js";

const connectionString = process.env.DATABASE_URL_UNPOOLED;
if (!connectionString)
  throw new Error(
    "Для миграции нужен DATABASE_URL_UNPOOLED — прямое соединение с PostgreSQL Neon.",
  );
if (/-pooler\./i.test(new URL(connectionString).hostname))
  throw new Error(
    "Миграции нельзя выполнять через pooler. Укажите прямой DATABASE_URL_UNPOOLED.",
  );

function postgresDdl(sql) {
  return sql
    .replace(/^CREATE TABLE\s+/i, "CREATE TABLE IF NOT EXISTS ")
    .replace(/^CREATE UNIQUE INDEX\s+/i, "CREATE UNIQUE INDEX IF NOT EXISTS ")
    .replace(/^CREATE INDEX\s+/i, "CREATE INDEX IF NOT EXISTS ");
}

// SQLite remains the single canonical schema description for local development.
// Reading sqlite_master after its deterministic migrations gives PostgreSQL the
// final schema without maintaining a fragile second list of DDL by hand.
const sqlite = openDatabase(":memory:");
const ddl = sqlite
  .prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name",
  )
  .all();
sqlite.close();

const tables = ddl.filter((entry) => entry.type === "table");
const indexes = ddl.filter((entry) => entry.type === "index");
const byTable = new Map(tables.map((entry) => [entry.name, entry]));
const orderedTables = [];
const visiting = new Set();
const visited = new Set();
function visit(entry) {
  if (visited.has(entry.name)) return;
  if (visiting.has(entry.name))
    throw new Error(`Циклическая внешняя связь в таблице ${entry.name}.`);
  visiting.add(entry.name);
  for (const match of entry.sql.matchAll(/REFERENCES\s+([a-z_][\w]*)/gi)) {
    const dependency = byTable.get(match[1]);
    if (dependency && dependency.name !== entry.name) visit(dependency);
  }
  visiting.delete(entry.name);
  visited.add(entry.name);
  orderedTables.push(entry);
}
for (const table of tables) visit(table);
const orderedDdl = [...orderedTables, ...indexes];

const client = new pg.Client({
  connectionString,
  ssl: process.env.POSTGRES_SSL === "false" ? false : { rejectUnauthorized: false },
});
await client.connect();
try {
  const existing = await client.query(
    "SELECT to_regclass('public.schema_version') AS schema_table",
  );
  if (existing.rows[0].schema_table) {
    const current = await client.query(`
      SELECT
        COALESCE((SELECT MAX(version) FROM schema_version), 0) AS version,
        COALESCE((SELECT COUNT(*) FROM users), 0) +
        COALESCE((SELECT COUNT(*) FROM businesses), 0) AS records
    `);
    const state = current.rows[0];
    if (Number(state.records) > 0 && Number(state.version) !== SCHEMA_VERSION)
      throw new Error(
        `Схема PostgreSQL версии ${state.version} содержит данные. Автоматическая миграция остановлена, чтобы ничего не изменить без отдельного плана миграции.`,
      );
  }
  await client.query("BEGIN");
  // One batch prevents a remote round-trip for each table and index. It is
  // still wrapped in the transaction below, so a failed schema never leaks a
  // half-applied version to the application.
  await client.query(
    orderedDdl.map((entry) => postgresDdl(entry.sql)).join(";\n"),
  );
  // The earliest bootstrap schema did not contain this column. It is the only
  // alteration of a table that existed before the first product release.
  await client.query(
    "ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS business_id TEXT REFERENCES businesses(id)",
  );
  // SQLite INTEGER is 64-bit, while PostgreSQL INTEGER is 32-bit. These
  // fields store Date.now() milliseconds and must retain the full range.
  await client.query("ALTER TABLE sessions ALTER COLUMN expires_at TYPE BIGINT");
  await client.query("ALTER TABLE oauth_states ALTER COLUMN expires_at TYPE BIGINT");
  await client.query("ALTER TABLE jobs ALTER COLUMN available_at TYPE BIGINT");
  await client.query(
    "INSERT INTO schema_version(version) VALUES($1) ON CONFLICT (version) DO NOTHING",
    [SCHEMA_VERSION],
  );
  await client.query("DELETE FROM schema_version WHERE version <> $1", [SCHEMA_VERSION]);
  await client.query("COMMIT");
  console.log(`PostgreSQL schema is ready (version ${SCHEMA_VERSION}).`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
