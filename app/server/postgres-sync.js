import { Worker } from "node:worker_threads";

const RESPONSE_BYTES = 16 * 1024 * 1024;
const QUERY_TIMEOUT_MS = 30_000;

function jsonPathExpression(column, path) {
  const parts = path.split(".").filter(Boolean);
  return `jsonb_extract_path_text(${column}::jsonb,${parts
    .map((part) => `'${part.replace(/'/g, "''")}'`)
    .join(",")})`;
}

function statement(sql) {
  let value = sql
    .replace(/\bBEGIN\s+IMMEDIATE\b/gi, "BEGIN")
    .replace(/\browid\b/gi, "ctid")
    .replace(/json_extract\(\s*([\w.]+)\s*,\s*'\$\.([\w.]+)'\s*\)/gi, (_match, column, path) =>
      jsonPathExpression(column, path),
    )
    .replace(
      /json_type\(\s*([\w.]+)\s*,\s*'\$\.([\w]+)'\s*\)/gi,
      "jsonb_typeof($1::jsonb -> '$2')",
    )
    .replace(/jsonb_typeof\(([^)]+)\)\s*=\s*'integer'/gi, "jsonb_typeof($1) = 'number'")
    .replace(/\bjson_object\s*\(/gi, "json_build_object(");
  let ignored = false;
  if (/^\s*INSERT\s+OR\s+IGNORE\s+/i.test(value)) {
    ignored = true;
    value = value.replace(/^\s*INSERT\s+OR\s+IGNORE\s+/i, "INSERT ");
  }
  if (ignored) value += " ON CONFLICT DO NOTHING";
  return value;
}

// The existing domain layer intentionally uses node:sqlite's compact,
// synchronous prepared-statement API. This adapter preserves that API while a
// dedicated worker owns a real PostgreSQL connection. It keeps one source of
// business rules for both local SQLite and hosted PostgreSQL deployments.
export function translatePostgresSql(sql) {
  const cleaned = sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/^PRAGMA\b/i.test(part))
    .map(statement)
    .join("; ");
  let index = 0;
  return cleaned.replace(/\?/g, () => `$${++index}`);
}

function statements(sql) {
  return sql
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

export class PostgresSyncDatabase {
  constructor(databaseUrl, { ssl = true } = {}) {
    this.worker = new Worker(new URL("./postgres-sync-worker.js", import.meta.url), {
      workerData: { databaseUrl, ssl },
    });
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      const fail = (error) => reject(error instanceof Error ? error : new Error(String(error)));
      this.worker.once("error", fail);
      this.worker.on("message", (message) => {
        if (message?.type !== "ready") return;
        this.worker.off("error", fail);
        if (message.startupError) reject(new Error(`PostgreSQL недоступен: ${message.startupError}`));
        else resolve();
      });
    });
  }

  static async connect(databaseUrl, options) {
    const db = new PostgresSyncDatabase(databaseUrl, options);
    await db.ready;
    return db;
  }

  request(sql, parameters = [], { close = false } = {}) {
    if (this.closed && !close) throw new Error("Соединение PostgreSQL закрыто.");
    const translated = close ? "" : translatePostgresSql(sql);
    if (!close && !translated) return { rows: [], changes: 0 };
    const buffer = new SharedArrayBuffer(RESPONSE_BYTES + 8);
    const header = new Int32Array(buffer, 0, 2);
    this.worker.postMessage({
      buffer,
      sql: translated,
      parameters,
      close,
    });
    const status = Atomics.wait(header, 0, 0, QUERY_TIMEOUT_MS);
    if (status === "timed-out")
      throw new Error("PostgreSQL не ответил за 30 секунд.");
    const length = Atomics.load(header, 1);
    const raw = new TextDecoder().decode(new Uint8Array(buffer, 8, length));
    const result = JSON.parse(raw);
    if (!result.ok) {
      const error = new Error(result.message || "Ошибка PostgreSQL.");
      error.code = result.code;
      throw error;
    }
    return result;
  }

  exec(sql) {
    for (const item of statements(sql)) this.request(item);
  }

  prepare(sql) {
    return {
      get: (...parameters) => this.request(sql, parameters).rows[0],
      all: (...parameters) => this.request(sql, parameters).rows,
      run: (...parameters) => {
        const result = this.request(sql, parameters);
        return { changes: result.changes, lastInsertRowid: undefined };
      },
    };
  }

  close() {
    if (this.closed) return;
    this.request("", [], { close: true });
    this.closed = true;
    this.worker.unref();
  }
}
