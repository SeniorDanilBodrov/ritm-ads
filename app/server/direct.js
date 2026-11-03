import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, event, requireBusiness, transaction } from "./db.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const phrase = z.string().trim().min(2).max(4096);
const negativePhrase = z
  .string()
  .trim()
  .min(2)
  .max(250)
  .refine(
    (value) => !value.startsWith("-"),
    "Минус-фраза задаётся без начального минуса",
  )
  .refine(
    (value) =>
      value.split(/\s+/u).length <= 7 &&
      value
        .split(/\s+/u)
        .every((word) => word.replace(/^[-+!]+/u, "").length <= 35),
    "Минус-фраза превышает ограничения Директа",
  );
const httpUrl = z
  .string()
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol));

export const directPlanSchema = z
  .object({
    login: z.string().trim().min(1).max(160),
    campaignName: z.string().trim().min(2).max(255),
    website: httpUrl,
    audience: z.string().trim().min(2).max(500),
    regionIds: z.array(z.number().int()).min(1).max(100),
    budget: z.number().int().positive().max(100_000_000),
    targetCpa: z.number().int().positive().max(100_000_000),
    periodStart: isoDate,
    periodEnd: isoDate,
    counterId: z.string().regex(/^\d+$/).optional(),
    goalId: z.string().regex(/^\d+$/).optional(),
    ads: z
      .array(
        z.object({
          title: z.string().trim().min(2).max(56),
          title2: z.string().trim().max(30).optional(),
          text: z.string().trim().min(2).max(81),
          href: httpUrl,
        }),
      )
      .min(1)
      .max(50),
    keywords: z.array(phrase).min(1).max(1000),
    negativeKeywords: z.array(negativePhrase).max(40).optional(),
  })
  .strict()
  .refine((value) => value.periodEnd >= value.periodStart, {
    path: ["periodEnd"],
    message: "Дата окончания раньше начала",
  });

// A business can now keep several campaigns active.  Their period limits are
// reservations against one shared business budget, so a new draft cannot make
// the portfolio promise more money than the owner has approved.
export function assertPortfolioBudget(db, business, change) {
  const configuredBudget = business?.state?.budget;
  const candidate = change?.plan?.budget;
  if (!Number.isSafeInteger(candidate) || candidate <= 0)
    throw new AppError(
      409,
      "Лимит новой кампании некорректен.",
      "portfolio_budget_invalid",
    );
  const reserved = db
    .prepare(
      `SELECT dc.plan_json,cba.limit_kopecks FROM campaign_ad_lifecycle cl
       JOIN direct_changes dc ON dc.id=cl.change_id AND dc.business_id=cl.business_id
       LEFT JOIN campaign_budget_allocations cba
         ON cba.business_id=cl.business_id AND cba.change_id=cl.change_id
       WHERE cl.business_id=? AND cl.change_id<>?
         AND cl.status IN ('creating','paused','moderation','active','needs_reconciliation')`,
    )
    .all(business.id, change.id)
    .reduce((total, row) => {
      const value = row.limit_kopecks ?? JSON.parse(row.plan_json)?.budget;
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new AppError(
          409,
          "В портфеле найдена кампания с некорректным лимитом.",
        );
      return total + value;
    }, 0);
  // A pre-portfolio business from an older database can still launch its first
  // held draft. Once it has a campaign, an explicit shared budget is required.
  const budget =
    Number.isSafeInteger(configuredBudget) && configuredBudget > 0
      ? configuredBudget
      : reserved === 0
        ? candidate
        : null;
  if (!Number.isSafeInteger(reserved) || !budget)
    throw new AppError(
      409,
      "Не задан общий бюджет бизнеса.",
      "portfolio_budget_missing",
    );
  if (reserved + candidate > budget)
    throw new AppError(
      409,
      "Лимиты кампаний превысят общий бюджет бизнеса. Уменьшите лимит новой кампании или освободите остаток другой кампании.",
      "portfolio_budget_exceeded",
    );
  return {
    budgetKopecks: budget,
    reservedKopecks: reserved,
    availableKopecks: budget - reserved,
  };
}

