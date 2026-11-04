import { test } from "node:test";
import assert from "node:assert/strict";
import { postgresAdLifecycleView } from "../server/app-postgres.js";

test("Postgres workspace exposes every lifecycle and keeps the latest alias", () => {
  const view = postgresAdLifecycleView([
    {
      status: "active",
      change_id: "network",
      reason: "РСЯ запущена",
      updated_at: "2026-11-04T12:00:00.000Z",
    },
    {
      status: "paused",
      change_id: "search",
      reason: "Поиск приостановлен",
      updated_at: "2026-11-04T11:00:00.000Z",
    },
  ]);

  assert.equal(view.adLifecycles.length, 2);
  assert.deepEqual(view.adLifecycle, view.adLifecycles[0]);
  assert.deepEqual(
    view.adLifecycles.map(({ changeId, status }) => ({ changeId, status })),
    [
      { changeId: "network", status: "active" },
      { changeId: "search", status: "paused" },
    ],
  );
});

test("Postgres workspace retains the draft lifecycle fallback", () => {
  const view = postgresAdLifecycleView([]);
  assert.deepEqual(view.adLifecycles, []);
  assert.equal(view.adLifecycle.status, "draft");
  assert.equal(view.adLifecycle.changeId, null);
  assert.equal(view.adLifecycle.updatedAt, null);
});
