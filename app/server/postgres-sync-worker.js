import { parentPort, workerData } from "node:worker_threads";
import pg from "pg";

const { Client } = pg;
const encoder = new TextEncoder();
const client = new Client({
  connectionString: workerData.databaseUrl,
  // Hosted PostgreSQL providers, including Neon and Render, terminate TLS at
  // their managed endpoint. The connection string remains the only secret.
  ssl: workerData.ssl ? { rejectUnauthorized: false } : undefined,
});

function write(buffer, payload) {
  const header = new Int32Array(buffer, 0, 2);
  const bytes = new Uint8Array(buffer, 8);
  const encoded = encoder.encode(JSON.stringify(payload));
  if (encoded.byteLength > bytes.byteLength)
    throw new Error("Ответ PostgreSQL превышает допустимый размер.");
  bytes.set(encoded);
  Atomics.store(header, 1, encoded.byteLength);
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0, 1);
}

function stringRows(rows = []) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value && typeof value === "object" ? JSON.stringify(value) : value,
      ]),
    ),
  );
}

const connected = client.connect().then(
  () => null,
  (error) => (error instanceof Error ? error.message : String(error)),
);
connected.then((startupError) =>
  parentPort.postMessage({ type: "ready", startupError }),
);

parentPort.on("message", async ({ buffer, sql, parameters = [], close }) => {
  const startupError = await connected;
  if (startupError) {
    write(buffer, { ok: false, message: `PostgreSQL недоступен: ${startupError}` });
    return;
  }
  if (close) {
    await client.end();
    write(buffer, { ok: true });
    return;
  }
  try {
    const result = await client.query(sql, parameters);
    const last = Array.isArray(result) ? result.at(-1) : result;
    write(buffer, {
      ok: true,
      rows: stringRows(last?.rows),
      changes: last?.rowCount || 0,
    });
  } catch (error) {
    write(buffer, {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      code: error?.code || null,
    });
  }
});
