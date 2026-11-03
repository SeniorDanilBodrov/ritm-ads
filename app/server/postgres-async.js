import { Client, Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { translatePostgresSql } from "./postgres-sync.js";

// Node uses WebSockets for interactive transactions in the Neon driver.
neonConfig.webSocketConstructor = ws;

function statements(sql) {
  return sql
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRows(rows = []) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value && typeof value === "object" ? JSON.stringify(value) : value,
      ]),
    ),
  );
}

function isReadOnlySql(sql) {
  return /^\s*(SELECT|SHOW|EXPLAIN|WITH\b[\s\S]*?\bSELECT\b)/i.test(sql);
}

class PreparedStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
  }

  async get(...parameters) {
    return (await this.database.query(this.sql, parameters)).rows[0];
  }

  async all(...parameters) {
    return (await this.database.query(this.sql, parameters)).rows;
  }

  async run(...parameters) {
    const result = await this.database.query(this.sql, parameters);
    return { changes: result.changes, lastInsertRowid: undefined };
  }
}

// This intentionally mirrors only the small node:sqlite surface the domain
// layer already uses. Every operation is a Promise; SQLite callers can be
// migrated file-by-file because awaiting a synchronous local result is safe.
export class PostgresDatabase {
  constructor({ pool, client = null, statementTimeout = 15_000, connectionOptions = null }) {
    this.pool = pool;
    this.client = client;
    this.statementTimeout = statementTimeout;
    this.connectionOptions = connectionOptions;
    this.closed = false;
    this.isAsync = true;
  }

  static async connect(databaseUrl, { ssl = true } = {}) {
    const statementTimeout = Math.max(
      5_000,
      Math.min(60_000, Number(process.env.POSTGRES_QUERY_TIMEOUT_MS) || 15_000),
    );
    const connectionOptions = {
      connectionString: databaseUrl,
      ssl: ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10_000,
    };
    // The pilot defaults to clean connections. On the current Windows/Neon
    // combination, a pg.Pool socket reused after a read can be terminated in
    // the middle of a later transaction. Pooling may be opted into only after
    // it has passed the same acceptance path in the deployment environment.
    const usePool = process.env.POSTGRES_CONNECTION_MODE === "pool";
    const pool = usePool
      ? new Pool({
          ...connectionOptions,
          max: Math.max(1, Math.min(10, Number(process.env.POSTGRES_POOL_SIZE) || 5)),
          idleTimeoutMillis: 20_000,
        })
      : null;
    pool?.on("error", () => {});
    const database = new PostgresDatabase({ pool, statementTimeout, connectionOptions });
    await database.query("SELECT 1");
    return database;
  }

  async query(sql, parameters = []) {
    if (this.closed) throw new Error("Соединение PostgreSQL закрыто.");
    const translated = translatePostgresSql(sql);
    if (!translated) return { rows: [], changes: 0 };
    const execute = async () => {
      if (this.client) return this.client.query(translated, parameters);
      if (this.pool) return this.pool.query(translated, parameters);
      const client = new Client(this.connectionOptions);
      client.on("error", () => {});
      try {
        await client.connect();
        return await client.query(translated, parameters);
      } finally {
        await client.end().catch(() => {});
      }
    };
    let result;
    try {
      result = await execute();
    } catch (error) {
      const retryable =
        !this.client &&
        isReadOnlySql(translated) &&
        (error?.code === "ECONNRESET" || /connection terminated unexpectedly/i.test(error?.message || ""));
      if (!retryable) throw error;
      result = await execute();
    }
    const last = Array.isArray(result) ? result.at(-1) : result;
    return {
      rows: normalizeRows(last?.rows),
      changes: last?.rowCount || 0,
    };
  }

  async exec(sql) {
    for (const item of statements(sql)) await this.query(item);
  }

  prepare(sql) {
    return new PreparedStatement(this, sql);
  }

  async transaction(action) {
    if (this.client) return action(this);
    // A long-lived pg.Pool checkout has intermittently been terminated by the
    // Neon pooler after a preceding read on Windows. Commands must be atomic,
    // so each transaction owns a fresh client and closes it afterwards rather
    // than reusing that potentially stale session.
    const client = new Client(this.connectionOptions);
    await client.connect();
    // A checked-out client may emit an error after Neon retires a socket.
    // Keep the process alive; the awaited query below reports the failure and
    // the transaction is rolled back instead of being replayed on another
    // connection.
    client.on("error", () => {});
    const transaction = new PostgresDatabase({
      pool: this.pool,
      client,
      statementTimeout: this.statementTimeout,
      connectionOptions: this.connectionOptions,
    });
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout TO ${this.statementTimeout}`);
      const value = await action(transaction);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.client && this.pool) await this.pool.end();
  }
}
