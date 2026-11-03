import { openDatabaseAsync, SCHEMA_VERSION } from "../server/db.js";

const databaseUrl = process.env.DATABASE_URL;
if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl || ""))
  throw new Error("Для проверки PostgreSQL задайте DATABASE_URL.");

const db = await openDatabaseAsync(databaseUrl);
try {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_version")
    .get();
  if (Number(row?.version) !== SCHEMA_VERSION)
    throw new Error("Версия схемы PostgreSQL не совпадает с приложением.");
  db.prepare("SELECT 1").get();
  console.log(
    JSON.stringify({ ok: true, driver: "postgres", schemaVersion: SCHEMA_VERSION }),
  );
} finally {
  db.close();
}