const micros = (kopecks) => kopecks * 10_000;
const ref = (command, field) => ({ $ref: `${command}.${field}` });
const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// A command plan contains dependency references instead of guessed remote IDs.
// The live executor must resolve each reference from the preceding API result.
export function buildDirectCommands(input) {
  const plan = directPlanSchema.parse(input);
  const commands = [
    {
      key: "campaign",
      service: "campaigns",
      method: "add",
      params: {
        Campaigns: [
          {
            Name: plan.campaignName,
            StartDate: plan.periodStart,
            EndDate: plan.periodEnd,
            ...(plan.negativeKeywords?.length
              ? { NegativeKeywords: { Items: plan.negativeKeywords } }
              : {}),
            TextCampaign: {
              BiddingStrategy: {
                Search: {
                  BiddingStrategyType: "WB_MAXIMUM_CLICKS",
                  WbMaximumClicks: {
                    CustomPeriodBudget: {
                      SpendLimit: micros(plan.budget),
                      StartDate: plan.periodStart,
                      EndDate: plan.periodEnd,
                      AutoContinue: "NO",
                    },
                  },
                },
                Network: { BiddingStrategyType: "SERVING_OFF" },
              },
              Settings: [
                { Option: "ADD_METRICA_TAG", Value: "YES" },
                { Option: "ENABLE_SITE_MONITORING", Value: "YES" },
              ],
              ...(plan.counterId
                ? { CounterIds: { Items: [Number(plan.counterId)] } }
                : {}),
            },
          },
        ],
      },
    },
    {
      key: "suspend",
      service: "campaigns",
      method: "suspend",
      dependsOn: ["campaign"],
      params: { SelectionCriteria: { Ids: [ref("campaign", "Id")] } },
    },
    {
      key: "adgroup",
      service: "adgroups",
      method: "add",
      dependsOn: ["suspend"],
      params: {
        AdGroups: [
          {
            Name: `${plan.campaignName} · ${plan.audience}`.slice(0, 255),
            CampaignId: ref("campaign", "Id"),
            RegionIds: plan.regionIds,
          },
        ],
      },
    },
    {
      key: "keywords",
      service: "keywords",
      method: "add",
      dependsOn: ["adgroup"],
      params: {
        Keywords: plan.keywords.map((Keyword) => ({
          Keyword,
          AdGroupId: ref("adgroup", "Id"),
          StrategyPriority: "NORMAL",
        })),
      },
    },
    {
      key: "ads",
      service: "ads",
      method: "add",
      dependsOn: ["adgroup"],
      params: {
        Ads: plan.ads.map((ad) => ({
          AdGroupId: ref("adgroup", "Id"),
          TextAd: {
            Title: ad.title,
            ...(ad.title2 ? { Title2: ad.title2 } : {}),
            Text: ad.text,
            Href: ad.href,
            Mobile: "NO",
          },
        })),
      },
    },
  ];
  return {
    schema: "direct/text-plan@2",
    plan,
    commands: commands.map((command) => ({
      ...command,
      fingerprint: fingerprint(command),
    })),
    summary: {
      campaigns: 1,
      adGroups: 1,
      ads: plan.ads.length,
      keywords: plan.keywords.length,
      externalCalls: 0,
    },
  };
}

function resolveReferences(value, results) {
  if (Array.isArray(value))
    return value.map((item) => resolveReferences(item, results));
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && typeof value.$ref === "string") {
      const [key, field] = value.$ref.split(".");
      if (!results[key] || results[key][field] === undefined)
        throw new AppError(
          409,
          `Не разрешена зависимость ${value.$ref}.`,
          "direct_dependency",
        );
      return results[key][field];
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveReferences(item, results),
      ]),
    );
  }
  return value;
}

export const heldCampaign = (campaign) =>
  campaign?.State === "SUSPENDED" ||
  (campaign?.State === "OFF" && campaign?.Status === "DRAFT");

