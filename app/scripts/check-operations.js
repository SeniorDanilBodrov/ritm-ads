import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import {
  operationalExitCode,
  operationalSnapshot,
} from "../server/operations.js";

const index = process.argv.indexOf("--database"),
  filename = resolve(
    index >= 0
      ? process.argv[index + 1]
      : process.env.DATABASE_PATH || "./data/ritm.sqlite",
  );

let db;
try {
  db = new DatabaseSync(filename, { readOnly: true });
  const snapshot = operationalSnapshot(db);
  console.log(JSON.stringify(snapshot, null, 2));
  process.exitCode = operationalExitCode(snapshot);
} catch {
  console.error(
    JSON.stringify({
      ok: false,
      ready: false,
      degraded: true,
      database: { reachable: false },
    }),
  );
  process.exitCode = 1;
} finally {
  db?.close();
}
