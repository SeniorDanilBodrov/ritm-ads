import { test } from "node:test";
import assert from "node:assert/strict";
import { onboardingAssistant } from "../server/onboarding-chat.js";

test("local onboarding assistant extracts only a simple business profile", async () => {
  const result = await onboardingAssistant({
    message: "У меня йога-студия в Екатеринбурге, бюджет 30000 рублей.",
    profile: { service: "Йога для начинающих", benefit: "Небольшие группы" },
    config: {
      aiProvider: "ollama",
      aiOllamaUrl: "http://127.0.0.1:11434",
      aiModel: "qwen3.5:4b",
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              reply: "Как называется студия?",
              profile: {
                name: "Йога у дома",
                category: "Йога-студия",
                city: "Екатеринбург",
                budget: 30000,
              },
            }),
          },
        }),
        { status: 200 },
      ),
  });
  assert.equal(result.provider, "ollama");
  assert.equal(result.profile.city, "Екатеринбург");
  assert.equal(result.profile.service, "Йога для начинающих");
  assert.equal(result.complete, true);
  assert.doesNotMatch(result.reply, /\?/u);
});

test("assistant asks specifically for the first missing business fact", async () => {
  const result = await onboardingAssistant({
    message:
      "Студия Тихо в Екатеринбурге, занятия для начинающих, бюджет 25000 рублей.",
    profile: {},
    config: {
      aiProvider: "ollama",
      aiOllamaUrl: "http://127.0.0.1:11434",
      aiModel: "qwen3.5:4b",
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              reply: "Что еще нужно?",
              profile: {
                name: "Тихо",
                category: "Йога-студия",
                city: "Екатеринбург",
                service: "Йога для начинающих",
                benefit: "неизвестно",
                budget: 25000,
              },
            }),
          },
        }),
        { status: 200 },
      ),
  });
  assert.equal(result.complete, false);
  assert.match(result.reply, /чем.+отличается/iu);
});

test("assistant correction replaces one fact and preserves the confirmed profile", async () => {
  const profile = {
    name: "Тихо",
    category: "Йога-студия",
    city: "Екатеринбург",
    service: "Йога для начинающих",
    benefit: "Небольшие группы",
    budget: 25000,
  };
  const result = await onboardingAssistant({
    message: "Измени бюджет на 40000 рублей в месяц.",
    profile,
    config: {
      aiProvider: "ollama",
      aiOllamaUrl: "http://127.0.0.1:11434",
      aiModel: "qwen3.5:4b",
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              reply: "Бюджет обновлён.",
              profile: { budget: 40000 },
            }),
          },
        }),
        { status: 200 },
      ),
  });
  assert.equal(result.complete, true);
  assert.equal(result.profile.budget, 40000);
  assert.equal(result.profile.city, "Екатеринбург");
});

test("unavailable local assistant asks a safe non-technical follow-up", async () => {
  const result = await onboardingAssistant({
    message: "Хочу рекламу",
    config: { aiProvider: "ollama", aiOllamaUrl: "http://127.0.0.1:11434" },
    fetcher: async () => new Response("offline", { status: 503 }),
  });
  assert.equal(result.provider, "fallback");
  assert.equal(result.reply, "Как называется ваш бизнес?");
  assert.doesNotMatch(result.reply, /ставк|ключев/iu);
});

test("fallback completes a clearly stated first profile when the local model is unavailable", async () => {
  const result = await onboardingAssistant({
    message:
      "Тестовая студия маникюра в Екатеринбурге. Продвигаем маникюр с покрытием. Нас выбирают за бережный уход и удобную онлайн-запись. Бюджет на месяц 30 000 рублей.",
    config: { aiProvider: "fallback" },
  });
  assert.equal(result.provider, "fallback");
  assert.equal(result.complete, true);
  assert.equal(result.profile.budget, 30_000);
  assert.equal(result.profile.service, "маникюр с покрытием");
});

test("fallback understands a natural first message without repeating answered questions", async () => {
  const result = await onboardingAssistant({
    message:
      "У меня студия маникюра «Форма» в Екатеринбурге. Хочу рекламировать маникюр с покрытием. Клиенты выбирают нас за бережный уход и удобную онлайн-запись. Сайта пока нет. На рекламу готов выделять 30 000 рублей в месяц.",
    config: { aiProvider: "remote-ollama" },
  });
  assert.equal(result.provider, "fallback");
  assert.equal(result.complete, true);
  assert.equal(result.profile.name, "Форма");
  assert.equal(result.profile.category.toLocaleLowerCase("ru-RU"), "студия маникюра");
  assert.equal(result.profile.city, "Екатеринбург");
  assert.equal(result.profile.service, "маникюр с покрытием");
  assert.equal(result.profile.benefit, "бережный уход и удобную онлайн-запись");
  assert.equal(result.profile.budget, 30_000);
  assert.doesNotMatch(result.reply, /уточнит|какую услугу/iu);
});
