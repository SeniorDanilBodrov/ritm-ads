import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPostgresNetworkReach,
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

test("PostgreSQL reach starts with one approved ad and keeps phrase coverage", () => {
  assert.deepEqual(assertPostgresSearchReach(plan), {
    channel: "search",
    ads: 3,
    keywords: 3,
    regions: 1,
    ready: true,
  });
  assert.deepEqual(assertPostgresSearchReach({ ...plan, ads: [plan.ads[0]] }), {
    channel: "search",
    ads: 1,
    keywords: 3,
    regions: 1,
    ready: true,
  });
  assert.throws(
    () => assertPostgresSearchReach({ ...plan, ads: [] }),
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

test("network reach starts with one approved text and accepts several images", () => {
  assert.deepEqual(
    assertPostgresNetworkReach({
      regionIds: [54],
      ads: [
        {
          titles: ["Маникюр рядом", "Бережное покрытие", "Время для себя"],
          texts: [
            "Выберите удобное время онлайн",
            "Маникюр с вниманием к деталям",
            "Запишитесь в студию в Екатеринбурге",
          ],
          adImageHashes: ["image_hash_1", "image_hash_2"],
        },
      ],
    }),
    {
      channel: "network",
      titles: 3,
      texts: 3,
      images: 2,
      regions: 1,
      ready: true,
    },
  );
  assert.deepEqual(
    assertPostgresNetworkReach({
      regionIds: [54],
      ads: [
        {
          titles: ["Маникюр рядом"],
          texts: ["Выберите удобное время онлайн"],
          adImageHashes: ["image_hash"],
        },
      ],
    }),
    {
      channel: "network",
      titles: 1,
      texts: 1,
      images: 1,
      regions: 1,
      ready: true,
    },
  );
  assert.equal(assertSupportedYandexChannel("search"), "search");
  assert.equal(assertSupportedYandexChannel("network"), "network");
  assert.throws(
    () => assertSupportedYandexChannel("video"),
    (error) => error?.code === "channel_unsupported",
  );
});
