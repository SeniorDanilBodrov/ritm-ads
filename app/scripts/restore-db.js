import { restoreSqliteBackup } from "../server/sqlite-backup.js";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

try {
  const result = await restoreSqliteBackup({
    manifestPath: argument("manifest"),
    targetPath: argument("target"),
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Backup не восстановлен: ${error.message}`);
  process.exitCode = 1;
}
