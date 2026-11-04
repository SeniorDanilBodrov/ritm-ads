import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPostgresSearchReach,
  assertSupportedYandexChannel,
} from "../server/postgres-direct-reach.js";

const plan = {
  regionIds: [54],
  keywords: ["маникюр рядом", "маникюр с покрытием", "запись на маникюр"],
  ads: [
    { title: "Маникюр рядом", text: "Выберите удобное время онлайн" },
    { title: "Бережное покрытие", text: "Маникюр с вниманием к деталям" },
    { title: "Время для себя", text: "Запишитесь на маникюр в Екатеринбурге" },
  ],
};

test("PostgreSQL reach requires three distinct ads and phrases", () => {
  assert.deepEqual(assertPostgresSearchReach(plan), {
    channel: "search",
    ads: 3,
    keywords: 3,
    regions: 1,
    ready: true,
  });
  assert.throws(
    () =>
      assertPostgresSearchReach({
        ...plan,
        ads: [plan.ads[0], plan.ads[0], plan.ads[0]],
      }),
    (error) => error?.code === "reach_ads_missing",
  );
  assert.throws(
    () =>
      assertPostgresSearchReach({
        ...plan,
        keywords: ["маникюр рядом", " маникюр   рядом ", "маникюр рядом"],
      }),
    (error) => error?.code === "reach_keywords_missing",
  );
});

test("network placement stays fail-closed until it has an independent cap", () => {
  assert.equal(assertSupportedYandexChannel("search"), "search");
  assert.throws(
    () => assertSupportedYandexChannel("network"),
    (error) => error?.code === "network_channel_not_ready",
  );
});
