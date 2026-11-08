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
    needsClarification: z.boolean().optional().default(false),
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

const questions = {
  name: "Как называется ваш бизнес?",
  category: "К какой сфере относится ваш бизнес?",
  city: "В каком городе вы работаете?",
  service: "Какую услугу или направление вы хотите продвигать?",
  benefit: "Чем ваш бизнес отличается и почему клиенту стоит выбрать вас?",
  budget: "Какой месячный бюджет в рублях вы готовы выделить на рекламу?",
};

const editQuestions = {
  name: "Как теперь называется ваш бизнес?",
  category: "На какую сферу изменить профиль бизнеса?",
  city: "На какой город изменить профиль?",
  service: "Какую услугу или направление теперь продвигать?",
  benefit: "Какое преимущество указать вместо текущего?",
  budget: "Какой новый месячный бюджет установить?",
};

function questionForField(field, editing = false) {
  return (editing ? editQuestions : questions)[field] || null;
}

function nextQuestion(profile) {
  return questionForField(nextMissingField(profile));
}

function replyAddressesField(reply, field) {
  const patterns = {
    name: /назван|бизнес|бренд/iu,
    category: /сфер|занима|тип\s+бизнес/iu,
    city: /город|где\s+(?:вы|работа|принима)/iu,
    service: /услуг|направлен|продвиг|рекламир/iu,
    benefit: /отлич|выбира|преимущ|почему\s+клиент/iu,
    budget: /бюджет|рубл|₽/iu,
  };
  return patterns[field]?.test(reply) || false;
}

