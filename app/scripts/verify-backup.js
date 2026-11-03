import { verifySqliteBackup } from "../server/sqlite-backup.js";

const index = process.argv.indexOf("--manifest"),
  manifestPath = index >= 0 ? process.argv[index + 1] : null;

try {
  if (!manifestPath) throw new Error("Укажите --manifest <путь>.");
  console.log(JSON.stringify(await verifySqliteBackup(manifestPath), null, 2));
} catch (error) {
  console.error(`Backup не подтверждён: ${error.message}`);
  process.exitCode = 1;
}
