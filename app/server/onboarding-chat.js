import { z } from "zod";

const shortText = z.string().trim().min(2).max(240);
const profileSchema = z
  .object({
    name: shortText.describe("Название бизнеса или бренда").optional(),
    category: shortText.describe("Сфера или тип бизнеса").optional(),
    city: shortText.describe("Город, где бизнес принимает клиентов").optional(),
    website: z.string().url().max(2048).describe("Сайт бизнеса").optional(),
    service: shortText
      .describe(
        "Конкретная услуга или направление, которое нужно рекламировать",
      )
      .optional(),
    benefit: shortText
      .describe("Преимущество бизнеса, названное пользователем")
      .optional(),
    price: z
      .number()
      .int()
      .min(0)
      .max(10_000_000)
      .describe("Цена услуги в рублях")
      .optional(),
    budget: z
      .number()
      .int()
      .min(1_000)
      .max(1_000_000)
      .describe("Месячный рекламный бюджет в рублях")
      .optional(),
  })
  .strict();

const responseSchema = z
  .object({
    reply: z.string().trim().min(10).max(600),
    profile: profileSchema,
  })
  .strict();

function localUrl(value) {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(
      url.hostname,
    );
  } catch {
    return false;
  }
}

function localCandidates(value) {
  const candidates = [value];
  const url = new URL(value);
  if (url.hostname === "host.docker.internal") {
    const hostFallback = new URL(value);
    hostFallback.hostname = "127.0.0.1";
    candidates.push(hostFallback.toString());
  }
  return candidates;
}

function isComplete(profile) {
  return Boolean(
    profile.name &&
    profile.category &&
    profile.city &&
    profile.service &&
    profile.benefit &&
    profile.budget,
  );
}

function isMeaningful(value) {
  if (typeof value !== "string") return value !== undefined;
  const normalized = value.trim().toLocaleLowerCase("ru-RU");
  return ![
    "-",
    "—",
    "n/a",
    "unknown",
    "неизвестно",
    "не известно",
    "не указано",
    "не определено",
    "нет данных",
  ].includes(normalized);
}

function nextMissingField(profile) {
  return ["name", "category", "city", "service", "benefit", "budget"].find(
    (key) => !profile[key],
  );
}

function nextQuestion(profile) {
  const questions = {
    name: "Как называется ваш бизнес?",
    category: "К какой сфере относится ваш бизнес?",
    city: "В каком городе вы работаете?",
    service: "Какую услугу или направление вы хотите продвигать?",
    benefit: "Чем ваш бизнес отличается и почему клиенту стоит выбрать вас?",
    budget: "Какой месячный бюджет в рублях вы готовы выделить на рекламу?",
  };
  return questions[nextMissingField(profile)] || null;
}

function budgetFromMessage(source) {
  const match =
    source.match(
      /бюджет[^\d]{0,60}(\d[\d\s\u00a0\u202f]*)\s*(?:руб(?:лей|ля|ль)?\.?|₽)?/iu,
    ) ||
    source.match(
      /(?:готов(?:а|ы)?\s+)?выдел(?:ять|ить)\s+(\d[\d\s\u00a0\u202f]*)\s*(?:руб(?:лей|ля|ль)?\.?|₽)?/iu,
    );
  if (!match) return null;
  const value = Number(match[1].replace(/[^\d]/gu, ""));
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 1_000_000
    ? value
    : null;
}

