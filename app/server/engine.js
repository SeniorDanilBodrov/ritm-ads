import { randomUUID } from "node:crypto";
import { AppError } from "./db.js";

export const RULE_VERSION = "demo-rules/1.0";
export const rubles = (kopecks) =>
  Math.round(kopecks / 100).toLocaleString("ru-RU") + " ₽";
const sum = (arr, key) => arr.reduce((total, value) => total + value[key], 0);

export function totals(state) {
  const spent = sum(state.campaigns, "spent"),
    leads = sum(state.campaigns, "leads");
  const clients = state.clientsTracked ? sum(state.campaigns, "clients") : null;
  return {
    spent,
    leads,
    clients,
    clicks: sum(state.campaigns, "clicks"),
    impressions: sum(state.campaigns, "impressions"),
    cpa: leads ? Math.round(spent / leads) : null,
    cac: clients ? Math.round(spent / clients) : null,
    remaining: Math.max(0, state.budget - spent),
    reserve: Math.ceil((state.budget * state.reservePercent) / 100),
  };
}
export function assertBudget(state) {
  if (!Number.isSafeInteger(state.budget) || state.budget <= 0)
    throw new AppError(400, "Укажите корректный бюджет.");
  if (state.budget < totals(state).spent)
    throw new AppError(409, "Новый бюджет меньше уже потраченной суммы.");
  for (const c of state.campaigns)
    if (
      c.allocation < c.spent ||
      c.spent < 0 ||
      !Number.isSafeInteger(c.allocation)
    )
      throw new AppError(
        409,
        "Лимит направления не может быть меньше расхода.",
      );
  const max =
    state.budget - Math.ceil((state.budget * state.reservePercent) / 100);
  if (sum(state.campaigns, "allocation") > max)
    throw new AppError(409, "Распределение превышает бюджет с учетом резерва.");
}
export function rebalance(state) {
  const guard = Math.ceil((state.budget * state.reservePercent) / 100);
  const remaining = state.budget - guard - totals(state).spent;
  if (remaining < 0)
    throw new AppError(409, "Оставьте резерв сверх уже потраченной суммы.");
  const active = state.campaigns.filter((c) => c.status !== "paused");
  state.campaigns.forEach((c) => {
    c.allocation = c.spent;
  });
  let rest = remaining;
  active.forEach((c, i) => {
    const chunk =
      i === active.length - 1 ? rest : Math.floor(remaining / active.length);
    c.allocation += chunk;
    rest -= chunk;
  });
  assertBudget(state);
}
export function makeCampaign(name, channel, allocation, fields = {}) {
  return {
    id: randomUUID(),
    name,
    channel,
    allocation,
    spent: 0,
    leads: 0,
    clients: 0,
    clicks: 0,
    impressions: 0,
    status: "active",
    revision: 1,
    ...fields,
  };
}