// Kept separate from the queue gate so it can be contract-tested without a real
// account. Production code does not call this function while live ads are gated.
export async function executeDirectCommands(
  client,
  commands,
  { checkpoint = async () => {}, initialCalls = [], initialResults = {} } = {},
) {
  const expected = [
    ["campaign", "campaigns", "add"],
    ["suspend", "campaigns", "suspend"],
    ["adgroup", "adgroups", "add"],
    ["keywords", "keywords", "add"],
    ["ads", "ads", "add"],
  ];
  if (
    !Array.isArray(commands) ||
    commands.length !== expected.length ||
    commands.some((command, index) => {
      if (!command || typeof command !== "object") return true;
      const { fingerprint: savedFingerprint, ...content } = command;
      return (
        command.key !== expected[index][0] ||
        command.service !== expected[index][1] ||
        command.method !== expected[index][2] ||
        savedFingerprint !== fingerprint(content)
      );
    })
  )
    throw new AppError(
      409,
      "План команд изменился после dry-run. Подготовьте его заново.",
      "direct_plan_changed",
    );
  if (
    initialCalls.length &&
    (![2, 4].includes(initialCalls.length) ||
      initialCalls[0]?.key !== "campaign" ||
      initialCalls[1]?.key !== "suspend" ||
      initialCalls[0].ids?.[0] !== initialResults.campaign?.Id ||
      initialCalls[1].ids?.[0] !== initialResults.suspend?.Id ||
      initialCalls[1].holdState !== "OFF_DRAFT" ||
      (initialCalls.length === 4 &&
        (initialCalls[2]?.key !== "adgroup" ||
          initialCalls[2].ids?.[0] !== initialResults.adgroup?.Id ||
          initialCalls[3]?.key !== "keywords" ||
          initialCalls[3].ids?.[0] !== initialResults.keywords?.Id)))
  )
    throw new AppError(409, "Точка продолжения плана некорректна.");
  const results = { ...initialResults },
    calls = [...initialCalls];
  for (const command of commands.slice(initialCalls.length)) {
    const params = resolveReferences(command.params, results);
    let response;
    await checkpoint({ phase: "before", key: command.key });
    if (["adgroup", "keywords", "ads"].includes(command.key)) {
      const held = await client.campaignsByIds([results.campaign.Id]);
      if (
        !held.Campaigns?.some(
          (campaign) =>
            campaign.Id === results.campaign.Id && heldCampaign(campaign),
        )
      )
        throw new AppError(
          409,
          "Кампания перестала быть выключенным черновиком или остановленной. Создание объектов прервано.",
          "campaign_not_held",
        );
    }
    if (command.service === "campaigns" && command.method === "suspend") {
      const current = await client.campaignsByIds(params.SelectionCriteria.Ids);
      const campaign = current.Campaigns?.find(
        (item) => item.Id === params.SelectionCriteria.Ids[0],
      );
      results.campaignType = campaign?.Type;
      if (campaign?.State === "OFF" && campaign?.Status === "DRAFT") {
        results[command.key] = { Id: campaign.Id };
        calls.push({
          key: command.key,
          ids: [campaign.Id],
          holdState: "OFF_DRAFT",
        });
        await checkpoint({
          phase: "acknowledged",
          key: command.key,
          ids: [campaign.Id],
          holdState: "OFF_DRAFT",
        });
        await checkpoint({ phase: "suspend_verified", key: command.key });
        continue;
      }
      response = await client.suspendCampaigns(params.SelectionCriteria.Ids);
      const suspended = response.SuspendResults;
      if (
        !Array.isArray(suspended) ||
        suspended.length !== 1 ||
        suspended[0].Id !== params.SelectionCriteria.Ids[0] ||
        suspended[0].Errors?.length
      )
        throw new AppError(
          502,
          "Директ не подтвердил остановку кампании.",
          "provider_error",
        );
      results[command.key] = { Id: suspended[0].Id };
      calls.push({
        key: command.key,
        ids: [suspended[0].Id],
        holdState: "SUSPENDED",
      });
      await checkpoint({
        phase: "acknowledged",
        key: command.key,
        ids: [suspended[0].Id],
        holdState: "SUSPENDED",
      });
      const verified = await client.campaignsByIds([suspended[0].Id]);
      if (
        !verified?.Campaigns?.some(
          (campaign) =>
            campaign.Id === suspended[0].Id && campaign.State === "SUSPENDED",
        )
      )
        throw new AppError(
          409,
          "Состояние SUSPENDED не подтверждено чтением. Объявления не создавались.",
          "direct_suspend_unverified",
        );
      await checkpoint({ phase: "suspend_verified", key: command.key });
      continue;
    }
    if (command.service === "campaigns" && command.method === "add")
      response = await client.createCampaigns(params.Campaigns);
    else if (command.service === "adgroups" && command.method === "add")
      response = await client.createAdGroups(
        params.AdGroups.map((group) =>
          results.campaignType === "UNIFIED_CAMPAIGN"
            ? { ...group, UnifiedAdGroup: { OfferRetargeting: "NO" } }
            : group,
        ),
      );
    else if (command.service === "ads" && command.method === "add")
      response = await client.createAds(
        params.Ads.map((ad) =>
          results.campaignType === "UNIFIED_CAMPAIGN"
            ? {
                AdGroupId: ad.AdGroupId,
                ResponsiveAd: {
                  Titles: [ad.TextAd.Title.replace(/\s*·\s*/g, ", ")],
                  Texts: [ad.TextAd.Text],
                  Href: ad.TextAd.Href,
                },
              }
            : ad,
        ),
      );
    else if (command.service === "keywords" && command.method === "add")
      response = await client.createKeywords(params.Keywords);
    else throw new AppError(400, "Неизвестная команда Директа.");
    const added = response.AddResults;
    if (
      !Array.isArray(added) ||
      added.length !==
        (params.Campaigns || params.AdGroups || params.Keywords || params.Ads)
          .length ||
      added.some((item) => !item.Id || item.Errors?.length)
    )
      throw new AppError(
        502,
        "Директ не вернул идентификаторы созданных объектов.",
        "provider_error",
      );
    results[command.key] = added[0];
    calls.push({ key: command.key, ids: added.map((item) => item.Id) });
    await checkpoint({
      phase: "acknowledged",
      key: command.key,
      ids: added.map((item) => item.Id),
    });
  }
  const campaignId = results.campaign?.Id,
    remote = campaignId ? await client.campaignsByIds([campaignId]) : null,
    matched = !!remote?.Campaigns?.some(
      (campaign) => campaign.Id === campaignId && heldCampaign(campaign),
    );
  return {
    sent: true,
    externalCalls: commands.length + (campaignId ? 2 : 0),
    calls,
    reconciliation: {
      status: matched ? "matched" : "missing",
      campaignId,
      matched,
    },
  };
}

