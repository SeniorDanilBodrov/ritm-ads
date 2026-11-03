import { createSqliteBackup } from "../server/sqlite-backup.js";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

try {
  const result = await createSqliteBackup({
    databasePath:
      argument("database") || process.env.DATABASE_PATH || "./data/ritm.sqlite",
    backupDirectory:
      argument("out") || process.env.BACKUP_PATH || "./data/backups",
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Backup не создан: ${error.message}`);
  process.exitCode = 1;
}