export function seedDemo(name = "Студия «Форма»") {
  const now = new Date();
  const year = now.getFullYear(),
    month = now.getMonth();
  const localDate = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const state = {
    mode: "demo",
    name,
    category: "Студия маникюра",
    city: "Екатеринбург",
    website: "https://example.com",
    landingMode: "external",
    service: "Маникюр с покрытием",
    benefit: "Бережный уход и удобная онлайн-запись",
    price: 1900,
    budget: 3000000,
    targetCpa: 45000,
    reservePercent: 10,
    timezone: "Asia/Yekaterinburg",
    periodStart: localDate(new Date(year, month, 1)),
    periodEnd: localDate(new Date(year, month + 1, 0)),
    running: true,
    clientsTracked: true,
    counterId: "DEMO-804162",
    goalId: "appointment",
    sequence: 0,
    lastSync: now.toISOString(),
    settingsRevision: 1,
    campaigns: [
      makeCampaign("Маникюр рядом с вами", "search", 1150000, {
        spent: 598000,
        leads: 31,
        clients: 15,
        clicks: 380,
        impressions: 8200,
      }),
      makeCampaign("Знакомство со студией", "network", 900000, {
        spent: 432000,
        leads: 21,
        clients: 8,
        clicks: 510,
        impressions: 24600,
      }),
      makeCampaign("Время для себя", "search", 500000, {
        spent: 181000,
        leads: 4,
        clients: 2,
        clicks: 143,
        impressions: 4600,
      }),
      makeCampaign("Общий запрос «салон»", "network", 150000, {
        spent: 99000,
        leads: 0,
        clients: 0,
        clicks: 105,
        impressions: 5100,
        status: "paused",
      }),
    ],
    experiments: [],
    creatives: [],
    aiPlan: null,
    daily: Array.from({ length: 14 }, (_, i) => ({
      label: String(i + 1),
      spent: 0,
      leads: 0,
    })),
  };
  const weights = [2, 3, 3, 4, 3, 4, 5, 3, 4, 5, 4, 5, 6, 4];
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  let cumulative = 0,
    allocatedSpent = 0,
    allocatedLeads = 0;
  state.daily.forEach((d, i) => {
    cumulative += weights[i];
    const spent = Math.round((totals(state).spent * cumulative) / weightTotal);
    const leads = Math.round((totals(state).leads * cumulative) / weightTotal);
    d.spent = spent - allocatedSpent;
    d.leads = leads - allocatedLeads;
    allocatedSpent = spent;
    allocatedLeads = leads;
  });
  state.experiments.push({
    id: randomUUID(),
    campaignId: state.campaigns[2].id,
    name: "Что важнее: близость или забота?",
    hypothesis:
      "Объявление про заботу даст больше записей, чем объявление про расположение.",
    factor: "Заголовок",
    metric: "Конверсия в обращение",
    status: "running",
    minClicks: 100,
    minDays: 7,
    elapsedDays: 4,
    maxDays: 21,
    variants: [
      { name: "А · Студия рядом с домом", clicks: 86, leads: 5 },
      { name: "Б · Час заботы о себе", clicks: 82, leads: 8 },
    ],
    verdict: "Собираем данные",
    startedAt: now.toISOString(),
  });
  state.creatives = generateCreatives(state);
  assertBudget(state);
  return state;
}

export function freshBusiness(input, demo = true) {
  return {
    ...input,
    mode: demo ? "demo" : "live",
    running: false,
    clientsTracked: false,
    reservePercent: 10,
    campaigns: [],
    experiments: [],
    creatives: [],
    aiPlan: null,
    daily: [],
    sequence: 0,
    lastSync: null,
    settingsRevision: 1,
    counterId: "",
    goalId: "",
    price: input.price || 0,
  };
}
export function generateCreatives(state) {
  return [
    {
      id: randomUUID(),
      angle: "Близость",
      title: `${state.service} · ${state.city}`.slice(0, 56),
      text: `${state.name}. ${state.benefit}. Выберите удобное время.`.slice(
        0,
        81,
      ),
      status: "draft",
      kind: "text",
      version: "templates/1",
      color: "sage",
    },
    {
      id: randomUUID(),
      angle: "Забота",
      title: `Время для себя — ${state.service.toLowerCase()}`.slice(0, 56),
      text: `${state.benefit}. Узнайте об услуге и запишитесь онлайн.`.slice(
        0,
        81,
      ),
      status: "draft",
      kind: "text",
      version: "templates/1",
      color: "peach",
    },
    {
      id: randomUUID(),
      angle: "Прозрачная цена",
      title: state.price
        ? `${state.service} от ${state.price} ₽`.slice(0, 56)
        : `${state.service}: познакомьтесь с нами`.slice(0, 56),
      text: `${state.name} · ${state.city}. Подробности на сайте.`.slice(0, 81),
      status: "draft",
      kind: "text",
      version: "templates/1",
      color: "blue",
    },
  ];
}
export function launchDemo(state) {
  if (state.mode !== "demo")
    throw new AppError(
      409,
      "Реальный запуск закрыт до проверки интеграции и лимитов на тестовом кабинете.",
      "live_gate",
    );
  if (state.campaigns.length)
    throw new AppError(
      409,
      "План уже запущен. Измените существующие направления.",
    );
  if (!state.counterId || !state.goalId)
    throw new AppError(409, "Сначала подключите тестовую аналитику.");
  if (!state.creatives.some((c) => c.status === "approved"))
    throw new AppError(409, "Сначала согласуйте хотя бы одно объявление.");
  const available =
    state.budget - Math.ceil((state.budget * state.reservePercent) / 100);
  state.campaigns = [
    makeCampaign(state.service, "search", Math.floor(available * 0.65)),
    makeCampaign(
      "Знакомство · " + state.name,
      "network",
      available - Math.floor(available * 0.65),
    ),
  ];
  state.running = true;
  assertBudget(state);
}