export async function reconcileDirectObjects(client, calls) {
  const ids = Object.fromEntries(calls.map((item) => [item.key, item.ids]));
  const campaignIds = ids.campaign || [],
    adGroupIds = ids.adgroup || [],
    keywordIds = ids.keywords || [],
    adIds = ids.ads || [];
  if (
    !campaignIds.length ||
    !adGroupIds.length ||
    !keywordIds.length ||
    !adIds.length
  )
    throw new AppError(
      409,
      "Недостаточно внешних ID для полной сверки.",
      "direct_reconciliation",
    );
  const [campaigns, adGroups, keywords, ads] = await Promise.all([
    client.campaignsByIds(campaignIds),
    client.adGroupsByIds(adGroupIds),
    client.keywordsByIds(keywordIds),
    client.adsByIds(adIds),
  ]);
  const campaignId = campaignIds[0],
    adGroupId = adGroupIds[0],
    campaignMatched = campaigns.Campaigns?.some(
      (item) => item.Id === campaignId && heldCampaign(item),
    ),
    groupMatched = adGroups.AdGroups?.some(
      (item) => item.Id === adGroupId && item.CampaignId === campaignId,
    ),
    keywordsMatched = keywordIds.every((id) =>
      keywords.Keywords?.some(
        (item) => item.Id === id && item.AdGroupId === adGroupId,
      ),
    ),
    adsMatched = adIds.every((id) =>
      ads.Ads?.some((item) => item.Id === id && item.AdGroupId === adGroupId),
    ),
    matched =
      !!campaignMatched && !!groupMatched && keywordsMatched && adsMatched;
  return {
    status: matched ? "matched" : "mismatch",
    matched,
    externalCalls: 4,
    objects: {
      campaign: campaigns.Campaigns || [],
      adGroups: adGroups.AdGroups || [],
      keywords: keywords.Keywords || [],
      ads: ads.Ads || [],
    },
  };
}

export function enqueueDirectDryRun(
  db,
  userId,
  businessId,
  idempotencyKey,
  input,
) {
  return transaction(db, () => {
    const business = requireBusiness(db, userId, businessId);
    if (business.state.mode === "demo")
      throw new AppError(
        409,
        "Dry-run реального плана доступен для обычного бизнеса.",
      );
    const built = buildDirectCommands(input);
    const existing = db
      .prepare(
        "SELECT dc.*,j.status,j.attempts,j.available_at AS availableAt,j.error FROM direct_changes dc JOIN jobs j ON j.id=dc.id WHERE dc.business_id=? AND dc.idempotency_key=?",
      )
      .get(business.id, idempotencyKey);
    const planFingerprint = fingerprint(built.plan);
    if (existing) {
      if (fingerprint(JSON.parse(existing.plan_json)) !== planFingerprint)
        throw new AppError(
          409,
          "Ключ уже использован для другого плана.",
          "idempotency_conflict",
        );
      return directChangeView(existing);
    }
    const id = randomUUID(),
      now = Date.now(),
      at = new Date(now).toISOString();
    db.prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload) VALUES(?,?,'direct_change','pending',?,0,?)",
    ).run(id, business.id, now, JSON.stringify({ mode: "dry_run" }));
    db.prepare(
      "INSERT INTO direct_changes(id,business_id,idempotency_key,mode,plan_json,commands_json,created_at,updated_at) VALUES(?,?,?,'dry_run',?,?,?,?)",
    ).run(
      id,
      business.id,
      idempotencyKey,
      JSON.stringify(built.plan),
      JSON.stringify(built.commands),
      at,
      at,
    );
    event(db, business.id, {
      kind: "direct_plan",
      title: "План Директа поставлен в dry-run",
      reason: `${built.summary.ads} объявлений, ${built.summary.keywords} фраз. Во внешний API ничего не отправлено.`,
      rule: built.schema,
      jobId: id,
    });
    return {
      id,
      mode: "dry_run",
      status: "pending",
      attempts: 0,
      availableAt: now,
      commands: built.commands,
      summary: built.summary,
      reconciliation: null,
      error: null,
    };
  });
}

