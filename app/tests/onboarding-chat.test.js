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

test("fallback accepts a short business name as the answer to Rita's question", async () => {
  const latin = await onboardingAssistant({
    message: "Frank",
    profile: {},
    config: { aiProvider: "remote-ollama" },
  });
  assert.equal(latin.profile.name, "Frank");
  assert.equal(latin.reply, "К какой сфере относится ваш бизнес?");

  const cyrillic = await onboardingAssistant({
    message: "Франк",
    profile: {},
    config: { aiProvider: "rules" },
  });
  assert.equal(cyrillic.profile.name, "Франк");
  assert.equal(cyrillic.reply, "К какой сфере относится ваш бизнес?");
});

test("a greeting is never saved as the business name", async () => {
  const result = await onboardingAssistant({
    message: "привет",
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
              reply: "Здравствуйте! Как называется ваш бизнес?",
              profile: {},
              needsClarification: false,
            }),
          },
        }),
        { status: 200 },
      ),
  });
  assert.equal(result.profile.name, undefined);
  assert.equal(result.reply, "Здравствуйте! Как называется ваш бизнес?");
  assert.equal(result.complete, false);
});

test("Rita normalizes bracketed gender forms in a model reply", async () => {
  const result = await onboardingAssistant({
    message: "привет",
    profile: {},
    config: {
      aiProvider: "ollama",
      aiOllamaUrl: "http://127.0.0.1:11434",
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              reply: "Привет! Я рад(а) знакомству. Как называется ваш бизнес?",
              profile: {},
              needsClarification: false,
            }),
          },
        }),
        { status: 200 },
      ),
  });
  assert.equal(result.reply, "Привет! Я рада знакомству. Как называется ваш бизнес?");
});

test("fallback also keeps greetings out of the profile", async () => {
  const result = await onboardingAssistant({
    message: "Добрый день",
    profile: {},
    config: { aiProvider: "rules" },
  });
  assert.equal(result.profile.name, undefined);
  assert.equal(result.reply, "Как называется ваш бизнес?");
});

test("a previously saved greeting is removed from the verified profile", async () => {
  const result = await onboardingAssistant({
    message: "магазин компьютерной техники",
    profile: { name: "привет" },
    config: { aiProvider: "rules" },
  });
  assert.equal(result.profile.name, undefined);
  assert.equal(result.profile.category, "магазин компьютерной техники");
  assert.equal(result.reply, "Как называется ваш бизнес?");
});

test("fallback advances through short answers instead of repeating a question", async () => {
  const category = await onboardingAssistant({
    message: "Ремонт телефонов",
    profile: { name: "Франк" },
    config: { aiProvider: "rules" },
  });
  assert.equal(category.profile.category, "Ремонт телефонов");
  assert.equal(category.reply, "В каком городе вы работаете?");

  const city = await onboardingAssistant({
    message: "В Екатеринбурге",
    profile: category.profile,
    config: { aiProvider: "rules" },
  });
  assert.equal(city.profile.city, "Екатеринбург");
  assert.equal(city.reply, "Какую услугу или направление вы хотите продвигать?");

  const budget = await onboardingAssistant({
    message: "40 000 ₽",
    profile: {
      ...city.profile,
      service: "Ремонт экранов",
      benefit: "Гарантия и быстрый срок",
    },
    config: { aiProvider: "rules" },
  });
  assert.equal(budget.profile.budget, 40_000);
  assert.equal(budget.complete, true);
});

test("fallback does not save a one-word unclear business category", async () => {
  const result = await onboardingAssistant({
    message: "вольаты",
    profile: { name: "Прокомп" },
    config: { aiProvider: "rules" },
  });
  assert.equal(result.profile.category, undefined);
  assert.equal(result.reply, "К какой сфере относится ваш бизнес?");
});

test("local Ollama response cannot lose a direct answer to the pending question", async () => {
  const result = await onboardingAssistant({
    message: "Frank",
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
              reply: "Как называется ваш бизнес?",
              profile: {},
            }),
          },
        }),
        { status: 200 },
      ),
  });
  assert.equal(result.provider, "ollama");
  assert.equal(result.profile.name, "Frank");
  assert.equal(result.reply, "К какой сфере относится ваш бизнес?");
});

test("Qwen asks again instead of saving an unclear answer", async () => {
  const result = await onboardingAssistant({
    message: "вольаты",
    profile: { name: "Прокомп" },
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
              reply:
                "Не уверена, что правильно поняла. Чем занимается ваш бизнес?",
              profile: {},
              needsClarification: true,
            }),
          },
        }),
        { status: 200 },
      ),
  });
  assert.equal(result.provider, "ollama");
  assert.equal(result.profile.category, undefined);
  assert.equal(result.complete, false);
  assert.match(result.reply, /не уверена|правильно поняла/iu);
});

test("Qwen keeps a natural clarification and fixes an obvious typo", async () => {
  const result = await onboardingAssistant({
    message: "магазин кампютерной техники",
    profile: { name: "Прокомп" },
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
              reply:
                "Поняла: магазин компьютерной техники. В каком городе вы работаете?",
              profile: { category: "Магазин компьютерной техники" },
              needsClarification: false,
            }),
          },
        }),
        { status: 200 },
      ),
  });
  assert.equal(result.profile.category, "Магазин компьютерной техники");
  assert.match(result.reply, /город/iu);
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

