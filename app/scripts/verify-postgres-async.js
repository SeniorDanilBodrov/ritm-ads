import { randomUUID } from "node:crypto";
import { PostgresDatabase } from "../server/postgres-async.js";

const databaseUrl = process.env.DATABASE_URL;
if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl || ""))
  throw new Error("Для проверки PostgreSQL задайте DATABASE_URL.");
if (process.env.DATABASE_SMOKE_TEST !== "true")
  throw new Error("Проверка записи требует DATABASE_SMOKE_TEST=true.");

const db = await PostgresDatabase.connect(databaseUrl, {
  ssl: process.env.POSTGRES_SSL !== "false",
});
const id = `async-smoke-${randomUUID()}`;
try {
  await db.transaction(async (tx) => {
    await tx.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
      id,
      id,
      "Проверка PostgreSQL",
      new Date().toISOString(),
    );
    const row = await tx.prepare("SELECT id FROM users WHERE id=?").get(id);
    if (row?.id !== id) throw new Error("Транзакция PostgreSQL не сохранила запись.");
  });
  const row = await db.prepare("SELECT id FROM users WHERE id=?").get(id);
  if (row?.id !== id) throw new Error("Транзакция PostgreSQL не зафиксирована.");
  await db.transaction(async (tx) => {
    await tx.prepare("DELETE FROM users WHERE id=?").run(id);
    throw new Error("intentional rollback");
  }).catch((error) => {
    if (error.message !== "intentional rollback") throw error;
  });
  const preserved = await db.prepare("SELECT id FROM users WHERE id=?").get(id);
  if (preserved?.id !== id) throw new Error("Откат PostgreSQL сработал неверно.");
  console.log(JSON.stringify({ ok: true, transaction: "commit-and-rollback" }));
} finally {
  await db.prepare("DELETE FROM users WHERE id=?").run(id);
  await db.close();
}