export function directChangeForPreflight(db, userId, businessId, changeId) {
  const business = requireBusiness(db, userId, businessId);
  if (business.state.mode === "demo")
    throw new AppError(409, "Проверка реального кабинета недоступна в демо.");
  const row = db
    .prepare(
      "SELECT dc.*,j.status,j.attempts,j.available_at AS availableAt,j.error FROM direct_changes dc JOIN jobs j ON j.id=dc.id WHERE dc.id=? AND dc.business_id=?",
    )
    .get(changeId, business.id);
  if (!row) throw new AppError(404, "План Директа не найден.");
  return { business, change: directChangeView(row) };
}

export function previousDirectPreflight(db, businessId, requestKey, changeId) {
  const row = db
    .prepare(
      "SELECT change_id,report_json FROM direct_preflights WHERE business_id=? AND idempotency_key=?",
    )
    .get(businessId, requestKey);
  if (!row) return null;
  if (row.change_id !== changeId)
    throw new AppError(
      409,
      "Ключ уже использован для другого плана.",
      "idempotency_conflict",
    );
  return JSON.parse(row.report_json);
}

const localDate = (now, timezone) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone || "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));

// This report is a read-only gate, not an authorization to send add requests.
export function evaluateDirectPreflight(
  business,
  change,
  {
    clients = [],
    campaigns = [],
    limitedBy = null,
    readCalls = 2,
    connectionId = null,
    now = Date.now(),
  } = {},
) {
  const findings = [];
  const block = (code, message) =>
    findings.push({ severity: "blocker", code, message });
  const warn = (code, message) =>
    findings.push({ severity: "warning", code, message });
  const plan = directPlanSchema.parse(change.plan);
  const rebuilt = buildDirectCommands(plan);
  const commands = change.commands || [];
  if (
    change.mode !== "dry_run" ||
    change.status !== "succeeded" ||
    change.reconciliation?.status !== "prepared"
  )
    block("dry_run_incomplete", "Сначала подготовьте план к проверке.");
  if (fingerprint(commands) !== fingerprint(rebuilt.commands))
    block(
      "plan_changed",
      "План изменился после подготовки. Соберите его заново.",
    );
  const account = clients.find((item) => item.Login === plan.login);
  if (!account)
    block("account_missing", "Ритм не видит выбранный рекламный кабинет.");
  else if (account.Currency !== "RUB")
    block("currency", "Этот рекламный кабинет использует неподходящую валюту.");
  if (limitedBy != null)
    block(
      "campaign_list_incomplete",
      "Ритм не смог полностью проверить кампании в рекламном кабинете.",
    );
  if (campaigns.some((item) => item.Name === plan.campaignName))
    block(
      "duplicate_campaign",
      "В рекламном кабинете уже есть кампания с таким названием.",
    );
  if (
    business.state.landingMode !== "yandex_landing" &&
    (!plan.counterId || !plan.goalId)
  )
    block(
      "analytics_missing",
      "Выберите на сайте действие, которое считать обращением.",
    );
  else if (
    business.state.landingMode !== "yandex_landing" &&
    (String(business.state.counterId || "") !== plan.counterId ||
      String(business.state.goalId || "") !== plan.goalId)
  )
    block(
      "analytics_changed",
      "Выбранное обращение на сайте изменилось после подготовки плана.",
    );
  if (plan.regionIds.includes(0))
    block(
      "geography_broad",
      "Для первого запуска укажите конкретный город или регион.",
    );
  if (plan.periodStart <= localDate(now, "Europe/Moscow"))
    block("start_not_future", "Выберите дату начала после сегодняшнего дня.");
  const periodDays =
    (Date.parse(`${plan.periodEnd}T00:00:00Z`) -
      Date.parse(`${plan.periodStart}T00:00:00Z`)) /
      86_400_000 +
    1;
  if (!Number.isInteger(periodDays) || periodDays < 1 || periodDays > 90)
    block("period_range", "Выберите период от 1 до 90 дней.");
  else {
    const minimumKopecks = Math.max(30_000, periodDays * 5_000);
    if (plan.budget < minimumKopecks)
      block(
        "period_budget_minimum",
        `Бюджет слишком мал для ${periodDays} дней: укажите не меньше ${(minimumKopecks / 100).toLocaleString("ru-RU")} ₽.`,
      );
  }
  const domain = new URL(plan.website).hostname;
  if (plan.ads.some((ad) => new URL(ad.href).hostname !== domain))
    block(
      "landing_mismatch",
      "Ссылка в объявлении ведёт не на тот сайт, который указан в плане.",
    );
  if (
    business.state.website &&
    new URL(business.state.website).hostname !== domain
  )
    warn(
      "business_website_mismatch",
      "Сайт плана отличается от сайта в профиле бизнеса.",
    );
  const strategy =
    commands[0]?.params?.Campaigns?.[0]?.TextCampaign?.BiddingStrategy;
  const spend = strategy?.Search?.WbMaximumClicks;
  const periodBudget = spend?.CustomPeriodBudget;
  if (strategy?.Search?.BiddingStrategyType !== "WB_MAXIMUM_CLICKS")
    block(
      "strategy_changed",
      "Поисковая стратегия отличается от проверенного шаблона.",
    );
  if (strategy?.Network?.BiddingStrategyType !== "SERVING_OFF")
    block(
      "network_enabled",
      "Показы в сетях в подготовленной команде не отключены.",
    );
  if (
    !periodBudget ||
    periodBudget.SpendLimit !== plan.budget * 10_000 ||
    periodBudget.StartDate !== plan.periodStart ||
    periodBudget.EndDate !== plan.periodEnd ||
    periodBudget.AutoContinue !== "NO" ||
    spend?.WeeklySpendLimit != null
  )
    block(
      "period_cap_invalid",
      "Периодный бюджет должен совпадать с планом и не продлеваться автоматически.",
    );
  const suspend = commands[1];
  if (
    suspend?.key !== "suspend" ||
    suspend.service !== "campaigns" ||
    suspend.method !== "suspend" ||
    JSON.stringify(suspend.params?.SelectionCriteria?.Ids) !==
      JSON.stringify([{ $ref: "campaign.Id" }]) ||
    !commands[2]?.dependsOn?.includes("suspend")
  )
    block(
      "suspend_order",
      "Кампания должна останавливаться до создания групп и объявлений.",
    );
  return {
    schema: "direct/preflight@2",
    changeId: change.id,
    planFingerprint: fingerprint(plan),
    checkedAt: new Date(now).toISOString(),
    connectionId,
    ready: !findings.some((item) => item.severity === "blocker"),
    findings,
    account: account
      ? {
          login: account.Login,
          currency: account.Currency,
          clientId: account.ClientId,
        }
      : null,
    plan: {
      campaignName: plan.campaignName,
      startDate: plan.periodStart,
      endDate: plan.periodEnd,
      budget: plan.budget,
      regionIds: plan.regionIds,
      ads: plan.ads.length,
      keywords: plan.keywords.length,
    },
    remote: { campaignCount: campaigns.length, readCalls, writeCalls: 0 },
  };
}

