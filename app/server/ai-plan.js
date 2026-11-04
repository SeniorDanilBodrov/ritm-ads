import { createHash } from "node:crypto";
import { z } from "zod";

const PLAN_SCHEMA_VERSION = "advertising-plan/2";
const PROMPT_VERSION = "small-business-planner/2";

const channel = z.enum(["search", "network"]);
const plainText = z
  .string()
  .trim()
  .min(2)
  .max(240)
  .refine((value) => !/[<>]/.test(value), "Недопустимые символы");
const phrase = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .refine((value) => !/[<>\n\r]/.test(value), "Недопустимая фраза");

export const advertisingPlanSchema = z
  .object({
    summary: z.string().trim().min(30).max(650),
    audiences: z
      .array(z.object({ name: plainText, need: plainText }).strict())
      .min(1)
      .max(5),
    channels: z.array(channel).min(1).max(2),
    keywords: z.array(phrase).min(3).max(30),
    negativeKeywords: z.array(phrase).max(40),
    ads: z
      .array(
        z
          .object({
            angle: plainText,
            title: z.string().trim().min(2).max(56),
            text: z.string().trim().min(2).max(81),
          })
          .strict(),
      )
      .min(3)
      .max(4),
    budgetAllocation: z
      .array(
        z
          .object({ channel, percent: z.number().int().min(1).max(100) })
          .strict(),
      )
      .min(1)
      .max(2),
    abHypotheses: z
      .array(
        z
          .object({
            hypothesis: plainText,
            changes: plainText,
            metric: plainText,
          })
          .strict(),
      )
      .min(1)
      .max(3),
    assumptions: z.array(plainText).max(8),
    warnings: z.array(plainText).max(8),
  })
  .strict();