test("fallback changes a saved budget from a natural correction", async () => {
  const profile = {
    name: "Форма",
    category: "Студия маникюра",
    city: "Екатеринбург",
    service: "Маникюр с покрытием",
    benefit: "Бережный уход",
    budget: 30_000,
  };
  const result = await onboardingAssistant({
    message: "Бюджет изменим на 40 000 ₽",
    profile,
    config: { aiProvider: "rules" },
  });
  assert.equal(result.provider, "fallback");
  assert.equal(result.complete, true);
  assert.equal(result.profile.budget, 40_000);
  assert.equal(result.profile.city, "Екатеринбург");
  assert.equal(result.reply, "Бюджет обновила: 40 000 ₽ в месяц.");
});

test("fallback asks for the value of a requested city change", async () => {
  const profile = {
    name: "Форма",
    category: "Студия маникюра",
    city: "Екатеринбург",
    service: "Маникюр с покрытием",
    benefit: "Бережный уход",
    budget: 30_000,
  };
  const result = await onboardingAssistant({
    message: "Привет, хочу изменить город.",
    profile,
    config: { aiProvider: "rules" },
  });
  assert.equal(result.profile.city, "Екатеринбург");
  assert.equal(result.reply, "На какой город изменить профиль?");
  assert.equal(result.complete, false);
});

test("fallback uses the previous Rita question for a short city answer", async () => {
  const profile = {
    name: "Форма",
    category: "Студия маникюра",
    city: "Екатеринбург",
    service: "Маникюр с покрытием",
    benefit: "Бережный уход",
    budget: 30_000,
  };
  const result = await onboardingAssistant({
    message: "Москва",
    profile,
    history: [
      { role: "user", text: "Хочу изменить город" },
      { role: "assistant", text: "На какой город изменить профиль?" },
    ],
    config: { aiProvider: "rules" },
  });
  assert.equal(result.profile.city, "Москва");
  assert.equal(result.reply, "Город обновила: Москва.");
  assert.equal(result.complete, true);
});

test("a standalone number updates an existing budget", async () => {
  const profile = {
    name: "Форма",
    category: "Студия маникюра",
    city: "Екатеринбург",
    service: "Маникюр с покрытием",
    benefit: "Бережный уход",
    budget: 30_000,
  };
  const result = await onboardingAssistant({
    message: "50 000",
    profile,
    config: { aiProvider: "rules" },
  });
  assert.equal(result.profile.budget, 50_000);
  assert.equal(result.reply, "Бюджет обновила: 50 000 ₽ в месяц.");
});

test("a numeric budget does not become the city requested in the previous turn", async () => {
  const profile = {
    name: "Форма",
    category: "Студия маникюра",
    city: "Екатеринбург",
    service: "Маникюр с покрытием",
    benefit: "Бережный уход",
    budget: 30_000,
  };
  const result = await onboardingAssistant({
    message: "50 000",
    profile,
    history: [
      { role: "assistant", text: "На какой город изменить профиль?" },
    ],
    config: { aiProvider: "rules" },
  });
  assert.equal(result.profile.city, "Екатеринбург");
  assert.equal(result.profile.budget, 50_000);
  assert.match(result.reply, /Бюджет обновила: 50 000 ₽/u);
  assert.match(result.reply, /На какой город изменить профиль/u);
});

test("Qwen receives the recent conversation with the current profile", async () => {
  let requestBody;
  await onboardingAssistant({
    message: "Москва",
    profile: {
      name: "Форма",
      category: "Студия маникюра",
      city: "Екатеринбург",
      service: "Маникюр с покрытием",
      benefit: "Бережный уход",
      budget: 30_000,
    },
    history: [
      { role: "user", text: "Хочу изменить город" },
      { role: "assistant", text: "На какой город изменить профиль?" },
    ],
    config: {
      aiProvider: "ollama",
      aiOllamaUrl: "http://127.0.0.1:11434",
    },
    fetcher: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              reply: "Город обновила: Москва.",
              profile: { city: "Москва" },
              needsClarification: false,
            }),
          },
        }),
        { status: 200 },
      );
    },
  });
  const prompt = JSON.parse(requestBody.messages.at(-1).content);
  assert.equal(prompt.requiredMissingField, "city");
  assert.equal(prompt.recentConversation.length, 2);
  assert.equal(prompt.recentConversation[1].text, "На какой город изменить профиль?");
});

test("Qwen cannot complete an edit before the new value is supplied", async () => {
  const profile = {
    name: "Форма",
    category: "Студия маникюра",
    city: "Екатеринбург",
    service: "Маникюр с покрытием",
    benefit: "Бережный уход",
    budget: 30_000,
  };
  const result = await onboardingAssistant({
    message: "Хочу изменить город",
    profile,
    config: {
      aiProvider: "ollama",
      aiOllamaUrl: "http://127.0.0.1:11434",
    },
    fetcher: async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              reply: "Конечно. На какой город изменить профиль?",
              profile: { city: "Хочу изменить город" },
              needsClarification: false,
            }),
          },
        }),
        { status: 200 },
      ),
  });
  assert.equal(result.profile.city, "Екатеринбург");
  assert.equal(result.complete, false);
  assert.match(result.reply, /какой город/iu);
});