function normalizeRitaReply(reply) {
  return reply
    .replace(/рад\(а\)/giu, "рада")
    .replace(/готов\(а\)/giu, "готова")
    .replace(/понял\(а\)/giu, "поняла")
    .replace(/уточнил\(а\)/giu, "уточнила");
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

function directBudgetFromMessage(source) {
  const match = source.match(
    /^\s*(\d[\d\s\u00a0\u202f]*)\s*(?:руб(?:лей|ля|ль)?\.?|₽)?\s*(?:в\s+месяц)?\s*$/iu,
  );
  if (!match) return null;
  const value = Number(match[1].replace(/[^\d]/gu, ""));
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 1_000_000
    ? value
    : null;
}

function editFieldFromMessage(source) {
  if (!/(?:измен|помен|обнов|исправ|замен|смен)/iu.test(source)) return null;
  if (/(?:бюджет|лимит)/iu.test(source)) return "budget";
  if (/(?:город|локац|географ)/iu.test(source)) return "city";
  if (/(?:назван|имя\s+бизнес|бренд)/iu.test(source)) return "name";
  if (/(?:сфер|категор|тип\s+бизнес)/iu.test(source)) return "category";
  if (/(?:услуг|направлен|что\s+продвига)/iu.test(source)) return "service";
  if (/(?:преимущ|почему\s+выбира|выгод)/iu.test(source)) return "benefit";
  return null;
}

function pendingFieldFromHistory(history) {
  const reply = [...history]
    .reverse()
    .find((item) => item.role === "assistant")?.text;
  if (!reply) return null;
  if (/(?:какой|какую|какое)\s+нов|на\s+какой\s+город|как\s+теперь\s+называ/iu.test(reply)) {
    if (/город/iu.test(reply)) return "city";
    if (/бюджет/iu.test(reply)) return "budget";
    if (/услуг|направлен/iu.test(reply)) return "service";
    if (/преимущ/iu.test(reply)) return "benefit";
    if (/сфер/iu.test(reply)) return "category";
    if (/называ/iu.test(reply)) return "name";
  }
  return null;
}

function editValueFromMessage(source, field) {
  if (field === "budget")
    return budgetFromMessage(source) ?? directBudgetFromMessage(source);
  const match = source.match(/(?:\s+на|:|—)\s*([^.!?]{2,240})[.!?]*$/iu);
  return match ? cleanDirectAnswer(match[1], field) : null;
}

function isConversationalReply(value) {
  return /^(?:привет(?:ствую)?|здравствуй(?:те)?|доброе\s+(?:утро|день|вечер)|добрый\s+(?:день|вечер)|как\s+дела|спасибо|благодарю|да|нет|ок(?:ей)?|хорошо|понятно|не\s+знаю|неизвестно|не\s+указано|нет\s+данных|пока\s+нет|хочу\s+рекламу|нужна\s+реклама|помоги(?:те)?)$/iu.test(
    String(value || "").trim(),
  );
}

function sanitizeKnownProfile(profile) {
  if (!isConversationalReply(profile.name)) return profile;
  const clean = { ...profile };
  delete clean.name;
  return clean;
}

function cleanDirectAnswer(source, field) {
  const value = source
    .trim()
    .replace(/^[«"']|[»"']$/gu, "")
    .replace(/[.!]+$/gu, "")
    .trim();
  if (value.length < 2 || value.length > 240 || /[?\n\r]/u.test(value)) return null;
  if (isConversationalReply(value)) return null;
  if (field === "city") {
    const city = value.replace(/^в\s+/iu, "").trim();
    if (/\d/u.test(city) || /(?:измен|помен|обнов|исправ|замен|смен)/iu.test(city))
      return null;
    const normalized = {
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
    return normalized[city.toLocaleLowerCase("ru-RU")] || city;
  }
  if (
    field === "category" &&
    !/[\s-]/u.test(value) &&
    !/(?:магаз|студи|салон|сервис|ремонт|услуг|кафе|кофейн|пекар|ресторан|школ|центр|мастерск|агентств|фитнес|йог|маникюр|авто|техник|цвет|одежд|обув|строит|медицин|образова|достав|производ|торгов)/iu.test(
      value,
    )
  )
    return null;
  return value;
}

function answerForMissingField(source, profile, expectedField) {
  const field = expectedField || nextMissingField(profile);
  if (!field) return {};
  if (field === "budget") {
    const budget = directBudgetFromMessage(source);
    return budget === null ? {} : { budget };
  }
  const value = cleanDirectAnswer(source, field);
  if (!value) return {};
  const limits = {
    name: 120,
    category: 160,
    city: 160,
    service: 240,
    benefit: 240,
  };
  if (value.length > limits[field]) return {};
  return { [field]: value };
}

function fallbackProfile(message, profile, expectedField) {
  const source = message.trim();
  const parsed = {};
  const budget = budgetFromMessage(source);
  if (budget !== null) parsed.budget = budget;
  const directBudget = directBudgetFromMessage(source);
  if (directBudget !== null && profile.budget !== undefined)
    parsed.budget = directBudget;
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
  return {
    ...profile,
    ...answerForMissingField(source, { ...profile, ...parsed }, expectedField),
    ...parsed,
  };
}

function fallbackReply(message, profile, expectedField, editField) {
  const editValue = editField
    ? editValueFromMessage(message, editField)
    : null;
  if (editField && editValue === null) {
    return {
      reply: questionForField(editField, true),
      profile,
      complete: false,
      provider: "fallback",
    };
  }
  const merged = {
    ...fallbackProfile(message, profile, expectedField),
    ...(editField && editValue !== null ? { [editField]: editValue } : {}),
  };
  const expectedChanged =
    expectedField && merged[expectedField] !== profile[expectedField];
  const question =
    nextQuestion(merged) ||
    (expectedField && !expectedChanged
      ? questionForField(expectedField, true)
      : null);
  const budgetChanged =
    profile.budget !== undefined &&
    merged.budget !== undefined &&
    merged.budget !== profile.budget;
  const updatedField = editField || (expectedChanged ? expectedField : null);
  const updatedLabels = {
    name: "Название",
    category: "Сферу",
    city: "Город",
    service: "Услугу",
    benefit: "Преимущество",
  };
  return {
    reply:
      budgetChanged
        ? `Бюджет обновила: ${merged.budget.toLocaleString("ru-RU")} ₽ в месяц.${question ? ` ${question}` : ""}`
        : question ||
          (updatedField && updatedField !== "budget"
            ? `${updatedLabels[updatedField]} обновила: ${merged[updatedField]}.`
            : "Спасибо, я поняла ваш бизнес и могу собрать рекламный план."),
    profile: merged,
    complete: !question,
    provider: "fallback",
  };
}

export async function onboardingAssistant({
  message,
  profile = {},
  history = [],
  config,
  fetcher = fetch,
}) {
  const editField = editFieldFromMessage(message);
  const historyField = pendingFieldFromHistory(history);
  const expectedField =
    editField ||
    historyField ||
    (isConversationalReply(profile.name) ? nextMissingField(profile) : null);
  profile = sanitizeKnownProfile(profile);
  const base = config.aiOllamaUrl || "http://127.0.0.1:11434";
  if (config.aiProvider !== "ollama" || !localUrl(base))
    return fallbackReply(message, profile, expectedField, editField);
  const editValue = editField
    ? editValueFromMessage(message, editField)
    : null;
  const unresolvedEdit = Boolean(editField && editValue === null);
  const deterministicProfile = unresolvedEdit
    ? profile
    : {
        ...fallbackProfile(message, profile, expectedField),
        ...(editField && editValue !== null ? { [editField]: editValue } : {}),
      };
  try {
    let lastError = new Error("local model unavailable");
    for (const candidate of localCandidates(base)) {
      try {
        const response = await fetcher(new URL("/api/chat", candidate), {
          method: "POST",
          signal: AbortSignal.timeout(70_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: config.aiModel || "qwen3.5:4b",
            keep_alive: "30m",
            stream: false,
            think: false,
            format: z.toJSONSchema(responseSchema),
            options: { temperature: 0.2, num_predict: 320, num_ctx: 4096 },
            messages: [
              {
                role: "system",
                content:
                  "Тебя зовут Рита. Ты внимательный нейросетевой помощник владельца малого бизнеса. Веди живой, короткий диалог по-русски, всегда обращайся к пользователю на «вы» и говори о себе только в женском роде. Никогда не используй формы со скобками вроде «рад(а)» или «понял(а)»: пиши «рада» и «поняла». Не звучишь как анкета: естественно реагируй на сказанное, отвечай на уместные вопросы пользователя и затем уточняй только один факт за раз. knownProfile содержит уже подтверждённые данные. Поле name всегда означает название бизнеса или бренда, а не имя пользователя. Не предполагай, что бизнес только планируют открыть: если это не сказано, спрашивай нейтрально, где он работает. requiredMissingField — поле, о котором ты спросила на предыдущем ходе: если новое сообщение понятно отвечает на этот вопрос, запиши ответ именно в это поле. Исправляй очевидные опечатки, регистр и словоформы в сохраняемом значении, не меняя смысл. Если ответ похож на случайный набор букв, двусмысленен, противоречит knownProfile без явной просьбы изменить его или ты не уверена, ничего из него не сохраняй, установи needsClarification=true и спокойно переспроси другими словами. Никогда не угадывай сферу, город, услугу или преимущество. Если всё понятно, needsClarification=false. Извлекай только явно сказанные в новом сообщении факты в profile; если пользователь явно исправляет значение, верни новое значение, которое заменит knownProfile. Не повторяй неизменённые поля и не выдумывай цены, адрес, скидки или преимущества. Если факт не назван, полностью пропусти поле: никогда не пиши 'неизвестно', 'не указано' или другой плейсхолдер. service — конкретная услуга или направление для рекламы, а category — тип бизнеса; не смешивай их. Для полного профиля нужны: название, категория, город, услуга, преимущество и бюджет в рублях. Не спрашивай про ставки, CPA, ключевые фразы, ID или рекламный кабинет. Если после объединения с knownProfile хотя бы одного обязательного факта не хватает, задай ровно один вопрос только о недостающем. Если все обязательные факты уже есть, ничего не спрашивай: кратко и по-человечески подтверди, что поняла бизнес и готова собрать рекламный план.",
              },
              {
                role: "system",
                content:
                  "recentConversation содержит последние реплики диалога в хронологическом порядке. Используй их, чтобы понимать короткий ответ на предыдущий вопрос. Если пользователь просит изменить поле, но не называет новое значение, не меняй profile: установи needsClarification=true и спроси только новое значение. Число от 1000 до 1000000 отдельной репликой означает месячный бюджет, а не город или название. Явная команда изменения имеет приоритет над обычным сбором недостающих фактов.",
              },
              {
                role: "user",
                content: JSON.stringify({
                  knownProfile: profile,
                  recentConversation: history,
                  requiredMissingField:
                    expectedField || nextMissingField(profile) || null,
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
        const mustClarify = result.needsClarification || unresolvedEdit;
        const merged = {
          ...(mustClarify ? profile : deterministicProfile),
          ...(mustClarify
            ? {}
            : Object.fromEntries(
                Object.entries(result.profile).filter(([, value]) =>
                  isMeaningful(value),
                ),
              )),
        };
        const missingField = nextMissingField(merged);
        const question = nextQuestion(merged);
        const naturalReply = normalizeRitaReply(result.reply.trim());
        return {
          reply:
            mustClarify
              ? naturalReply
              : !question
                ? naturalReply.includes("?")
                  ? "Спасибо, я, Рита, поняла ваш бизнес и готова собрать рекламный план."
                  : naturalReply
              : replyAddressesField(naturalReply, missingField)
                ? naturalReply
                : question,
          profile: merged,
          complete: !question && !mustClarify,
          provider: "ollama",
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  } catch {
    return fallbackReply(message, profile, expectedField, editField);
  }
}