function normalized(values) {
  return new Set(values.map((value) => value.trim().toLocaleLowerCase("ru")));
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (typeof value !== "string") return true;
    const key = value.trim().toLocaleLowerCase("ru");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizedAllocation(channels, allocations) {
  const weights = new Map();
  for (const item of allocations) {
    if (
      !item ||
      !channels.includes(item.channel) ||
      !Number.isFinite(item.percent)
    )
      continue;
    weights.set(
      item.channel,
      (weights.get(item.channel) || 0) + Math.max(0, item.percent),
    );
  }
  const values = channels.map((channel) => ({
    channel,
    weight: weights.get(channel) || 1,
  }));
  const total = values.reduce((sum, item) => sum + item.weight, 0);
  const exact = values.map((item) => ({
    ...item,
    percent: (item.weight / total) * 100,
  }));
  const result = exact.map((item) => ({
    channel: item.channel,
    percent: Math.floor(item.percent),
  }));
  let remainder = 100 - result.reduce((sum, item) => sum + item.percent, 0);
  const order = exact
    .map((item, index) => ({
      index,
      fraction: item.percent - Math.floor(item.percent),
    }))
    .sort((a, b) => b.fraction - a.fraction);
  for (
    let index = 0;
    remainder > 0;
    index = (index + 1) % order.length, remainder--
  )
    result[order[index].index].percent++;
  return result;
}

function normalizeModelPlan(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const plan = { ...raw };
  if (Array.isArray(plan.channels)) plan.channels = [...new Set(plan.channels)];
  if (Array.isArray(plan.keywords))
    plan.keywords = uniqueStrings(plan.keywords);
  if (Array.isArray(plan.negativeKeywords))
    plan.negativeKeywords = uniqueStrings(plan.negativeKeywords);
  if (
    Array.isArray(plan.channels) &&
    plan.channels.length &&
    Array.isArray(plan.budgetAllocation)
  )
    plan.budgetAllocation = normalizedAllocation(
      plan.channels,
      plan.budgetAllocation,
    );
  return plan;
}

function businessInput(state) {
  return {
    name: state.name,
    category: state.category,
    city: state.city,
    service: state.service,
    benefit: state.benefit,
    price:
      Number.isInteger(state.price) && state.price > 0 ? state.price : null,
    website: state.website || null,
    budgetRubles: Math.round(state.budget / 100),
    periodStart: state.periodStart,
    periodEnd: state.periodEnd,
  };
}

export function advertisingPlanInputHash(state) {
  return createHash("sha256")
    .update(JSON.stringify(businessInput(state)))
    .digest("hex");
}

export function validateAdvertisingPlan(raw, state) {
  const plan = advertisingPlanSchema.parse(raw);
  const channels = new Set(plan.channels);
  const allocations = new Set(
    plan.budgetAllocation.map((item) => item.channel),
  );
  if (channels.size !== plan.channels.length)
    throw new Error("Каналы повторяются");
  if (allocations.size !== plan.budgetAllocation.length)
    throw new Error("Распределение повторяется");
  if (
    plan.budgetAllocation.reduce((sum, item) => sum + item.percent, 0) !==
      100 ||
    [...allocations].some((item) => !channels.has(item))
  )
    throw new Error("Распределение бюджета некорректно");
  if (normalized(plan.keywords).size !== plan.keywords.length)
    throw new Error("Ключевые фразы повторяются");
  if (normalized(plan.negativeKeywords).size !== plan.negativeKeywords.length)
    throw new Error("Минус-фразы повторяются");
  if (
    plan.ads.some((ad) =>
      /(?:\d+[\s ]?₽|\d+[\s ]?руб)/iu.test(`${ad.title} ${ad.text}`),
    )
  ) {
    const allowedPrice = state.price
      ? new RegExp(
          `(?:от\\s*)?${state.price.toLocaleString("ru-RU").replace(/\s/g, "[\\s ]?")}[\\s ]?(?:₽|руб)`,
          "iu",
        )
      : null;
    if (
      !allowedPrice ||
      plan.ads.some(
        (ad) =>
          /(?:\d+[\s ]?₽|\d+[\s ]?руб)/iu.test(`${ad.title} ${ad.text}`) &&
          !allowedPrice.test(`${ad.title} ${ad.text}`),
      )
    )
      throw new Error("В объявлении есть неподтверждённая цена");
  }
  const adCopy = plan.ads
    .map((ad) => `${ad.title} ${ad.text}`)
    .join(" ")
    .toLocaleLowerCase("ru");
  const statedBenefits = String(state.benefit || "").toLocaleLowerCase("ru");
  const requiresEvidence = [
    [
      /(?:скидк|акци|распродаж|\b\d{1,2}\s*%)/iu,
      /(?:скидк|акци|распродаж|\b\d{1,2}\s*%)/iu,
      "скидка или акция",
    ],
    [
      /(?:лицензи|сертификат)/iu,
      /(?:лицензи|сертификат)/iu,
      "лицензия или сертификат",
    ],
    [/(?:гаранти)/iu, /(?:гаранти)/iu, "гарантия"],
  ];
  for (const [claim, evidence, label] of requiresEvidence) {
    if (claim.test(adCopy) && !evidence.test(statedBenefits))
      throw new Error(
        `В объявлении есть неподтверждённое утверждение: ${label}`,
      );
  }
  if (
    /(?:лучший|лучшая|№\s*1|номер\s*1|топ[-\s]?\d+|рейтинг\s*\d|\d\s*зв[её]зд)/iu.test(
      adCopy,
    )
  )
    throw new Error(
      "В объявлении есть неподтверждённый рейтинг или сравнительное утверждение",
    );
  return plan;
}

function words(...values) {
  return values
    .filter(Boolean)
    .join(" ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 7)
    .join(" ");
}

// The deterministic plan is intentionally conservative. It keeps onboarding
// usable when Ollama is still downloading, offline, or returns invalid JSON.
export function fallbackAdvertisingPlan(state, warning) {
  const service = state.service,
    city = state.city,
    benefit = state.benefit,
    serviceWords = words(service),
    businessWords = words(state.category, service);
  const ads = [
    {
      angle: "Близость",
      title: `${service} в ${city}`.slice(0, 56),
      text: `${benefit}. Узнайте подробности и выберите удобное время.`.slice(
        0,
        81,
      ),
    },
    {
      angle: "Услуга",
      title: `Запись на ${service.toLocaleLowerCase("ru")}`.slice(0, 56),
      text: `${state.name}. ${benefit}`.slice(0, 81),
    },
    {
      angle: "Преимущество",
      title: `${state.name}: ${service}`.slice(0, 56),
      text: `${benefit}. Посмотрите подробности и выберите подходящий вариант.`.slice(
        0,
        81,
      ),
    },
  ];
  if (state.price > 0)
    ads.push({
      angle: "Понятная цена",
      title: `${service} от ${state.price.toLocaleString("ru-RU")} ₽`.slice(
        0,
        56,
      ),
      text: `${state.name} в ${city}. Узнайте условия записи на сайте.`.slice(
        0,
        81,
      ),
    });
  const useNetwork = state.budget >= 1_000_000;
  return validateAdvertisingPlan(
    {
      summary: `Начнём с поиска людей в ${city}, которые уже выбирают ${service.toLocaleLowerCase("ru")}. Проверим разные причины обратиться и не превысим общий бюджет.`,
      audiences: [
        {
          name: `Ищут ${service.toLocaleLowerCase("ru")} рядом`,
          need: `Хотят найти подходящую услугу в ${city}.`,
        },
      ],
      channels: useNetwork ? ["search", "network"] : ["search"],
      keywords: [
        `${serviceWords} ${city}`.trim(),
        `${serviceWords} рядом`.trim(),
        `${businessWords} ${city}`.trim(),
      ],
      negativeKeywords: ["вакансии", "обучение", "бесплатно"],
      ads,
      budgetAllocation: useNetwork
        ? [
            { channel: "search", percent: 65 },
            { channel: "network", percent: 35 },
          ]
        : [{ channel: "search", percent: 100 }],
      abHypotheses: [
        {
          hypothesis:
            "Упоминание удобства записи даст больше обращений, чем нейтральная подача услуги.",
          changes: "Сравним заголовок про запись с заголовком про близость.",
          metric: "Обращения после перехода.",
        },
      ],
      assumptions: [
        "Пользователь может оставить заявку или записаться на сайте.",
      ],
      warnings: warning ? [warning] : [],
    },
    state,
  );
}

function isLocalOllamaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(
      url.hostname,
    )
  );
}

