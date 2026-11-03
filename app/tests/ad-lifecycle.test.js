import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.js";
import {
  adLifecycle,
  adLifecycles,
  transitionAdLifecycle,
} from "../server/ad-lifecycle.js";

function fixture() {
  const db = openDatabase(":memory:"),
    userId = randomUUID(),
    businessId = randomUUID();
  db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
    userId,
    `google:${userId}`,
    "Tester",
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
    businessId,
    userId,
    JSON.stringify({ mode: "live" }),
  );
  return { db, businessId };
}

test("business ad lifecycle reaches a verified disabled draft without an env flag", () => {
  const { db, businessId } = fixture();
  assert.equal(adLifecycle(db, businessId).status, "draft");
  transitionAdLifecycle(db, businessId, "ready", {
    changeId: "change-1",
    reason: "Проверка пройдена.",
  });
  transitionAdLifecycle(db, businessId, "creating", {
    changeId: "change-1",
  });
  const result = transitionAdLifecycle(db, businessId, "paused", {
    changeId: "change-1",
    reason: "Черновик выключен и проверен.",
  });
  assert.equal(result.status, "paused");
  assert.equal(result.changeId, "change-1");
  transitionAdLifecycle(db, businessId, "moderation", {
    changeId: "change-1",
    reason: "Объявления отправлены на модерацию.",
  });
  const active = transitionAdLifecycle(db, businessId, "active", {
    changeId: "change-1",
    reason: "Лимит и статусы повторно проверены.",
  });
  assert.equal(active.status, "active");
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM events WHERE business_id=?").get(businessId)
      .n,
    5,
  );
  db.close();
});

test("business ad lifecycle rejects skipping creation and activation", () => {
  const { db, businessId } = fixture();
  assert.throws(
    () => transitionAdLifecycle(db, businessId, "active"),
    /другом состоянии/,
  );
  transitionAdLifecycle(db, businessId, "ready", { changeId: "change-1" });
  assert.throws(
    () => transitionAdLifecycle(db, businessId, "active"),
    /другом состоянии/,
  );
  db.close();
});

test("two campaigns of one business keep independent lifecycle states", () => {
  const { db, businessId } = fixture();
  for (const changeId of ["search", "network"]) {
    transitionAdLifecycle(db, businessId, "ready", { changeId });
    transitionAdLifecycle(db, businessId, "creating", { changeId });
    transitionAdLifecycle(db, businessId, "paused", { changeId });
    transitionAdLifecycle(db, businessId, "moderation", { changeId });
    transitionAdLifecycle(db, businessId, "active", { changeId });
  }
  transitionAdLifecycle(db, businessId, "paused", { changeId: "search" });
  assert.equal(adLifecycle(db, businessId, "search").status, "paused");
  assert.equal(adLifecycle(db, businessId, "network").status, "active");
  assert.deepEqual(
    adLifecycles(db, businessId)
      .map((item) => [item.changeId, item.status])
      .sort(),
    [
      ["network", "active"],
      ["search", "paused"],
    ],
  );
  db.close();
});