export function wilson(success, count) {
  if (!count) return [0, 1];
  const z = 1.96,
    p = success / count,
    d = 1 + (z * z) / count;
  const middle = (p + (z * z) / (2 * count)) / d,
    radius =
      (z * Math.sqrt((p * (1 - p)) / count + (z * z) / (4 * count * count))) /
      d;
  return [middle - radius, middle + radius];
}
export function experimentVerdict(e) {
  if (
    e.elapsedDays < e.minDays ||
    e.variants.some((v) => v.clicks < e.minClicks)
  )
    return e.elapsedDays >= e.maxDays
      ? { status: "inconclusive", text: "Недостаточно данных за 21 день" }
      : null;
  // One pre-registered final analysis at day 21. No repeated significance peeking.
  if (e.elapsedDays < e.maxDays) return null;
  const [a, b] = e.variants.map((v) => wilson(v.leads, v.clicks));
  if (a[1] < b[0])
    return {
      status: "completed",
      winner: 1,
      text: "Вариант Б приносит больше обращений",
    };
  if (b[1] < a[0])
    return {
      status: "completed",
      winner: 0,
      text: "Вариант А приносит больше обращений",
    };
  return {
    status: "inconclusive",
    text: "Убедительных различий не обнаружено",
  };
}
export function optimize(state) {
  const changes = [];
  if (!state.running) return changes;
  for (const c of state.campaigns) {
    if (
      c.status === "paused" ||
      c.spent < state.targetCpa * 3 ||
      c.clicks < 100
    )
      continue;
    const cpa = c.leads ? c.spent / c.leads : Infinity;
    if (cpa > state.targetCpa * 1.5) {
      const before = structuredClone(c);
      c.status = "paused";
      c.revision++;
      changes.push({
        kind: "pause",
        title: "Остановили неэффективное направление",
        reason: `«${c.name}»: потрачено ${rubles(c.spent)}, обращений — ${c.leads}. Стоимость выше цели ${rubles(state.targetCpa)}.`,
        targetId: c.id,
        before,
        after: structuredClone(c),
        rule: RULE_VERSION,
      });
    } else if (
      cpa > state.targetCpa * 0.85 &&
      !state.experiments.some((e) => e.campaignId === c.id)
    ) {
      state.experiments.push({
        id: randomUUID(),
        campaignId: c.id,
        name: "Новая подача предложения",
        hypothesis: "Изменение заголовка увеличит долю обращений.",
        factor: "Заголовок",
        metric: "Конверсия в обращение",
        status: "running",
        minClicks: 100,
        minDays: 7,
        maxDays: 21,
        elapsedDays: 0,
        variants: [
          { name: "А · Текущее предложение", clicks: 0, leads: 0 },
          { name: "Б · Новая подача", clicks: 0, leads: 0 },
        ],
        verdict: "Собираем данные",
        startedAt: new Date().toISOString(),
      });
      changes.push({
        kind: "experiment",
        title: "Начали проверку новой идеи",
        reason: `Стоимость обращения близка к цели. Для «${c.name}» сравним два заголовка в течение 21 дня.`,
        rule: RULE_VERSION,
      });
    }
  }
  // Transfer unused cap, never spent money. Stop donor first in a real adapter.
  const donor = state.campaigns.find(
    (c) => c.status === "paused" && c.allocation > c.spent,
  );
  const winner = state.campaigns
    .filter(
      (c) =>
        c.status === "active" &&
        c.leads >= 10 &&
        c.spent / c.leads < state.targetCpa * 0.8,
    )
    .sort((a, b) => a.spent / a.leads - b.spent / b.leads)[0];
  if (donor && winner) {
    const before = structuredClone(state.campaigns),
      step = Math.min(
        donor.allocation - donor.spent,
        Math.floor(winner.allocation * 0.15),
      );
    if (step > 0) {
      donor.allocation -= step;
      winner.allocation += step;
      donor.revision++;
      winner.revision++;
      assertBudget(state);
      changes.push({
        kind: "rebalance",
        title: "Добавили бюджет лучшему направлению",
        reason: `Перенесли ${rubles(step)} из остановленного направления в «${winner.name}». Общий бюджет не изменился.`,
        before,
        after: structuredClone(state.campaigns),
        rule: RULE_VERSION,
      });
    }
  }
  return changes;
}