export async function requestOllamaAdvertisingPlan(
  state,
  config,
  fetcher = fetch,
) {
  const base = config.aiOllamaUrl || "http://127.0.0.1:11434";
  const model = config.aiModel || "qwen3.5:4b";
  if (!isLocalOllamaUrl(base)) throw new Error("Ollama URL is not local");
  if (!/^[\w.:-]{1,160}$/u.test(model))
    throw new Error("Ollama model is invalid");
  const input = businessInput(state);
  const bases = [base];
  const configuredUrl = new URL(base);
  if (configuredUrl.hostname === "host.docker.internal") {
    const hostFallback = new URL(base);
    hostFallback.hostname = "127.0.0.1";
    bases.push(hostFallback.toString());
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    let lastError = new Error("Ollama request failed");
    for (const candidate of bases) {
      try {
        const response = await fetcher(new URL("/api/chat", candidate), {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            stream: false,
            think: false,
            format: z.toJSONSchema(advertisingPlanSchema),
            options: { temperature: 0.25, num_predict: 1800, num_ctx: 8192 },
            messages: [
              {
                role: "system",
                content:
                  "Ты планировщик рекламы для малого бизнеса в России. Верни только JSON по заданной схеме. budgetRubles — весь рекламный бюджет в рублях. Не выдумывай цены, скидки, лицензии, рейтинг, адрес, атмосферу или преимущества: используй только явно переданный benefit. Не создавай команды API, не упоминай ставки. Сформируй ровно три содержательно разных объявления с разными углами подачи. Заголовки делай законченными и не длиннее 48 символов, тексты — не длиннее 72 символов; никогда не обрывай слово или предложение. Сформируй практичный план на русском языке. Если данных недостаточно, укажи это в assumptions или warnings.",
              },
              { role: "user", content: JSON.stringify(input) },
            ],
          }),
        });
        if (!response.ok) throw new Error("Ollama request failed");
        const raw = await response.text();
        if (raw.length > 120_000) throw new Error("Ollama response too large");
        const output = JSON.parse(raw)?.message?.content;
        if (typeof output !== "string" || output.length > 80_000)
          throw new Error("Ollama output missing");
        return validateAdvertisingPlan(
          normalizeModelPlan(JSON.parse(output)),
          state,
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  } finally {
    clearTimeout(timer);
  }
}

export async function createAdvertisingPlan(state, config, fetcher = fetch) {
  const inputHash = advertisingPlanInputHash(state);
  const provider = config.aiProvider || "ollama";
  if (provider !== "ollama")
    return {
      provider: "fallback",
      model: "rules/advertising-plan@1",
      promptVersion: PROMPT_VERSION,
      inputHash,
      validation: { status: "passed", schema: PLAN_SCHEMA_VERSION },
      corrections: ["Выбран детерминированный безопасный планировщик."],
      plan: fallbackAdvertisingPlan(
        state,
        "Подготовлен базовый план по данным бизнеса. Его можно уточнить позже.",
      ),
    };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return {
        provider: "ollama",
        model: config.aiModel || "qwen3.5:4b",
        promptVersion: PROMPT_VERSION,
        inputHash,
        validation: { status: "passed", schema: PLAN_SCHEMA_VERSION },
        corrections:
          attempt === 0
            ? []
            : [
                "Первый ответ модели не прошёл защитную проверку; использован повторный ответ.",
              ],
        plan: await requestOllamaAdvertisingPlan(state, config, fetcher),
      };
    } catch {
      // A retry uses the same constrained input; provider errors are not exposed.
    }
  }
  return {
    provider: "fallback",
    model: "rules/advertising-plan@1",
    promptVersion: PROMPT_VERSION,
    inputHash,
    validation: { status: "passed", schema: PLAN_SCHEMA_VERSION },
    corrections: [
      "Ответы локальной модели не прошли защитную проверку; использован детерминированный план.",
    ],
    plan: fallbackAdvertisingPlan(
      state,
      "Помощник временно недоступен, поэтому подготовлен базовый план по данным бизнеса. Его можно обновить позже.",
    ),
  };
}