export function saveDirectPreflight(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  report,
) {
  return transaction(db, () => {
    const { change } = directChangeForPreflight(
      db,
      userId,
      businessId,
      changeId,
    );
    const previous = previousDirectPreflight(
      db,
      businessId,
      requestKey,
      changeId,
    );
    if (previous) return previous;
    if (
      report.changeId !== change.id ||
      report.planFingerprint !== fingerprint(change.plan)
    )
      throw new AppError(
        409,
        "План изменился во время проверки.",
        "stale_preflight",
      );
    db.prepare(
      "INSERT INTO direct_preflights(id,business_id,change_id,idempotency_key,checked_at,report_json) VALUES(?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      businessId,
      changeId,
      requestKey,
      report.checkedAt,
      JSON.stringify(report),
    );
    event(db, businessId, {
      kind: "direct_preflight",
      title: report.ready
        ? "Проверка плана пройдена"
        : "Найдены препятствия перед запуском",
      reason: `${report.findings.filter((item) => item.severity === "blocker").length} блокирующих пунктов; внешних записей 0.`,
      rule: report.schema,
      jobId: changeId,
    });
    return report;
  });
}

// Confirmation is local, short-lived, and does not execute any Direct command.
export function confirmDirectPlan(
  db,
  userId,
  businessId,
  changeId,
  planHash,
  now = Date.now(),
) {
  return transaction(db, () => {
    const { change } = directChangeForPreflight(
      db,
      userId,
      businessId,
      changeId,
    );
    const latest = db
      .prepare(
        "SELECT id,report_json FROM direct_preflights WHERE business_id=? AND change_id=? ORDER BY checked_at DESC,rowid DESC LIMIT 1",
      )
      .get(businessId, changeId);
    if (!latest) throw new AppError(409, "Сначала проверьте кабинет и риски.");
    const report = JSON.parse(latest.report_json);
    const connection = db
      .prepare(
        "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
      )
      .get(businessId);
    const currentConnectionId =
      connection && JSON.parse(connection.metadata).connectionId;
    if (
      !report.ready ||
      report.planFingerprint !== planHash ||
      report.planFingerprint !== fingerprint(change.plan) ||
      !report.connectionId ||
      report.connectionId !== currentConnectionId ||
      change.status !== "succeeded" ||
      change.reconciliation?.status !== "prepared" ||
      change.plan.periodStart <= localDate(now, "Europe/Moscow") ||
      !Number.isFinite(Date.parse(report.checkedAt)) ||
      now - Date.parse(report.checkedAt) > 10 * 60_000 ||
      now < Date.parse(report.checkedAt)
    )
      throw new AppError(
        409,
        "Проверка устарела или план изменился. Запустите проверку снова.",
        "stale_preflight",
      );
    const existing = db
      .prepare("SELECT * FROM direct_approvals WHERE change_id=?")
      .get(changeId);
    if (existing?.consumed_at)
      throw new AppError(409, "Подтверждение уже использовано.");
    if (
      existing?.preflight_id === latest.id &&
      existing?.plan_fingerprint === planHash &&
      Date.parse(existing.expires_at) > now
    )
      return {
        status: "confirmed",
        changeId,
        planFingerprint: planHash,
        confirmedAt: existing.confirmed_at,
        expiresAt: existing.expires_at,
        externalWrites: 0,
      };
    const confirmedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + 10 * 60_000).toISOString();
    db.prepare(
      `INSERT INTO direct_approvals(change_id,business_id,preflight_id,plan_fingerprint,connection_id,confirmed_at,expires_at,consumed_at)
      VALUES(?,?,?,?,?,?,?,NULL)
      ON CONFLICT(change_id) DO UPDATE SET preflight_id=excluded.preflight_id,plan_fingerprint=excluded.plan_fingerprint,
        connection_id=excluded.connection_id,confirmed_at=excluded.confirmed_at,expires_at=excluded.expires_at,consumed_at=NULL`,
    ).run(
      changeId,
      businessId,
      latest.id,
      planHash,
      currentConnectionId,
      confirmedAt,
      expiresAt,
    );
    event(db, businessId, {
      kind: "direct_plan_confirmed",
      title: "План создания черновика подтвержден",
      reason:
        "Подтверждена одна будущая операция; запросы на запись в Директ не выполнялись.",
      rule: "direct/approval@1",
      jobId: changeId,
    });
    return {
      status: "confirmed",
      changeId,
      planFingerprint: planHash,
      confirmedAt,
      expiresAt,
      externalWrites: 0,
    };
  });
}