function fallbackProfile(message, profile) {
  const source = message.trim();
  const parsed = {};
  const budget = budgetFromMessage(source);
  if (budget !== null) parsed.budget = budget;
  const city = source.match(/(?:^|\s)в\s+([А-ЯЁ][А-ЯЁа-яё-]{2,})/u)?.[1];
  const normalizedCities = {
    москве: "Москва",
    петербурге: "Санкт-Петербург",
    "санкт-петербурге": "Санкт-Петербург",
    екатеринбурге: "Екатеринбург",
    казани: "Казань",
    новосибирске: "Новосибирск",
    перми: "Пермь",
    самаре: "Самара",
    сочи: "Сочи",
    уфе: "Уфа",
  };
  if (city) parsed.city = normalizedCities[city.toLocaleLowerCase("ru-RU")] || city;
  const quotedName = source.match(/[«"]([^»"]{2,120})[»"]/u)?.[1]?.trim();
  const name =
    quotedName ||
    source
      .match(/^(.{2,120}?)\s+в\s+[А-ЯЁ]/u)?.[1]
      ?.replace(/^(?:у\s+меня|мы|это)\s+/iu, "")
      .trim();
  if (name) parsed.name = name;
  const category = source.match(
    /(студия\s+маникюра|йога-студия|кофейня|пекарня|автосервис|фотостудия|языковая\s+школа|цветочная\s+мастерская)/iu,
  )?.[1];
  if (category) parsed.category = category;
  const service = source
    .match(
      /(?:хочу\s+)?(?:продвигать|рекламировать|продвигаем|рекламируем)\s+([^.!?]{2,240})/iu,
    )?.[1]
    ?.trim();
  if (service) parsed.service = service;
  const benefit = source
    .match(/(?:клиенты\s+)?выбирают\s+(?:нас\s+)?за\s+([^.!?]{2,240})/iu)?.[1]
    ?.trim();
  if (benefit) parsed.benefit = benefit;
  const website = source.match(/https?:\/\/[^\s,;]+/iu)?.[0]?.replace(/[.!?]+$/u, "");
  if (website) parsed.website = website;
  return { ...profile, ...parsed };
}

function fallbackReply(message, profile) {
  const merged = fallbackProfile(message, profile);
  const question = nextQuestion(merged);
  const budgetChanged =
    profile.budget !== undefined &&
    merged.budget !== undefined &&
    merged.budget !== profile.budget;
  return {
    reply:
      question ||
      (budgetChanged
        ? `Бюджет обновила: ${merged.budget.toLocaleString("ru-RU")} ₽ в месяц.`
        : "Спасибо, я поняла ваш бизнес и могу собрать рекламный план."),
    profile: merged,
    complete: !question,
    provider: "fallback",
  };
}

export async function onboardingAssistant({
  message,
  profile = {},
  config,
  fetcher = fetch,
}) {
  const base = config.aiOllamaUrl || "http://127.0.0.1:11434";
  if (config.aiProvider !== "ollama" || !localUrl(base)) return fallbackReply(message, profile);
  try {
    let lastError = new Error("local model unavailable");
    for (const candidate of localCandidates(base)) {
      try {
        const response = await fetcher(new URL("/api/chat", candidate), {
          method: "POST",
          signal: AbortSignal.timeout(8_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: config.aiModel || "qwen3.5:4b",
            stream: false,
            think: false,
            format: z.toJSONSchema(responseSchema),
            options: { temperature: 0.2, num_predict: 700, num_ctx: 8192 },
            messages: [
              {
                role: "system",
                content:
                  "Тебя зовут Рита. Ты внимательный нейросетевой помощник владельца малого бизнеса. Веди короткий диалог по-русски и говори о себе в женском роде. knownProfile содержит уже подтвержденные данные. requiredMissingField — поле, о котором ты спросила на предыдущем ходе: если новое сообщение отвечает на этот вопрос, обязательно запиши ответ именно в это поле. Извлекай только явно сказанные в новом сообщении факты в profile; если пользователь исправляет значение, верни новое значение, которое должно заменить knownProfile. Не повторяй неизмененные поля и не выдумывай цены, адрес, скидки или преимущества. Если факт не назван, полностью пропусти поле: никогда не пиши 'неизвестно', 'не указано' или другой плейсхолдер. service — конкретная услуга или направление для рекламы, а category — тип бизнеса; не смешивай их. Для полного профиля нужны: название, категория, город, услуга, преимущество и бюджет в рублях. Не спрашивай про ставки, CPA, ключевые фразы, ID или рекламный кабинет. Если после объединения с knownProfile хотя бы одного обязательного факта не хватает, задай ровно один вопрос только о недостающем. Если все обязательные факты уже есть, ничего не спрашивай: кратко подтверди, что поняла бизнес и готова собрать рекламный план.",
              },
              {
                role: "user",
                content: JSON.stringify({
                  knownProfile: profile,
                  requiredMissingField: nextMissingField(profile) || null,
                  message,
                }),
              },
            ],
          }),
        });
        if (!response.ok) throw new Error("local model unavailable");
        const raw = await response.json();
        const result = responseSchema.parse(
          JSON.parse(raw.message?.content || ""),
        );
        const merged = {
          ...profile,
          ...Object.fromEntries(
            Object.entries(result.profile).filter(([, value]) =>
              isMeaningful(value),
            ),
          ),
        };
        const question = nextQuestion(merged);
        return {
          reply:
            question ||
            "Спасибо, я, Рита, поняла ваш бизнес и готова собрать рекламный план.",
          profile: merged,
          complete: !question,
          provider: "ollama",
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  } catch {
    return fallbackReply(message, profile);
  }
}
