import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAdvertisingPlan,
  fallbackAdvertisingPlan,
  requestOllamaAdvertisingPlan,
} from "../server/ai-plan.js";

const state = {
  name: "Студия «Форма»",
  category: "Студия маникюра",
  city: "Екатеринбург",
  website: "https://example.test",
  service: "Маникюр с покрытием",
  benefit: "Бережный уход и удобная онлайн-запись",
  price: 1900,
  budget: 3_000_000,
  periodStart: "2026-11-05",
  periodEnd: "2026-11-30",
};

test("fallback advertising plan is valid, safe and keeps the full budget", () => {
  const plan = fallbackAdvertisingPlan(state);
  assert.equal(plan.budgetAllocation.reduce((sum, item) => sum + item.percent, 0), 100);
  assert.ok(plan.ads.length >= 3 && plan.ads.length <= 4);
  assert.ok(plan.keywords.every((item) => item.length <= 80));
  assert.equal(plan.keywords.length, new Set(plan.keywords.map((item) => item.toLowerCase())).size);
});

test("Ollama plan is constrained by schema before it is returned", async () => {
  let requested = false;
  const plan = await requestOllamaAdvertisingPlan(
    state,
    { aiOllamaUrl: "http://127.0.0.1:11434", aiModel: "qwen3.5:4b" },
    async (url, options) => {
      requested = true;
      assert.equal(url.hostname, "127.0.0.1");
      assert.equal(options.method, "POST");
      const payload = JSON.parse(options.body);
      const modelInput = JSON.parse(payload.messages.at(-1).content);
      assert.equal(modelInput.budgetRubles, 30000);
      assert.equal("budgetKopecks" in modelInput, false);
      assert.equal(payload.think, false);
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              summary: "Покажем рекламу людям в Екатеринбурге, которые уже ищут услугу, и проверим разные причины обратиться.",
              audiences: [{ name: "Ищут услугу рядом", need: "Хотят записаться в Екатеринбурге." }],
              channels: ["search", "search"],
              keywords: ["маникюр Екатеринбург", "маникюр рядом", "маникюр с покрытием", "Маникюр рядом"],
              negativeKeywords: ["вакансии", "обучение"],
              ads: [
                { angle: "Близость", title: "Маникюр в Екатеринбурге", text: "Удобная онлайн-запись. Узнайте подробности." },
                { angle: "Удобство", title: "Запись на маникюр", text: "Бережный уход и удобная онлайн-запись." },
                { angle: "Забота", title: "Бережный маникюр", text: "Уход и удобная запись в студию «Форма»." },
              ],
              budgetAllocation: [{ channel: "search", percent: 50 }, { channel: "search", percent: 50 }],
              abHypotheses: [{ hypothesis: "Запись важнее близости", changes: "Сравним заголовки", metric: "Обращения" }],
              assumptions: ["На сайте доступна запись."],
              warnings: [],
            }),
          },
        }),
        { status: 200 },
      );
    },
  );
  assert.equal(requested, true);
  assert.equal(plan.ads[0].title, "Маникюр в Екатеринбурге");
  assert.deepEqual(plan.channels, ["search"]);
  assert.equal(plan.keywords.length, 3);
  assert.deepEqual(plan.budgetAllocation, [{ channel: "search", percent: 100 }]);
});

test("invalid or unavailable local model falls back without exposing a provider error", async () => {
  const result = await createAdvertisingPlan(
    state,
    { aiProvider: "ollama", aiOllamaUrl: "http://127.0.0.1:11434", aiModel: "qwen3.5:4b" },
    async () => new Response("broken", { status: 503 }),
  );
  assert.equal(result.provider, "fallback");
  assert.equal(result.validation.status, "passed");
  assert.match(result.promptVersion, /planner\/2$/);
  assert.equal(result.corrections.length, 1);
  assert.match(result.plan.warnings[0], /базовый план/u);
  assert.match(result.inputHash, /^[a-f0-9]{64}$/);
});

test("model cannot invent a discount, rating or licence that is absent from the business form", async () => {
  const unsafe = {
    summary: "Покажем рекламу людям в Екатеринбурге, которые выбирают услугу и хотят записаться в удобное время.",
    audiences: [{ name: "Ищут услугу рядом", need: "Хотят записаться в Екатеринбурге." }],
    channels: ["search"],
    keywords: ["маникюр Екатеринбург", "маникюр рядом", "маникюр с покрытием"],
    negativeKeywords: ["вакансии"],
    ads: [
      { angle: "Цена", title: "Скидка 50% на маникюр", text: "Запишитесь онлайн и получите выгодные условия." },
      { angle: "Выбор", title: "Лучший маникюр в городе", text: "Бережный уход и онлайн-запись." },
      { angle: "Доверие", title: "Маникюр рядом", text: "Бережный уход и удобная онлайн-запись." },
    ],
    budgetAllocation: [{ channel: "search", percent: 100 }],
    abHypotheses: [{ hypothesis: "Подача записи даст больше обращений", changes: "Сравним два заголовка", metric: "Обращения" }],
    assumptions: ["На сайте доступна запись."],
    warnings: [],
  };
  const result = await createAdvertisingPlan(
    state,
    { aiProvider: "ollama", aiOllamaUrl: "http://127.0.0.1:11434", aiModel: "qwen3.5:4b" },
    async () => new Response(JSON.stringify({ message: { content: JSON.stringify(unsafe) } }), { status: 200 }),
  );
  assert.equal(result.provider, "fallback");
  assert.equal(result.plan.ads.some((ad) => /скидк|лучший/iu.test(`${ad.title} ${ad.text}`)), false);
});

test("fallback always creates at least three distinct ads without a known price", () => {
  const plan = fallbackAdvertisingPlan({ ...state, price: 0 });
  assert.equal(plan.ads.length, 3);
  assert.equal(
    new Set(plan.ads.map((ad) => ad.angle.toLocaleLowerCase("ru"))).size,
    3,
  );
});
