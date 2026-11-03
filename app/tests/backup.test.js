import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../server/db.js";
import {
  createSqliteBackup,
  restoreSqliteBackup,
  verifySqliteBackup,
} from "../server/sqlite-backup.js";

function fixture(keepOpen = false) {
  const directory = mkdtempSync(join(tmpdir(), "ritm-backup-")),
    databasePath = join(directory, "source.sqlite"),
    db = openDatabase(databasePath);
  db.prepare(
    "INSERT INTO users(id,subject,name,created_at) VALUES(?,?,?,?)",
  ).run("user-1", "backup:test", "Проверка копии", new Date().toISOString());
  if (!keepOpen) db.close();
  return { directory, databasePath, db: keepOpen ? db : null };
}

test("SQLite backup is consistent, hashed and restorable to a new file", async () => {
  const item = fixture(true);
  try {
    const backup = await createSqliteBackup({
        databasePath: item.databasePath,
        backupDirectory: join(item.directory, "backups"),
        now: Date.UTC(2026, 9, 30, 10, 30, 0),
      }),
      verified = await verifySqliteBackup(backup.manifestPath),
      target = join(item.directory, "restored", "ritm.sqlite"),
      restored = await restoreSqliteBackup({
        manifestPath: backup.manifestPath,
        targetPath: target,
      });
    assert.equal(verified.ok, true);
    assert.equal(restored.sha256, backup.sha256);
    const db = openDatabase(target);
    assert.deepEqual(
      {
        ...db
          .prepare("SELECT subject,name FROM users WHERE id=?")
          .get("user-1"),
      },
      { subject: "backup:test", name: "Проверка копии" },
    );
    db.close();
    await assert.rejects(
      restoreSqliteBackup({
        manifestPath: backup.manifestPath,
        targetPath: target,
      }),
      /уже существует/,
    );
  } finally {
    item.db.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("SQLite backup verification rejects a changed database file", async () => {
  const item = fixture();
  try {
    const backup = await createSqliteBackup({
        databasePath: item.databasePath,
        backupDirectory: join(item.directory, "backups"),
      }),
      bytes = readFileSync(backup.backupPath);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(backup.backupPath, bytes);
    await assert.rejects(verifySqliteBackup(backup.manifestPath), /SHA-256/);
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});
