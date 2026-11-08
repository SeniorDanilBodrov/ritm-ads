import { randomUUID } from "node:crypto";
import {
  assertBudget,
  launchDemo,
  makeCampaign,
  optimize,
  rollback,
  tickDemo,
  totals,
} from "./engine.js";

const stage = (id, title, detail) => ({ id, title, detail, status: "passed" });

function simulationState(business, plan) {
  const budget = Number.isSafeInteger(plan?.budget)
    ? plan.budget
    : business.budget;
  const targetCpa = Math.max(
    1,
    Math.min(
      Number.isSafeInteger(business.targetCpa) && business.targetCpa > 0
        ? business.targetCpa
        : Math.floor(budget / 20),
      Math.floor(budget / 12),
    ),
  );
  return {
    ...structuredClone(business),
    mode: "demo",
    budget,
    targetCpa,
    reservePercent: 10,
    running: false,
    clientsTracked: true,
    counterId: "acceptance-counter",
    goalId: "lead",
    campaigns: [],
    experiments: [],
    creatives: [
      {
        id: randomUUID(),
        title: plan?.ads?.[0]?.title || business.service,
        text: plan?.ads?.[0]?.text || business.benefit,
        status: "approved",
        kind: "text",
      },
    ],
    daily: [],
    sequence: 0,
    lastSync: null,
  };
}

function optimizationState(source) {
  const state = structuredClone(source);
  const reserve = Math.ceil((state.budget * state.reservePercent) / 100);
  const available = state.budget - reserve;
  const allocations = [
    Math.floor(available * 0.4),
    Math.floor(available * 0.35),
  ];
  allocations.push(available - allocations[0] - allocations[1]);
  const target = Math.max(
    1,
    Math.min(state.targetCpa, Math.floor(Math.min(...allocations) / 4)),
  );
  state.targetCpa = target;
  state.running = true;
  state.campaigns = [
    makeCampaign("Стабильное направление", "search", allocations[0], {
      spent: target * 3,
      leads: 10,
      clicks: 140,
      impressions: 3_200,
    }),
    makeCampaign("Дорогое направление", "network", allocations[1], {
      spent: target * 3,
      leads: 1,
      clicks: 120,
      impressions: 4_800,
    }),
    makeCampaign("Пограничное направление", "search", allocations[2], {
      spent: target * 3,
      leads: 3,
      clicks: 130,
      impressions: 3_700,
    }),
  ];
  state.experiments = [];
  state.daily = [];
  assertBudget(state);
  return state;
}

function experimentState(source) {
  const state = structuredClone(source);
  const reserve = Math.ceil((state.budget * state.reservePercent) / 100);
  state.running = true;
  state.campaigns = [
    makeCampaign("Проверка объявления", "search", state.budget - reserve),
  ];
  state.experiments = [
    {
      id: randomUUID(),
      campaignId: state.campaigns[0].id,
      name: "Проверка подачи",
      hypothesis: "Новая подача приведёт больше обращений.",
      factor: "Заголовок",
      metric: "Конверсия в обращение",
      status: "running",
      minClicks: 0,
      minDays: 0,
      maxDays: 21,
      elapsedDays: 20,
      variants: [
        { name: "А · Исходный текст", clicks: 100, leads: 5 },
        { name: "Б · Новая подача", clicks: 100, leads: 20 },
      ],
      verdict: "Собираем данные",
      startedAt: new Date().toISOString(),
    },
  ];
  state.daily = [];
  assertBudget(state);
  return state;
}

export function runAcceptanceSimulation(business, plan, now = Date.now()) {
  const isolated = simulationState(business, plan);
  const checks = [
    stage(
      "copy",
      "Копия плана создана",
      "Рабочий бизнес, подключение Яндекса и настоящая кампания не менялись.",
    ),
  ];

  launchDemo(isolated);
  checks.push(
    stage(
      "launch",
      "Тестовый запуск выполнен",
      "Лимит разделён между двумя направлениями, резерв сохранён.",
    ),
  );

  const beforeDay = totals(isolated);
  tickDemo(isolated);
  const afterDay = totals(isolated);
  if (afterDay.spent <= beforeDay.spent || afterDay.leads < beforeDay.leads)
    throw new Error("Симуляция дня не создала проверяемые данные.");
  checks.push(
    stage(
      "report",
      "Расход и обращения посчитаны",
      "Тестовый день добавил показы, переходы, расход и обращения только в копию.",
    ),
  );

  const optimized = optimizationState(isolated);
  const decisions = optimize(optimized).map((item) => ({
    ...item,
    id: randomUUID(),
  }));
  const pauseDecision = decisions.find((item) => item.kind === "pause");
  const rebalanceDecision = decisions.find((item) => item.kind === "rebalance");
  const experimentDecision = decisions.find(
    (item) => item.kind === "experiment",
  );
  if (!pauseDecision || !rebalanceDecision || !experimentDecision)
    throw new Error("Автопилот не прошёл контрольный набор решений.");
  checks.push(
    stage(
      "guard",
      "Дорогое направление остановлено",
      "Автопилот остановил направление с высокой стоимостью обращения.",
    ),
    stage(
      "rebalance",
      "Остаток перераспределён",
      "Свободный лимит перенесён в лучшее направление. Общий бюджет не вырос.",
    ),
    stage(
      "borderline",
      "Пограничный результат отправлен в тест",
      "Вместо преждевременной остановки создана одна A/B-гипотеза.",
    ),
  );

  const rebalanceRollbackState = structuredClone(optimized);
  rollback(rebalanceRollbackState, rebalanceDecision, decisions);
  assertBudget(rebalanceRollbackState);
  const pauseRollbackState = structuredClone(optimized);
  pauseRollbackState.campaigns = structuredClone(rebalanceDecision.before);
  rollback(pauseRollbackState, pauseDecision, decisions);
  assertBudget(pauseRollbackState);
  checks.push(
    stage(
      "rollback",
      "Изменения отменены",
      "Остановку и перераспределение можно отдельно вернуть к исходным тестовым значениям.",
    ),
  );

  const experiment = experimentState(isolated);
  const experimentEvents = tickDemo(experiment);
  if (
    !experimentEvents.some((item) => item.kind === "experiment_result") ||
    experiment.experiments[0].status !== "completed"
  )
    throw new Error("A/B-тест не сформировал итоговое решение.");
  checks.push(
    stage(
      "ab",
      "A/B-тест завершён по накопленным данным",
      "Решение принято после заданного срока и достаточного числа переходов.",
    ),
  );

  const financials = totals(isolated);
  assertBudget(isolated);
  if (financials.spent > isolated.budget - financials.reserve)
    throw new Error("Тестовый расход превысил доступный лимит.");
  checks.push(
    stage(
      "budget",
      "Лимит не превышен",
      "Расход остался внутри бюджета с учётом обязательного резерва.",
    ),
  );

  return {
    id: randomUUID(),
    createdAt: new Date(now).toISOString(),
    status: "passed",
    mode: "simulation",
    source: {
      businessName: business.name,
      planName: plan?.name || plan?.campaignName || "Текущий рекламный план",
      budgetKopecks: isolated.budget,
    },
    checks,
    externalWrites: 0,
    providerCalls: 0,
  };
}
