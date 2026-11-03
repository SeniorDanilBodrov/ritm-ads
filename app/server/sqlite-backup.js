import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  createReadStream,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const FORMAT = "ritm-sqlite-backup-v1";

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function timestamp(value) {
  return new Date(value)
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
}

async function sha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function inspectDatabase(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const check = db.prepare("PRAGMA quick_check").get(),
      foreignKeys = db.prepare("PRAGMA foreign_key_check").all(),
      version = db
        .prepare("SELECT MAX(version) AS version FROM schema_version")
        .get()?.version;
    if (check?.quick_check !== "ok")
      throw new Error("SQLite quick_check не подтвердил целостность копии.");
    if (foreignKeys.length)
      throw new Error("В резервной копии нарушены внешние ключи.");
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error("В резервной копии отсутствует версия схемы.");
    return { schemaVersion: version };
  } finally {
    db.close();
  }
}

function manifest(filename) {
  let value;
  try {
    value = JSON.parse(readFileSync(filename, "utf8"));
  } catch {
    throw new Error("Манифест резервной копии повреждён.");
  }
  if (
    value?.format !== FORMAT ||
    typeof value.databaseFile !== "string" ||
    value.databaseFile !== basename(value.databaseFile) ||
    !/^[a-f0-9]{64}$/.test(value.sha256 || "") ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    !Number.isSafeInteger(value.schemaVersion) ||
    value.schemaVersion < 1
  )
    throw new Error("Манифест резервной копии имеет неверный формат.");
  return value;
}

export async function createSqliteBackup({
  databasePath,
  backupDirectory,
  now = Date.now(),
} = {}) {
  if (!databasePath || databasePath === ":memory:")
    throw new Error("Для резервной копии нужен файловый DATABASE_PATH.");
  const source = resolve(databasePath),
    directory = resolve(backupDirectory || join(dirname(source), "backups"));
  if (!existsSync(source)) throw new Error("Файл базы данных не найден.");
  mkdirSync(directory, { recursive: true });
  let stem = `ritm-${timestamp(now)}`,
    output = join(directory, `${stem}.sqlite`);
  if (existsSync(output)) {
    stem += `-${randomUUID().slice(0, 8)}`;
    output = join(directory, `${stem}.sqlite`);
  }
  const manifestPath = join(directory, `${stem}.manifest.json`),
    sourceDb = new DatabaseSync(source);
  try {
    if (sourceDb.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
      throw new Error("Исходная база не прошла SQLite quick_check.");
    sourceDb.exec(`VACUUM INTO ${sqlString(output)}`);
  } catch (error) {
    rmSync(output, { force: true });
    throw error;
  } finally {
    sourceDb.close();
  }
  try {
    const details = inspectDatabase(output);
    const value = {
      format: FORMAT,
      createdAt: new Date(now).toISOString(),
      databaseFile: basename(output),
      sha256: await sha256(output),
      bytes: statSync(output).size,
      schemaVersion: details.schemaVersion,
    };
    writeFileSync(manifestPath, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { backupPath: output, manifestPath, ...value };
  } catch (error) {
    rmSync(output, { force: true });
    rmSync(manifestPath, { force: true });
    throw error;
  }
}

export async function verifySqliteBackup(manifestPath) {
  const resolvedManifest = resolve(manifestPath),
    value = manifest(resolvedManifest),
    databasePath = join(dirname(resolvedManifest), value.databaseFile);
  if (!existsSync(databasePath))
    throw new Error("Файл из манифеста резервной копии не найден.");
  if (statSync(databasePath).size !== value.bytes)
    throw new Error("Размер резервной копии не совпадает с манифестом.");
  if ((await sha256(databasePath)) !== value.sha256)
    throw new Error("SHA-256 резервной копии не совпадает с манифестом.");
  const details = inspectDatabase(databasePath);
  if (details.schemaVersion !== value.schemaVersion)
    throw new Error("Версия схемы не совпадает с манифестом.");
  return { ok: true, manifestPath: resolvedManifest, databasePath, ...value };
}

export async function restoreSqliteBackup({ manifestPath, targetPath } = {}) {
  if (!manifestPath || !targetPath)
    throw new Error("Укажите манифест и новый путь восстановления.");
  const verified = await verifySqliteBackup(manifestPath),
    target = resolve(targetPath);
  if (target === verified.databasePath)
    throw new Error("Нельзя восстановить копию поверх самой себя.");
  if (existsSync(target))
    throw new Error(
      "Целевой файл уже существует. Остановите сервис, сохраните старый файл и укажите новый путь.",
    );
  mkdirSync(dirname(target), { recursive: true });
  try {
    copyFileSync(verified.databasePath, target, constants.COPYFILE_EXCL);
    const restored = inspectDatabase(target);
    if (restored.schemaVersion !== verified.schemaVersion)
      throw new Error("Восстановленный файл имеет другую версию схемы.");
    return {
      ok: true,
      targetPath: target,
      sha256: verified.sha256,
      bytes: verified.bytes,
      schemaVersion: restored.schemaVersion,
    };
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  }
}