export function tickDemo(state) {
  if (state.mode !== "demo")
    throw new AppError(409, "Симуляция доступна только в деморежиме.");
  if (!state.running)
    throw new AppError(
      409,
      "Реклама на паузе. Возобновите ее перед симуляцией.",
    );
  const before = totals(state);
  state.sequence++;
  for (const [i, c] of state.campaigns.entries()) {
    if (c.status === "paused") continue;
    const spend = Math.min(
      8000 + i * 2500 + (state.sequence % 3) * 600,
      c.allocation - c.spent,
    );
    c.spent += spend;
    const clicks = Math.floor(spend / (750 + i * 60));
    c.clicks += clicks;
    c.impressions += clicks * (22 + i * 7);
    const leads = Math.min(
      clicks,
      i === 2 ? (state.sequence % 2 ? 1 : 0) : Math.floor(clicks / 9),
    );
    c.leads += leads;
    c.clients += state.clientsTracked ? Math.floor(leads / 2) : 0;
    if (c.spent >= c.allocation) c.status = "paused";
    c.revision++;
  }
  const changes = optimize(state);
  for (const e of state.experiments) {
    if (e.status !== "running") continue;
    const campaign = state.campaigns.find((c) => c.id === e.campaignId);
    if (!campaign || campaign.status === "paused") continue;
    e.elapsedDays++;
    e.variants[0].clicks += 25;
    e.variants[0].leads += 1;
    e.variants[1].clicks += 25;
    e.variants[1].leads += 6;
    const verdict = experimentVerdict(e);
    if (verdict) {
      e.status = verdict.status;
      e.verdict = verdict.text;
      e.winner = verdict.winner;
      e.completedAt = new Date().toISOString();
      if (verdict.winner !== undefined) {
        campaign.selectedVariant = e.variants[verdict.winner].name;
        campaign.revision++;
      }
      changes.push({
        kind: "experiment_result",
        title: e.verdict,
        reason: `Тест «${e.name}»: ${e.variants.map((v) => `${v.leads} обращений / ${v.clicks} переходов`).join("; ")}. ${verdict.winner === undefined ? "Сохранили исходное объявление." : "Применили выигравший заголовок в демоплане."}`,
        rule: RULE_VERSION,
      });
    }
  }
  const after = totals(state);
  state.daily.push({
    label: "+" + state.sequence,
    spent: after.spent - before.spent,
    leads: after.leads - before.leads,
  });
  state.daily = state.daily.slice(-30);
  state.lastSync = new Date().toISOString();
  if (state.campaigns.every((c) => c.status === "paused"))
    state.running = false;
  assertBudget(state);
  return changes;
}

export function rollback(state, entry, allEvents) {
  if (allEvents.some((e) => e.rollbackOf === entry.id))
    throw new AppError(409, "Это изменение уже отменено.");
  if (entry.kind === "pause") {
    const c = state.campaigns.find((c) => c.id === entry.targetId);
    if (!c || JSON.stringify(c) !== JSON.stringify(entry.after))
      throw new AppError(
        409,
        "После этого решения направление изменилось. Откат отменен, чтобы сохранить новые данные.",
        "version_conflict",
      );
    Object.assign(c, entry.before, { revision: c.revision + 1 });
    assertBudget(state);
  } else if (entry.kind === "rebalance") {
    if (JSON.stringify(state.campaigns) !== JSON.stringify(entry.after))
      throw new AppError(
        409,
        "После перераспределения появились новые данные. Откат недоступен.",
        "version_conflict",
      );
    state.campaigns = structuredClone(entry.before).map((c) => ({
      ...c,
      revision: c.revision + 2,
    }));
    assertBudget(state);
  } else
    throw new AppError(
      409,
      "У этого действия нет безопасного автоматического отката.",
    );
  return {
    kind: "rollback",
    title: "Отменили изменение",
    reason: entry.title,
    rollbackOf: entry.id,
    rule: "user",
  };
}