function directChangeView(row) {
  const commands = JSON.parse(row.commands_json);
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.availableAt ?? row.available_at,
    plan: JSON.parse(row.plan_json),
    commands,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    reconciliation: row.reconciliation_json
      ? JSON.parse(row.reconciliation_json)
      : null,
    summary: {
      campaigns: 1,
      adGroups: 1,
      ads: commands.find((c) => c.key === "ads")?.params.Ads.length || 0,
      keywords:
        commands.find((c) => c.key === "keywords")?.params.Keywords.length || 0,
      externalCalls: 0,
    },
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preflight: row.preflight_json ? JSON.parse(row.preflight_json) : null,
    approval: row.approval_json ? JSON.parse(row.approval_json) : null,
    execution: row.execution_status
      ? {
          status: row.execution_status,
          inflightKey: row.execution_inflight_key,
          suspendVerified: !!row.execution_suspend_verified,
          calls: JSON.parse(row.execution_calls_json),
          errorCode: row.execution_error_code,
          updatedAt: row.execution_updated_at,
          reconciliation: row.execution_reconciliation_json
            ? JSON.parse(row.execution_reconciliation_json)
            : null,
        }
      : null,
    lifecycle: row.lifecycle_json ? JSON.parse(row.lifecycle_json) : null,
    budgetCheck: row.budget_check_json
      ? JSON.parse(row.budget_check_json)
      : null,
  };
}

export function directChanges(db, businessId) {
  return db
    .prepare(
      "SELECT dc.*,j.status,j.attempts,j.available_at AS availableAt,j.error,(SELECT report_json FROM direct_preflights p WHERE p.change_id=dc.id ORDER BY p.checked_at DESC,p.rowid DESC LIMIT 1) AS preflight_json,(SELECT json_object('status','confirmed','changeId',a.change_id,'planFingerprint',a.plan_fingerprint,'confirmedAt',a.confirmed_at,'expiresAt',a.expires_at,'externalWrites',0) FROM direct_approvals a WHERE a.change_id=dc.id AND a.consumed_at IS NULL AND a.preflight_id=(SELECT p.id FROM direct_preflights p WHERE p.change_id=dc.id ORDER BY p.checked_at DESC,p.rowid DESC LIMIT 1)) AS approval_json,de.status AS execution_status,de.inflight_key AS execution_inflight_key,de.suspend_verified AS execution_suspend_verified,de.calls_json AS execution_calls_json,de.error_code AS execution_error_code,de.updated_at AS execution_updated_at,de.reconciliation_json AS execution_reconciliation_json,(SELECT json_object('id',la.id,'status',la.status,'campaignId',la.campaign_id,'beforeState',la.before_state,'afterState',la.after_state,'writeAttempted',la.write_attempted,'errorCode',la.error_code,'updatedAt',la.updated_at) FROM direct_lifecycle_actions la WHERE la.change_id=dc.id ORDER BY la.created_at DESC,la.rowid DESC LIMIT 1) AS lifecycle_json,(SELECT bc.result_json FROM direct_budget_checks bc WHERE bc.change_id=dc.id ORDER BY bc.checked_at DESC,bc.rowid DESC LIMIT 1) AS budget_check_json FROM direct_changes dc JOIN jobs j ON j.id=dc.id LEFT JOIN direct_executions de ON de.change_id=dc.id WHERE dc.business_id=? ORDER BY dc.created_at DESC LIMIT 20",
    )
    .all(businessId)
    .map(directChangeView);
}

const MAX_ATTEMPTS = 4;
export async function runDirectCycle(
  db,
  {
    now = Date.now(),
    executeDryRun = async (change) => ({
      sent: false,
      externalCalls: 0,
      prepared: change.commands.length,
    }),
  } = {},
) {
  const job = transaction(db, () => {
    for (const abandoned of db
      .prepare(
        "SELECT * FROM jobs WHERE kind='direct_change' AND status='running' AND available_at<=?",
      )
      .all(now)) {
      const failed = abandoned.attempts >= MAX_ATTEMPTS;
      db.prepare("UPDATE jobs SET status=?,error=? WHERE id=?").run(
        failed ? "failed" : "pending",
        failed ? "Попытки исчерпаны после прерывания процесса." : null,
        abandoned.id,
      );
    }
    const next = db
      .prepare(
        "SELECT * FROM jobs WHERE kind='direct_change' AND status='pending' AND available_at<=? ORDER BY available_at,rowid LIMIT 1",
      )
      .get(now);
    if (!next) return null;
    db.prepare(
      "UPDATE jobs SET status='running',attempts=attempts+1,available_at=? WHERE id=?",
    ).run(now + 60_000, next.id);
    return { ...next, attempts: next.attempts + 1 };
  });
  if (!job) return { status: "idle" };
  const row = db.prepare("SELECT * FROM direct_changes WHERE id=?").get(job.id);
  if (!row) throw new Error("Direct change row missing");
  const change = {
    id: row.id,
    mode: row.mode,
    plan: JSON.parse(row.plan_json),
    commands: JSON.parse(row.commands_json),
  };
  try {
    if (change.mode !== "dry_run")
      throw new AppError(409, "Live-исполнение не разрешено.", "live_gate");
    const result = await executeDryRun(change);
    return transaction(db, () => {
      const current = db
        .prepare("SELECT status,attempts FROM jobs WHERE id=?")
        .get(job.id);
      if (current?.status !== "running" || current.attempts !== job.attempts)
        return { id: job.id, status: "lease_lost" };
      const reconciliation = {
        status: "prepared",
        expectedCommands: change.commands.length,
        preparedCommands: result.prepared,
        externalCalls: result.externalCalls,
        checkedAt: new Date(now).toISOString(),
      };
      db.prepare(
        "UPDATE jobs SET status='succeeded',available_at=?,error=NULL WHERE id=?",
      ).run(now, job.id);
      db.prepare(
        "UPDATE direct_changes SET result_json=?,reconciliation_json=?,updated_at=? WHERE id=?",
      ).run(
        JSON.stringify(result),
        JSON.stringify(reconciliation),
        new Date(now).toISOString(),
        job.id,
      );
      event(db, job.business_id, {
        kind: "direct_dry_run",
        title: "Dry-run плана завершен",
        reason: `${change.commands.length} команд проверены. В Директ отправлено 0 запросов.`,
        rule: "direct/dry-run@1",
        jobId: job.id,
      });
      return { id: job.id, status: "succeeded", reconciliation };
    });
  } catch (error) {
    return transaction(db, () => {
      const failed = job.attempts >= MAX_ATTEMPTS,
        status = failed ? "failed" : "pending",
        delay = Math.min(300_000, 5_000 * 2 ** (job.attempts - 1)),
        message = failed
          ? "Dry-run не прошел после четырех попыток."
          : "Dry-run временно не выполнен; назначен повтор.";
      db.prepare(
        "UPDATE jobs SET status=?,available_at=?,error=? WHERE id=? AND status='running' AND attempts=?",
      ).run(status, now + delay, message, job.id, job.attempts);
      db.prepare("UPDATE direct_changes SET updated_at=? WHERE id=?").run(
        new Date(now).toISOString(),
        job.id,
      );
      return { id: job.id, status, error: message, cause: error.message };
    });
  }
}

export function startDirectWorker(db) {
  let pending = null,
    stopped = false;
  const tick = () => {
    if (stopped || pending) return;
    pending = runDirectCycle(db)
      .catch(() =>
        console.error(JSON.stringify({ event: "direct_worker_error" })),
      )
      .finally(() => (pending = null));
  };
  const timer = setInterval(tick, 2_000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (pending) await pending;
  };
}
