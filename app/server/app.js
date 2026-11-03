import express from "express";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import ExcelJS from "exceljs";
import { z } from "zod";
import {
  AppError,
  requireBusiness,
  events,
  event,
  command,
  transaction,
} from "./db.js";
import {
  token,
  hash,
  cookie,
  sessionCookie,
  sameOrigin,
  encrypt,
  decrypt,
  isPilotOrigin,
  isLoopbackOrigin,
} from "./security.js";
import { canWritePaidAdvertising } from "./live-ads.js";
import {
  seedDemo,
  freshBusiness,
  totals,
  assertBudget,
  rebalance,
  launchDemo,
  generateCreatives,
  tickDemo,
  rollback,
} from "./engine.js";
import {
  installOAuth,
  refreshYandexConnection,
  withYandexConnection,
} from "./oauth.js";
import {
  DirectClient,
  MetricaClient,
  revokeYandexToken,
  refreshYandexToken,
} from "./providers.js";
import { buildMetricaSetup } from "./metrica-setup.js";
import { analyzeSnapshot } from "./advisor.js";
import { createAdvertisingPlan } from "./ai-plan.js";
import { onboardingAssistant } from "./onboarding-chat.js";
import { adLifecycle, adLifecycles, transitionAdLifecycle } from "./ad-lifecycle.js";
import { optimizerActions } from "./optimizer-outbox.js";
import { rollbackOptimizerAction } from "./optimizer-executor.js";
import {
  audienceExperiments,
  createAudienceExperiment,
} from "./audience-experiments.js";
import { enqueueAbReport, enqueueReport, reportView } from "./reports.js";
import {
  assertPortfolioBudget,
  confirmDirectPlan,
  directChangeForPreflight,
  directChanges,
  enqueueDirectDryRun,
  evaluateDirectPreflight,
  previousDirectPreflight,
  saveDirectPreflight,
} from "./direct.js";
import {
  directExecution,
  inspectDirectExecution,
  runApprovedDirectExecution,
} from "./direct-execution.js";
import {
  inspectLifecycleAction,
  lifecycleActions,
  suspendVerifiedCampaign,
} from "./direct-lifecycle.js";
import {
  archiveActions,
  archiveVerifiedCampaign,
  inspectArchiveAction,
} from "./direct-archive.js";
import {
  createDirectAbPlan,
  directAbPlans,
  directAbPlanView,
} from "./direct-ab.js";
import {
  createVerifiedAbVariant,
  directAbActions,
  inspectAbVariantAction,
} from "./direct-ab-action.js";
import {
  applyDirectAbDecision,
  directAbDecisionActions,
  inspectDirectAbDecision,
} from "./direct-ab-decision.js";
import {
  inspectDirectBudget,
  latestDirectBudgetCheck,
  previewDirectBudgetLimit,
} from "./direct-budget.js";
import {
  budgetActions,
  inspectBudgetAction,
  inspectBudgetRollback,
  reduceVerifiedBudget,
  rollbackReducedBudget,
} from "./direct-budget-action.js";
import { summarizeDirectMarking } from "./direct-marking.js";
import {
  inspectModerationAction,
  inspectModerationReadiness,
  moderationActions,
  submitVerifiedModeration,
} from "./direct-moderation.js";
import { latestLiveShadowReview, runLiveShadowReview } from "./live-shadow.js";
import {
  inspectDirectControl,
  latestDirectControlReview,
} from "./direct-control.js";
import {
  inspectResumeAction,
  resumeActions,
  resumeVerifiedCampaign,
} from "./direct-resume.js";
import {
  approveCreativeImage,
  creativeImageFile,
  creativeImages,
  enqueueCreativeImage,
  removeCreativeImage,
} from "./creative-images.js";
import { operationalSnapshot } from "./operations.js";

const text = z.string().trim().min(2).max(160);
const money = z.number().int().positive().max(100000000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const parsed = new Date(v + "T00:00:00Z");
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === v
    );
  }, "Укажите существующую календарную дату");

const reportSourceLabel = (source) =>
  source === "demo"
    ? "Тестовый источник"
    : source === "yandex-sandbox"
      ? "Яндекс · Sandbox"
      : "Яндекс Директ";

const excelText = (value) => {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
};

async function exportReportXlsx(report) {
  const rows = JSON.parse(report.rows_json);
  const totals = JSON.parse(report.totals_json);
  const payload = JSON.parse(report.job_payload);
  const reportType = payload.reportType || "campaign";
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Ритм";
  workbook.created = new Date();
  workbook.modified = new Date();
  const sheet = workbook.addWorksheet("Отчёт", {
    views: [{ state: "frozen", ySplit: 8 }],
  });
  sheet.columns = [
    { key: "date", width: 14 },
    { key: "campaignId", width: 16 },
    { key: "campaign", width: 32 },
    { key: "adId", width: 16 },
    { key: "spent", width: 16 },
    { key: "clicks", width: 13 },
    { key: "impressions", width: 14 },
  ];
  sheet.mergeCells("A1:G1");
  const title = sheet.getCell("A1");
  title.value = "Отчёт по рекламе";
  title.font = { name: "Aptos Display", size: 18, bold: true, color: { argb: "FFFFFFFF" } };
  title.alignment = { vertical: "middle" };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D5D49" } };
  sheet.getRow(1).height = 30;

  const receivedAt = new Date(report.received_at);
  const summary = [
    ["Источник", reportSourceLabel(report.source)],
    ["Период", `${report.date_from} — ${report.date_to}`],
    ["Кабинет", report.login || "Демо"],
    ["Получен", receivedAt],
  ];
  summary.forEach(([label, value], index) => {
    const row = index + 3;
    sheet.getCell(row, 1).value = label;
    sheet.getCell(row, 1).font = { bold: true, color: { argb: "FF48534C" } };
    sheet.getCell(row, 2).value = value;
  });
  sheet.getCell("B6").numFmt = "dd.mm.yyyy hh:mm";

  const headerRow = 8;
  const header = sheet.getRow(headerRow);
  header.values = [
    "Дата",
    "ID кампании",
    "Кампания",
    "ID объявления",
    "Расход, ₽",
    "Клики",
    "Показы",
  ];
  header.height = 24;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF176A55" } };
  });

  rows.forEach((row) => {
    const target = sheet.addRow({
      date: new Date(`${row.Date}T00:00:00Z`),
      campaignId: excelText(row.CampaignId),
      campaign: excelText(row.CampaignName || ""),
      adId: excelText(row.AdId || ""),
      spent: row.spent / 100,
      clicks: row.clicks,
      impressions: row.impressions,
    });
    target.getCell("date").numFmt = "yyyy-mm-dd";
    target.getCell("spent").numFmt = '#,##0.00 "₽"';
    target.getCell("clicks").numFmt = "#,##0";
    target.getCell("impressions").numFmt = "#,##0";
  });

  const totalsRow = headerRow + rows.length + 1;
  sheet.getCell(totalsRow, 4).value = "Итого";
  sheet.getCell(totalsRow, 5).value = totals.spent / 100;
  sheet.getCell(totalsRow, 6).value = totals.clicks;
  sheet.getCell(totalsRow, 7).value = totals.impressions;
  sheet.getRow(totalsRow).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FF17231F" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5F264" } };
  });
  sheet.getCell(totalsRow, 5).numFmt = '#,##0.00 "₽"';
  sheet.getCell(totalsRow, 6).numFmt = "#,##0";
  sheet.getCell(totalsRow, 7).numFmt = "#,##0";
  if (rows.length) {
    sheet.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: headerRow + rows.length, column: 7 },
    };
  }
  return workbook.xlsx.writeBuffer();
}

export const businessSchema = z
  .object({
    name: text,
    category: text,
    city: text,
    website: z
      .string()
      .trim()
      .max(2048)
      .refine((v) => {
        if (!v) return true;
        try {
          return ["https:", "http:"].includes(new URL(v).protocol);
        } catch {
          return false;
        }
      }, "Укажите адрес http(s) или оставьте поле пустым"),
    service: text,
    benefit: text,
    price: z.number().int().min(0).max(10000000),
    budget: money,
    // This is an internal guardrail, not a field a business owner needs to
    // understand or configure during onboarding.
    targetCpa: money.optional(),
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("ru", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }),
    periodStart: date,
    periodEnd: date,
  })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: "Дата окончания раньше начала",
  });

export function withStartingTargetCpa(input) {
  if (input.targetCpa) return input;
  // Start conservatively from the total limit and refine it only after
  // confirmed conversion data arrives. The value is stored in kopecks.
  return {
    ...input,
    targetCpa: Math.max(20_000, Math.min(500_000, Math.round(input.budget * 0.05))),
  };
}

export function attachAdvertisingPlan(state, generated) {
  state.aiPlan = {
    ...generated,
    createdAt: new Date().toISOString(),
    version: "advertising-plan/2",
  };
  state.creatives = generated.plan.ads.map((ad, index) => ({
    id: randomUUID(),
    angle: ad.angle,
    title: ad.title,
    text: ad.text,
    status: "draft",
    kind: "text",
    version: `${generated.provider}/${generated.model}`,
    color: ["sage", "peach", "blue", "lavender"][index] || "sage",
  }));
  return state.aiPlan;
}

export function createApp({
  db,
  config,
  key,
  analyst = analyzeSnapshot,
  revokeToken = revokeYandexToken,
  refreshToken = refreshYandexToken,
  directFactory = (options) => new DirectClient(options),
  metricaFactory = (accessToken) => new MetricaClient(accessToken),
  oauthExchange,
  googleVerifier,
  advertisingPlanner = createAdvertisingPlan,
}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  const attempts = new Map();
  const analyzing = new Set();
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    });
    if (req.path.startsWith("/api") || req.path.startsWith("/auth"))
      res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", (req, res, next) => {
    sameOrigin(req, config.origin);
    next();
  });
  function auth(req) {
    const value = cookie(req, "ritm_session");
    if (!value) return null;
    return (
      db
        .prepare(
          "SELECT users.id, users.name, users.subject FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires_at>?",
        )
        .get(hash(value), Date.now()) || null
    );
  }
  const authenticated = (req, res, next) => {
    req.user = auth(req);
    if (!req.user)
      throw new AppError(401, "Войдите в свой аккаунт.", "unauthorized");
    next();
  };
  app.get("/api/health", (req, res) => {
    db.prepare("SELECT 1").get();
    res.json({
      ok: true,
      mode: canWritePaidAdvertising(config)
        ? "live-managed"
        : config.demo
          ? "demo-enabled"
          : "live-readonly",
      liveLaunch: canWritePaidAdvertising(config),
    });
  });
  app.get("/api/ready", (req, res) => {
    try {
      const snapshot = operationalSnapshot(db);
      res.status(snapshot.ready ? 200 : 503).json(snapshot);
    } catch {
      res.status(503).json({
        ok: false,
        ready: false,
        degraded: true,
        database: { reachable: false },
      });
    }
  });
  app.get("/api/session", (req, res) => {
    const user = auth(req);
    res.json({
      user: user
        ? {
            id: user.id,
            name: user.name,
            demo: user.subject.startsWith("demo:"),
          }
        : null,
      demoAvailable: config.demo,
      googleConfigured: !!(config.googleId && config.googleSecret),
      yandexConfigured: !!(config.yandexId && config.yandexSecret),
      liveLaunch: canWritePaidAdvertising(config),
    });
  });
  app.post("/api/demo", (req, res) => {
    if (!config.demo) throw new AppError(404, "Демо отключено.");
    const ip = req.ip;
    const now = Date.now();
    for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
    const limit = attempts.get(ip) || { count: 0, until: now + 60000 };
    // The demo creates a short-lived local session only. Keep a meaningful
    // abuse limit without making the full acceptance suite exhaust it.
    if (limit.count++ >= 60)
      throw new AppError(429, "Слишком много входов. Подождите минуту.");
    attempts.set(ip, limit);
    const existing = auth(req);
    if (existing?.subject.startsWith("demo:")) return res.json({ ok: true });
    transaction(db, () => {
      const id = randomUUID(),
        businessId = randomUUID(),
        session = token();
      db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(
        id,
        "demo:" + id,
        "Анна",
        new Date().toISOString(),
      );
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        hash(session),
        id,
        Date.now() + 7 * 86400000,
      );
      const state = seedDemo();
      db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
        businessId,
        id,
        JSON.stringify(state),
      );
      event(db, businessId, {
        kind: "connected",
        title: "Тестовый кабинет готов",
        reason:
          "Это вымышленные данные студии. Никакие реальные аккаунты не подключены.",
        rule: "demo",
      });
      event(db, businessId, {
        kind: "experiment",
        title: "Проверяем новую идею объявления",
        reason:
          "Сравниваем близость студии и заботу о себе. Окончательный анализ на 21-й день.",
        rule: "demo",
      });
      sessionCookie(
        res,
        session,
        config.production && !isLoopbackOrigin(config.origin),
      );
    });
    res.status(201).json({ ok: true });
  });
  app.post("/api/logout", (req, res) => {
    db.prepare("DELETE FROM sessions WHERE hash=?").run(
      hash(cookie(req, "ritm_session")),
    );
    sessionCookie(
      res,
      "",
      config.production && !isLoopbackOrigin(config.origin),
      true,
    );
    res.json({ ok: true });
  });
  installOAuth(app, {
    db,
    config,
    key,
    auth,
    directFactory,
    exchange: oauthExchange,
    verifyGoogle: googleVerifier,
  });
  app.get("/api/businesses", authenticated, (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT id,state FROM businesses WHERE user_id=? ORDER BY rowid DESC",
        )
        .all(req.user.id)
        .map((r) => ({ id: r.id, name: JSON.parse(r.state).name })),
    ),
  );
  app.post("/api/assistant/onboarding", authenticated, async (req, res) => {
    const message = z.string().trim().min(2).max(2000).parse(req.body.message);
    const profile = z
      .object({
        name: z.string().max(160).optional(), category: z.string().max(160).optional(), city: z.string().max(160).optional(),
        website: z.string().max(2048).optional(), service: z.string().max(160).optional(), benefit: z.string().max(160).optional(),
        price: z.number().int().min(0).max(10_000_000).optional(), budget: z.number().int().min(1_000).max(1_000_000).optional(),
      })
      .strict()
      .parse(req.body.profile || {});
    res.json(await onboardingAssistant({ message, profile, config }));
  });
  app.post("/api/businesses", authenticated, (req, res) => {
    const input = withStartingTargetCpa(businessSchema.parse(req.body)),
      id = randomUUID(),
      state = freshBusiness(input, req.user.subject.startsWith("demo:"));
    state.creatives = generateCreatives(state);
    transaction(db, () => {
      db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
        id,
        req.user.id,
        JSON.stringify(state),
      );
      event(db, id, {
        kind: "created",
        title: "Бизнес добавлен",
        reason: input.name,
        rule: "user",
      });
    });
    res.status(201).json({ id });
  });
  app.post("/api/businesses/with-plan", authenticated, async (req, res) => {
    const input = withStartingTargetCpa(businessSchema.parse(req.body)),
      id = randomUUID(),
      state = freshBusiness(input, req.user.subject.startsWith("demo:")),
      generated = await advertisingPlanner(state, config),
      plan = attachAdvertisingPlan(state, generated);
    transaction(db, () => {
      db.prepare("INSERT INTO businesses VALUES(?,?,?,1)").run(
        id,
        req.user.id,
        JSON.stringify(state),
      );
      event(db, id, {
        kind: "created",
        title: "Бизнес добавлен",
        reason: input.name,
        rule: "assistant",
      });
      event(db, id, {
        kind: "ai_plan",
        title: "Рекламный план подготовлен",
        reason:
          generated.provider === "ollama"
            ? "Нейросеть предложила аудитории, объявления и безопасное распределение бюджета. Перед запуском план пройдет проверки Директа."
            : "Подготовлен базовый план по данным бизнеса. Его можно уточнить позже.",
        rule: `${generated.provider}/${generated.model}`,
      });
    });
    res.status(201).json({ id, plan });
  });
  app.post("/api/businesses/:id/ai-plan", authenticated, async (req, res) => {
    const original = requireBusiness(db, req.user.id, req.params.id);
    const generated = await advertisingPlanner(original.state, config);
    const response = command(
      db,
      req.user.id,
      original.id,
      req.get("Idempotency-Key"),
      hash(JSON.stringify({ action: "ai-plan" })),
      (business) => {
        if (generated.inputHash !== hash(JSON.stringify({
          name: business.state.name,
          category: business.state.category,
          city: business.state.city,
          service: business.state.service,
          benefit: business.state.benefit,
          price:
            Number.isInteger(business.state.price) && business.state.price > 0
              ? business.state.price
              : null,
          website: business.state.website || null,
          budgetRubles: Math.round(business.state.budget / 100),
          periodStart: business.state.periodStart,
          periodEnd: business.state.periodEnd,
        })))
          throw new AppError(
            409,
            "Данные бизнеса изменились во время подготовки плана. Обновите план ещё раз.",
            "plan_outdated",
          );
        attachAdvertisingPlan(business.state, generated);
        event(db, business.id, {
          kind: "ai_plan",
          title: "Рекламный план подготовлен",
          reason:
            generated.provider === "ollama"
              ? "Нейросеть предложила аудитории, объявления и безопасное распределение бюджета. Перед запуском план пройдет проверки Директа."
              : "Подготовлен базовый план по данным бизнеса. Его можно уточнить позже.",
          rule: `${generated.provider}/${generated.model}`,
        });
        return { plan: business.state.aiPlan };
      },
    );
    res.status(201).json(response);
  });
  app.get("/api/workspace", authenticated, (req, res) => {
    const b = requireBusiness(db, req.user.id, req.query.businessId),
      lifecycle = adLifecycle(db, b.id),
      safeWrites = canWritePaidAdvertising(config);
    const connections = db
      .prepare("SELECT provider,metadata FROM connections WHERE business_id=?")
      .all(b.id)
      .map((r) => {
        const { connectionId: _internalConnectionId, ...metadata } = JSON.parse(
          r.metadata,
        );
        return { provider: r.provider, ...metadata };
      });
    res.json({
      id: b.id,
      version: b.version,
      state: b.state,
      totals: totals(b.state),
      events: events(db, b.id),
      reports: reportView(db, b.id),
      reportJobs: db
        .prepare(
          "SELECT id,status,attempts,available_at AS availableAt,error FROM jobs WHERE business_id=? AND kind='report_sync' ORDER BY rowid DESC LIMIT 5",
        )
        .all(b.id),
      jobs: db
        .prepare(
          "SELECT id,status,attempts,available_at AS availableAt,error FROM jobs WHERE business_id=? AND kind='shadow_analysis' ORDER BY rowid DESC LIMIT 5",
        )
        .all(b.id),
      directChanges: directChanges(db, b.id),
      abPlans: directAbPlans(db, req.user.id, b.id),
      controlReviews: db
        .prepare(
          "SELECT result_json FROM direct_control_reviews WHERE business_id=? ORDER BY checked_at DESC,rowid DESC LIMIT 20",
        )
        .all(b.id)
        .map((row) => JSON.parse(row.result_json)),
      shadowReviews: db
        .prepare(
          "SELECT result_json FROM direct_shadow_reviews WHERE business_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20",
        )
        .all(b.id)
        .map((row) => JSON.parse(row.result_json)),
      shadowReviewJobs: db
        .prepare(
          `
        SELECT id,status,attempts,available_at AS availableAt,error,
               json_extract(payload,'$.changeId') AS changeId
        FROM jobs WHERE business_id=? AND kind='live_shadow_review'
        ORDER BY rowid DESC LIMIT 20
      `,
        )
        .all(b.id),
      adLifecycle: lifecycle,
      adLifecycles: adLifecycles(db, b.id),
      optimizerActions: optimizerActions(db, b.id),
      audienceExperiments: audienceExperiments(db, req.user.id, b.id),
      creativeImages: creativeImages(db, b.id),
      connections,
      capabilities: {
        google: !!config.googleId,
        yandex: !!config.yandexId,
        liveLaunch: !!(safeWrites && lifecycle.status === "moderation"),
        directWritePilot: !!safeWrites,
        directArchivePilot: !!(
          safeWrites &&
          config.directArchivePilot &&
          config.directWritePilot &&
          config.production &&
          isPilotOrigin(config.origin) &&
          config.encryptionConfigured
        ),
        directModerationPilot: !!(safeWrites && lifecycle.status === "paused"),
        directResumePilot: !!(safeWrites && lifecycle.status === "moderation"),
        directBudgetPilot: !!(
          safeWrites && ["active", "paused"].includes(lifecycle.status)
        ),
        directAbVariantPilot: !!(
          safeWrites &&
          config.directAbVariantPilot &&
          config.directWritePilot &&
          config.production &&
          isPilotOrigin(config.origin) &&
          config.encryptionConfigured
        ),
        directAbDecisionPilot: !!(
          safeWrites &&
          config.directAbDecisionPilot &&
          config.directWritePilot &&
          config.production &&
          isPilotOrigin(config.origin) &&
          config.encryptionConfigured
        ),
        abPlanning: true,
        analyst: !!process.env.PYTHON_EXECUTABLE,
        creativeImages: !!(
          (config.creativeImagesEnabled && config.localImageApiUrl) ||
          connections.some((connection) => connection.provider === "openai-image")
        ),
        creativeImageSetup: !!config.encryptionConfigured,
        creativeImageProvider: connections.some(
          (connection) => connection.provider === "openai-image",
        )
          ? "openai"
          : config.creativeImagesEnabled && config.localImageApiUrl
            ? "local"
            : null,
      },
    });
  });
  app.post("/api/businesses/:id/direct/dry-run", authenticated, (req, res) => {
    const requestKey = z.string().uuid().parse(req.headers["idempotency-key"]);
    res
      .status(202)
      .json(
        enqueueDirectDryRun(
          db,
          req.user.id,
          req.params.id,
          requestKey,
          req.body,
        ),
      );
  });
  app.post(
    "/api/businesses/:id/optimizer-actions/:actionId/rollback",
    authenticated,
    async (req, res) => {
      const requestKey = z.string().uuid().parse(req.headers["idempotency-key"]),
        input = z.object({ spendConfirmed: z.literal(true) }).strict().parse(req.body);
      requireBusiness(db, req.user.id, req.params.id);
      const action = optimizerActions(db, req.params.id).find(
        (item) => item.id === req.params.actionId,
      );
      if (!action) throw new AppError(404, "Решение Budget Guard не найдено.");
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        action.changeId,
      );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        ({ credentials, metadata }) =>
          rollbackOptimizerAction(
            db,
            req.user.id,
            business.id,
            action.id,
            requestKey,
            directFactory({
              accessToken: credentials.access_token,
              login: change.plan.login,
              sandbox: false,
            }),
            metadata.connectionId,
            { enabled: true, spendConfirmed: input.spendConfirmed },
          ),
      );
      res.json(result);
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/audience-experiment",
    authenticated,
    (req, res) => {
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      res.status(201).json(
        createAudienceExperiment(
          db,
          req.user.id,
          req.params.id,
          req.params.changeId,
          requestKey,
          req.body,
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/ab-plan",
    authenticated,
    (req, res) => {
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      res
        .status(201)
        .json(
          createDirectAbPlan(
            db,
            req.user.id,
            req.params.id,
            req.params.changeId,
            requestKey,
            req.body,
          ),
        );
    },
  );
  app.post(
    "/api/businesses/:id/direct/ab-plans/:planId/report",
    authenticated,
    (req, res) => {
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      res
        .status(202)
        .json(
          enqueueAbReport(
            db,
            req.user.id,
            req.params.id,
            requestKey,
            req.params.planId,
          ),
        );
    },
  );
  app.get(
    "/api/businesses/:id/direct/ab-plans/:planId/decisions",
    authenticated,
    (req, res) =>
      res.json(
        directAbDecisionActions(
          db,
          req.user.id,
          req.params.id,
          req.params.planId,
        ),
      ),
  );
  app.post(
    "/api/businesses/:id/direct/ab-plans/:planId/decision",
    authenticated,
    async (req, res) => {
      if (
        !canWritePaidAdvertising(config) ||
        !config.directAbDecisionPilot ||
        !config.directWritePilot ||
        !config.production ||
        !isPilotOrigin(config.origin) ||
        !config.encryptionConfigured
      )
        throw new AppError(
          409,
          "Применение A/B-решений отключено на этом сервере.",
          "live_gate",
        );
      const requestKey = z
          .string()
          .uuid()
          .parse(req.headers["idempotency-key"]),
        input = z
          .object({
            operation: z.enum(["rollback_variant", "apply_outcome"]),
            confirmCampaignId: z.number().int().positive(),
            confirmTargetAdId: z.string().regex(/^[1-9]\d*$/),
            confirmed: z.literal(true),
          })
          .strict()
          .parse(req.body),
        plan = directAbPlanView(
          db,
          req.user.id,
          req.params.id,
          req.params.planId,
        ),
        { business, change } = directChangeForPreflight(
          db,
          req.user.id,
          req.params.id,
          plan.changeId,
        );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        ({ credentials, metadata }) =>
          applyDirectAbDecision(
            db,
            req.user.id,
            business.id,
            plan.id,
            requestKey,
            directFactory({
              accessToken: credentials.access_token,
              login: change.plan.login,
              sandbox: false,
            }),
            metadata.connectionId,
            { enabled: true, ...input },
          ),
      );
      res.json(result);
    },
  );
  app.post(
    "/api/businesses/:id/direct/ab-plans/:planId/decisions/:actionId/inspect",
    authenticated,
    async (req, res) => {
      const plan = directAbPlanView(
          db,
          req.user.id,
          req.params.id,
          req.params.planId,
        ),
        { business, change } = directChangeForPreflight(
          db,
          req.user.id,
          req.params.id,
          plan.changeId,
        );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        ({ credentials }) =>
          inspectDirectAbDecision(
            db,
            req.user.id,
            business.id,
            plan.id,
            req.params.actionId,
            directFactory({
              accessToken: credentials.access_token,
              login: change.plan.login,
              sandbox: false,
            }),
          ),
      );
      res.json(result);
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/ab-actions",
    authenticated,
    (req, res) =>
      res.json(
        directAbActions(db, req.user.id, req.params.id, req.params.changeId),
      ),
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/ab-variant",
    authenticated,
    async (req, res) => {
      if (
        !canWritePaidAdvertising(config) ||
        !config.directAbVariantPilot ||
        !config.directWritePilot ||
        !config.production ||
        !isPilotOrigin(config.origin) ||
        !config.encryptionConfigured
      )
        throw new AppError(
          409,
          "Создание варианта Б отключено на этом сервере.",
          "live_gate",
        );
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const confirmation = z
        .object({
          confirmCampaignId: z.number().int().positive(),
          confirmControlAdId: z.string().regex(/^[1-9]\d*$/),
          variantConfirmed: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          return createVerifiedAbVariant(
            db,
            req.user.id,
            business.id,
            change.id,
            requestKey,
            directFactory({
              accessToken: credentials.access_token,
              login: change.plan.login,
              sandbox: false,
            }),
            metadata.connectionId,
            { enabled: true, ...confirmation },
          );
        },
      );
      res.json(result);
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/ab-variant/:actionId/inspect",
    authenticated,
    async (req, res) => {
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) =>
          inspectAbVariantAction(
            db,
            req.user.id,
            business.id,
            change.id,
            req.params.actionId,
            directFactory({
              accessToken: credentials.access_token,
              login: change.plan.login,
              sandbox: false,
            }),
          ),
      );
      res.json(result);
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/preflight",
    authenticated,
    async (req, res) => {
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const previous = previousDirectPreflight(
        db,
        business.id,
        requestKey,
        change.id,
      );
      if (previous) return res.json(previous);
      if (
        change.status !== "succeeded" ||
        change.reconciliation?.status !== "prepared"
      )
        throw new AppError(409, "Сначала дождитесь завершения dry-run плана.");
      let readCalls = 0;
      const report = await withYandexConnection(
        {
          db,
          config,
          key,
          businessId: business.id,
          refreshToken,
        },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(
              409,
              "Подключение указывает на отключенную песочницу Яндекса.",
            );
          readCalls += 1;
          const available = await directFactory({
            accessToken: credentials.access_token,
            sandbox: false,
          }).clients();
          const clients = available.Clients || [];
          const selected = clients.find(
            (item) => item.Login === change.plan.login,
          );
          if (selected) readCalls += 1;
          const remote = selected
            ? await directFactory({
                accessToken: credentials.access_token,
                login: selected.Login,
                sandbox: false,
              }).campaigns()
            : { Campaigns: [] };
          return evaluateDirectPreflight(business, change, {
            clients,
            campaigns: remote.Campaigns || [],
            limitedBy: remote.LimitedBy,
            readCalls,
            connectionId: metadata.connectionId,
          });
        },
      );
      const saved = saveDirectPreflight(
          db,
          req.user.id,
          business.id,
          change.id,
          requestKey,
          report,
        );
      transitionAdLifecycle(db, business.id, saved.ready ? "ready" : "blocked", {
        changeId: change.id,
        reason: saved.ready
          ? "План и подключение проверены. Можно создать выключенный черновик."
          : "Проверка нашла условия, которые нужно исправить до создания черновика.",
      });
      res.json(saved);
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/confirm",
    authenticated,
    (req, res) => {
      const { planFingerprint } = z
        .object({
          planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(req.body);
      res.json(
        confirmDirectPlan(
          db,
          req.user.id,
          req.params.id,
          req.params.changeId,
          planFingerprint,
        ),
      );
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/execution",
    authenticated,
    (req, res) => {
      res.json(
        directExecution(db, req.user.id, req.params.id, req.params.changeId),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/execution/inspect",
    authenticated,
    async (req, res) => {
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const execution = directExecution(
        db,
        req.user.id,
        business.id,
        change.id,
      );
      if (execution.status !== "needs_reconciliation")
        throw new AppError(409, "Для этого исполнения сверка не требуется.");
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          const client = directFactory({
            accessToken: credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          });
          return inspectDirectExecution(
            db,
            req.user.id,
            business.id,
            change.id,
            client,
            metadata.connectionId,
          );
        },
      );
      res.json(result);
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/execute",
    authenticated,
    async (req, res) => {
      if (!canWritePaidAdvertising(config))
        throw new AppError(
          409,
          "Создание выключенной кампании пока недоступно на этом сервере.",
          "live_gate",
        );
      const { planFingerprint } = z
        .object({ planFingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(req.body);
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      if (planFingerprint !== hash(JSON.stringify(change.plan)))
        throw new AppError(409, "План изменился после подтверждения.");
      assertPortfolioBudget(db, business, change);
      let lifecycle = adLifecycle(db, business.id, change.id);
      if (
        lifecycle.status === "draft" &&
        db
          .prepare(
            "SELECT 1 FROM direct_approvals WHERE business_id=? AND change_id=? AND consumed_at IS NULL",
          )
          .get(business.id, change.id)
      ) {
        lifecycle = transitionAdLifecycle(db, business.id, "ready", {
          changeId: change.id,
          reason: "Ранее подтверждённый план перенесён в штатную машину состояний.",
        });
      }
      if (lifecycle.status !== "ready" || lifecycle.changeId !== change.id)
        throw new AppError(
          409,
          "Сначала повторите проверку этого плана.",
          "lifecycle_conflict",
        );
      transitionAdLifecycle(db, business.id, "creating", {
        changeId: change.id,
        reason: "Создаём только выключенный черновик и проверяем его чтением API.",
      });
      const { credentials, metadata } = await refreshYandexConnection({
        db,
        config,
        key,
        businessId: business.id,
        refreshToken,
      });
      if (metadata.sandbox)
        throw new AppError(409, "Sandbox Директа недоступен.");
      const client = directFactory({
        accessToken: credentials.access_token,
        login: change.plan.login,
        sandbox: false,
      });
      try {
        const result = await runApprovedDirectExecution(
          db,
          req.user.id,
          business.id,
          change.id,
          client,
          { enabled: true },
        );
        transitionAdLifecycle(
          db,
          business.id,
          result.status === "needs_reconciliation" ? "needs_reconciliation" : "paused",
          {
            changeId: change.id,
            reason:
              result.status === "needs_reconciliation"
                ? "Ответ Директа нужно сверить чтением; повторная запись запрещена."
                : "Выключенный черновик создан и повторно прочитан. Показы не запущены.",
          },
        );
        res.json(result);
      } catch (error) {
        transitionAdLifecycle(db, business.id, "blocked", {
          changeId: change.id,
          reason: "Создание черновика остановлено. Проверьте подключение и повторите preflight.",
        });
        throw error;
      }
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/lifecycle",
    authenticated,
    (req, res) => {
      res.json(
        lifecycleActions(db, req.user.id, req.params.id, req.params.changeId),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/suspend",
    authenticated,
    async (req, res) => {
      if (!canWritePaidAdvertising(config))
        throw new AppError(
          409,
          "Управление кампанией пока недоступно на этом сервере.",
          "live_gate",
        );
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const lifecycle = adLifecycle(db, business.id, change.id);
      if (
        !["active", "paused"].includes(lifecycle.status) ||
        lifecycle.changeId !== change.id
      )
        throw new AppError(
          409,
          "Остановка доступна только для созданной кампании этого бизнеса.",
          "lifecycle_conflict",
        );
      const { credentials, metadata } = await refreshYandexConnection({
        db,
        config,
        key,
        businessId: business.id,
        refreshToken,
      });
      if (metadata.sandbox)
        throw new AppError(409, "Sandbox Директа недоступен.");
      const client = directFactory({
        accessToken: credentials.access_token,
        login: change.plan.login,
        sandbox: false,
      });
      const result = await suspendVerifiedCampaign(
        db,
        req.user.id,
        business.id,
        change.id,
        requestKey,
        client,
        { enabled: true },
      );
      transitionAdLifecycle(
        db,
        business.id,
        result.status === "needs_reconciliation"
          ? "needs_reconciliation"
          : result.status === "succeeded"
            ? "paused"
            : lifecycle.status,
        {
          changeId: change.id,
          reason:
            result.status === "succeeded"
              ? "Показы остановлены и состояние подтверждено чтением Direct."
              : result.status === "needs_reconciliation"
                ? "Результат остановки нужно сверить; повторная команда запрещена."
                : "Состояние кампании не изменилось.",
        },
      );
      res.json(result);
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/lifecycle/:actionId/inspect",
    authenticated,
    async (req, res) => {
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          const client = directFactory({
            accessToken: credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          });
          return inspectLifecycleAction(
            db,
            req.user.id,
            business.id,
            change.id,
            req.params.actionId,
            client,
          );
        },
      );
      res.json(result);
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/archive",
    authenticated,
    (req, res) => {
      res.json(
        archiveActions(db, req.user.id, req.params.id, req.params.changeId),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/archive",
    authenticated,
    async (req, res) => {
      if (
        !canWritePaidAdvertising(config) ||
        !config.directArchivePilot ||
        !config.directWritePilot ||
        !config.production ||
        !isPilotOrigin(config.origin) ||
        !config.encryptionConfigured
      )
        throw new AppError(
          409,
          "Архивация кампании пока недоступна на этом сервере.",
          "archive_gate",
        );
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const body = z
        .object({
          confirmCampaignId: z.number().int().positive().safe(),
          confirmedNoFunds: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const { credentials, metadata } = await refreshYandexConnection({
        db,
        config,
        key,
        businessId: business.id,
        refreshToken,
      });
      if (metadata.sandbox)
        throw new AppError(409, "Sandbox Директа недоступен.");
      const client = directFactory({
        accessToken: credentials.access_token,
        login: change.plan.login,
        sandbox: false,
      });
      res.json(
        await archiveVerifiedCampaign(
          db,
          req.user.id,
          business.id,
          change.id,
          requestKey,
          body.confirmCampaignId,
          client,
          { enabled: true, confirmedNoFunds: true },
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/archive/:actionId/inspect",
    authenticated,
    async (req, res) => {
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          const client = directFactory({
            accessToken: credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          });
          return inspectArchiveAction(
            db,
            req.user.id,
            business.id,
            change.id,
            req.params.actionId,
            client,
          );
        },
      );
      res.json(result);
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/budget-check",
    authenticated,
    (req, res) => {
      res.json(
        latestDirectBudgetCheck(
          db,
          req.user.id,
          req.params.id,
          req.params.changeId,
        ),
      );
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/marking-check",
    authenticated,
    async (req, res) => {
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      if (
        directExecution(db, req.user.id, business.id, change.id).status !==
        "succeeded"
      )
        throw new AppError(409, "Кампания ещё не создана и не сверена.");
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          const execution = db
            .prepare(
              "SELECT connection_id FROM direct_executions WHERE business_id=? AND change_id=?",
            )
            .get(business.id, change.id);
          if (execution?.connection_id !== metadata.connectionId)
            throw new AppError(
              409,
              "Кабинет изменился после создания кампании.",
            );
          const client = directFactory({
            accessToken: credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          });
          return summarizeDirectMarking(
            await client.advertiserMarkingDetails(),
          );
        },
      );
      res.json(result);
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/moderation-readiness",
    authenticated,
    async (req, res) => {
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          const client = directFactory({
            accessToken: credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          });
          return inspectModerationReadiness(
            db,
            req.user.id,
            business.id,
            change.id,
            client,
            metadata.connectionId,
          );
        },
      );
      res.json(result);
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/moderation-actions",
    authenticated,
    (req, res) =>
      res.json(
        moderationActions(db, req.user.id, req.params.id, req.params.changeId),
      ),
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/moderate",
    authenticated,
    async (req, res) => {
      if (!canWritePaidAdvertising(config))
        throw new AppError(
          409,
          "Отправка на модерацию отключена на этом сервере.",
          "live_gate",
        );
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const confirmations = z
        .object({
          advertiserConfirmed: z.literal(true),
          siteConfirmed: z.literal(true),
        })
        .parse(req.body);
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const lifecycle = adLifecycle(db, business.id, change.id);
      if (lifecycle.status !== "paused" || lifecycle.changeId !== change.id)
        throw new AppError(
          409,
          "Сначала создайте и проверьте выключенный черновик.",
          "lifecycle_conflict",
        );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          const client = directFactory({
            accessToken: credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          });
          return submitVerifiedModeration(
            db,
            req.user.id,
            business.id,
            change.id,
            requestKey,
            client,
            metadata.connectionId,
            { enabled: true, ...confirmations },
          );
        },
      );
      transitionAdLifecycle(
        db,
        business.id,
        result.status === "succeeded"
          ? "moderation"
          : result.status === "needs_reconciliation"
            ? "needs_reconciliation"
            : "paused",
        {
          changeId: change.id,
          reason:
            result.status === "succeeded"
              ? "Объявления отправлены на модерацию; показы ещё не запущены."
              : result.status === "needs_reconciliation"
                ? "Результат отправки на модерацию нужно сверить чтением Direct."
                : "Модерация не началась; выключенный черновик сохранён.",
        },
      );
      res.json(result);
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/moderation/:actionId/inspect",
    authenticated,
    async (req, res) => {
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          const client = directFactory({
            accessToken: credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          });
          return inspectModerationAction(
            db,
            req.user.id,
            business.id,
            change.id,
            req.params.actionId,
            client,
          );
        },
      );
      res.json(result);
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/budget-preview",
    authenticated,
    (req, res) => {
      const { proposedLimitKopecks } = z
        .object({ proposedLimitKopecks: money })
        .parse(req.body);
      res.json(
        previewDirectBudgetLimit(
          db,
          req.user.id,
          req.params.id,
          req.params.changeId,
          proposedLimitKopecks,
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/budget-check",
    authenticated,
    async (req, res) => {
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          const client = directFactory({
            accessToken: credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          });
          return inspectDirectBudget(
            db,
            req.user.id,
            business.id,
            change.id,
            client,
            metadata.connectionId,
          );
        },
      );
      res.json(result);
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/budget-actions",
    authenticated,
    (req, res) =>
      res.json(
        budgetActions(db, req.user.id, req.params.id, req.params.changeId),
      ),
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/budget-limit",
    authenticated,
    async (req, res) => {
      if (!canWritePaidAdvertising(config))
        throw new AppError(
          409,
          "Изменение лимита отключено на этом сервере.",
          "live_gate",
        );
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const confirmations = z
        .object({
          proposedLimitKopecks: money,
          confirmCampaignId: z.number().int().positive(),
          confirmPreviousLimitKopecks: money,
          budgetConfirmed: z.literal(true),
        })
        .parse(req.body);
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const lifecycle = adLifecycle(db, business.id, change.id);
      if (
        !["active", "paused"].includes(lifecycle.status) ||
        lifecycle.changeId !== change.id
      )
        throw new AppError(
          409,
          "Изменение лимита доступно только для созданной кампании этого бизнеса.",
          "lifecycle_conflict",
        );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          return reduceVerifiedBudget(
            db,
            req.user.id,
            business.id,
            change.id,
            requestKey,
            directFactory({
              accessToken: credentials.access_token,
              login: change.plan.login,
              sandbox: false,
            }),
            metadata.connectionId,
            { enabled: true, ...confirmations },
          );
        },
      );
      res.json(result);
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/budget-limit/:actionId/inspect",
    authenticated,
    async (req, res) => {
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          return inspectBudgetAction(
            db,
            req.user.id,
            business.id,
            change.id,
            req.params.actionId,
            directFactory({
              accessToken: credentials.access_token,
              login: change.plan.login,
              sandbox: false,
            }),
          );
        },
      );
      res.json(result);
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/budget-limit/:actionId/rollback",
    authenticated,
    async (req, res) => {
      if (!canWritePaidAdvertising(config))
        throw new AppError(
          409,
          "Восстановление лимита отключено на этом сервере.",
          "live_gate",
        );
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const confirmations = z
        .object({
          spendConfirmed: z.literal(true),
          confirmCurrentLimitKopecks: money,
          confirmRestoredLimitKopecks: money,
        })
        .strict()
        .parse(req.body);
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const knownAction = budgetActions(
        db,
        req.user.id,
        business.id,
        change.id,
      ).find((item) => item.id === req.params.actionId);
      if (!knownAction) throw new AppError(404, "Изменение лимита не найдено.");
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          return rollbackReducedBudget(
            db,
            req.user.id,
            business.id,
            knownAction.id,
            requestKey,
            directFactory({
              accessToken: credentials.access_token,
              login: change.plan.login,
              sandbox: false,
            }),
            metadata.connectionId,
            { enabled: true, ...confirmations },
          );
        },
      );
      res.json(result);
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/budget-limit/:actionId/rollback/inspect",
    authenticated,
    async (req, res) => {
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const knownAction = budgetActions(
        db,
        req.user.id,
        business.id,
        change.id,
      ).find((item) => item.id === req.params.actionId);
      if (!knownAction) throw new AppError(404, "Изменение лимита не найдено.");
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          return inspectBudgetRollback(
            db,
            req.user.id,
            business.id,
            knownAction.id,
            directFactory({
              accessToken: credentials.access_token,
              login: change.plan.login,
              sandbox: false,
            }),
          );
        },
      );
      res.json(result);
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/control-review",
    authenticated,
    (req, res) => {
      res.json(
        latestDirectControlReview(
          db,
          req.user.id,
          req.params.id,
          req.params.changeId,
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/control-review",
    authenticated,
    async (req, res) => {
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          return inspectDirectControl(
            db,
            req.user.id,
            business.id,
            change.id,
            requestKey,
            directFactory({
              accessToken: credentials.access_token,
              login: change.plan.login,
              sandbox: false,
            }),
            metadata.connectionId,
          );
        },
      );
      res.json(result);
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/resume-actions",
    authenticated,
    (req, res) =>
      res.json(
        resumeActions(db, req.user.id, req.params.id, req.params.changeId),
      ),
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/resume",
    authenticated,
    async (req, res) => {
      if (!canWritePaidAdvertising(config))
        throw new AppError(
          409,
          "Запуск показов отключён на этом сервере.",
          "live_gate",
        );
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const confirmations = z
        .object({
          advertiserConfirmed: z.literal(true),
          siteConfirmed: z.literal(true),
          markingConfirmed: z.literal(true),
          spendConfirmed: z.literal(true),
          confirmCampaignId: z.number().int().positive(),
          confirmLimitKopecks: money,
        })
        .parse(req.body);
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const lifecycle = adLifecycle(db, business.id, change.id);
      if (lifecycle.status !== "moderation" || lifecycle.changeId !== change.id)
        throw new AppError(
          409,
          "Сначала дождитесь результата модерации и повторите проверку запуска.",
          "lifecycle_conflict",
        );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          return resumeVerifiedCampaign(
            db,
            req.user.id,
            business.id,
            change.id,
            requestKey,
            directFactory({
              accessToken: credentials.access_token,
              login: change.plan.login,
              sandbox: false,
            }),
            metadata.connectionId,
            { enabled: true, ...confirmations },
          );
        },
      );
      transitionAdLifecycle(
        db,
        business.id,
        result.status === "succeeded"
          ? "active"
          : result.status === "needs_reconciliation"
            ? "needs_reconciliation"
            : "moderation",
        {
          changeId: change.id,
          reason:
            result.status === "succeeded"
              ? "Показы запущены после проверки лимита, маркировки и повторного чтения Direct."
              : result.status === "needs_reconciliation"
                ? "Результат запуска нужно сверить; повторный write-запрос запрещён."
                : "Запуск не выполнен; кампания остаётся остановленной.",
        },
      );
      res.json(result);
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/resume/:actionId/inspect",
    authenticated,
    async (req, res) => {
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          return inspectResumeAction(
            db,
            req.user.id,
            business.id,
            change.id,
            req.params.actionId,
            directFactory({
              accessToken: credentials.access_token,
              login: change.plan.login,
              sandbox: false,
            }),
          );
        },
      );
      res.json(result);
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/shadow-review",
    authenticated,
    (req, res) => {
      res.json(
        latestLiveShadowReview(
          db,
          req.user.id,
          req.params.id,
          req.params.changeId,
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/shadow-review",
    authenticated,
    async (req, res) => {
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const { business, change } = directChangeForPreflight(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
      );
      const result = await withYandexConnection(
        { db, config, key, businessId: business.id, refreshToken },
        async ({ credentials, metadata }) => {
          if (metadata.sandbox)
            throw new AppError(409, "Sandbox Директа недоступен.");
          return runLiveShadowReview(
            db,
            req.user.id,
            business.id,
            change.id,
            requestKey,
            {
              connectionId: metadata.connectionId,
              metrica: metricaFactory(credentials.access_token),
              direct: directFactory({
                accessToken: credentials.access_token,
                login: change.plan.login,
                sandbox: false,
              }),
            },
          );
        },
      );
      res.json(result);
    },
  );
  app.put(
    "/api/businesses/:id/image-provider/openai",
    authenticated,
    (req, res) => {
      if (!config.encryptionConfigured)
        throw new AppError(
          409,
          "Для ключа OpenAI нужен постоянный ключ шифрования сервера.",
          "encryption_not_configured",
        );
      const apiKey = z
        .object({ apiKey: z.string().trim().min(16).max(512) })
        .strict()
        .parse(req.body).apiKey;
      const business = requireBusiness(db, req.user.id, req.params.id),
        connectedAt = new Date().toISOString();
      transaction(db, () => {
        db.prepare(
          `INSERT INTO connections(business_id,provider,encrypted,metadata)
           VALUES(?,?,?,?)
           ON CONFLICT(business_id,provider) DO UPDATE SET encrypted=excluded.encrypted,metadata=excluded.metadata`,
        ).run(
          business.id,
          "openai-image",
          encrypt({ apiKey }, key, business.id + ":openai-image"),
          JSON.stringify({
            connectedAt,
            sandbox: false,
            clients: [],
            model: config.openAiImageModel,
            purpose: "image_generation",
          }),
        );
        event(db, business.id, {
          kind: "creative_provider_connected",
          title: "Подключена генерация изображений",
          reason:
            "Ключ сохранён на сервере. Каждый новый вариант создаётся только после вашего действия.",
          rule: "creative/openai-gpt-image-2.5@1",
        });
      });
      res.json({ connected: true, model: config.openAiImageModel });
    },
  );
  app.delete(
    "/api/businesses/:id/image-provider/openai",
    authenticated,
    (req, res) => {
      const business = requireBusiness(db, req.user.id, req.params.id),
        result = db
          .prepare(
            "DELETE FROM connections WHERE business_id=? AND provider='openai-image'",
          )
          .run(business.id);
      if (!result.changes)
        throw new AppError(404, "Генерация OpenAI не подключена.");
      event(db, business.id, {
        kind: "creative_provider_disconnected",
        title: "Генерация изображений отключена",
        reason:
          "Новые изображения больше не создаются. Уже сохранённые варианты останутся на проверке.",
        rule: "creative/openai-gpt-image-2.5@1",
      });
      res.json({ connected: false });
    },
  );
  app.post("/api/businesses/:id/creative-images", authenticated, (req, res) => {
    const openAi = db
      .prepare(
        "SELECT 1 FROM connections WHERE business_id=? AND provider='openai-image'",
      )
      .get(req.params.id);
    if (!openAi && (!config.creativeImagesEnabled || !config.localImageApiUrl))
      throw new AppError(
        409,
        "Сначала подключите генерацию изображений.",
        "creative_images_disabled",
      );
    const requestKey = z.string().uuid().parse(req.headers["idempotency-key"]);
    res
      .status(202)
      .json(
        enqueueCreativeImage(
          db,
          req.user.id,
          req.params.id,
          requestKey,
          req.body,
          {
            dailyLimit: config.creativeDailyLimit,
            provider: openAi ? "openai" : "local-openvino",
            model: openAi ? config.openAiImageModel : config.localImageModel,
          },
        ),
      );
  });
  app.post(
    "/api/businesses/:id/creative-images/:assetId/approve",
    authenticated,
    (req, res) => {
      res.json(
        approveCreativeImage(
          db,
          req.user.id,
          req.params.id,
          req.params.assetId,
        ),
      );
    },
  );
  app.get(
    "/api/businesses/:id/creative-images/:assetId/file",
    authenticated,
    (req, res) => {
      const asset = creativeImageFile(
          db,
          req.user.id,
          req.params.id,
          req.params.assetId,
        ),
        root = resolve(config.assetStoragePath),
        filename = resolve(root, asset.storage_name);
      if (!filename.startsWith(root + sep))
        throw new AppError(500, "Некорректный путь к ассету.");
      res.type(asset.mime_type).sendFile(filename);
    },
  );
  app.delete(
    "/api/businesses/:id/creative-images/:assetId",
    authenticated,
    async (req, res) => {
      res.json(
        await removeCreativeImage(
          db,
          req.user.id,
          req.params.id,
          req.params.assetId,
          config.assetStoragePath,
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/connections/yandex/disconnect",
    authenticated,
    async (req, res) => {
      const b = requireBusiness(db, req.user.id, req.params.id);
      const row = db
        .prepare(
          "SELECT * FROM connections WHERE business_id=? AND provider='yandex'",
        )
        .get(b.id);
      if (!row) throw new AppError(404, "Подключение Яндекса не найдено.");
      const credentials = decrypt(row.encrypted, key, b.id + ":yandex");
      let revoked = false,
        warning = null;
      try {
        const result = await revokeToken(
          credentials.access_token,
          config.yandexId,
          config.yandexSecret,
        );
        revoked = result?.status === "ok";
        if (!revoked) warning = "Яндекс не подтвердил отзыв токена.";
      } catch {
        warning =
          "Локальное подключение удалено, но Яндекс не подтвердил отзыв токена. Отзовите доступ в Яндекс ID.";
      }
      transaction(db, () => {
        db.prepare(
          "DELETE FROM connections WHERE business_id=? AND provider='yandex'",
        ).run(b.id);
        db.prepare(
          "UPDATE jobs SET status='cancelled',error='Подключение Яндекса отключено пользователем.' WHERE business_id=? AND kind='report_sync' AND status IN ('pending','running')",
        ).run(b.id);
        event(db, b.id, {
          kind: "disconnected",
          title: "Яндекс отключен",
          reason: revoked
            ? "Токен отозван и удален из зашифрованного хранилища."
            : warning,
          rule: "user",
        });
      });
      res.json({ ok: true, revoked, warning });
    },
  );
  app.post(
    "/api/businesses/:id/metrica/bind",
    authenticated,
    async (req, res) => {
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const input = z
        .object({
          counterId: z.string().regex(/^\d+$/),
          goalId: z.string().regex(/^\d+$/),
        })
        .strict()
        .parse(req.body);
      const b = requireBusiness(db, req.user.id, req.params.id);
      if (b.state.mode === "demo")
        throw new AppError(409, "В демо используется тестовая аналитика.");
      const row = db
        .prepare(
          "SELECT * FROM connections WHERE business_id=? AND provider='yandex'",
        )
        .get(b.id);
      if (!row) throw new AppError(409, "Сначала подключите Яндекс.");
      const [counters, goals] = await withYandexConnection(
        {
          db,
          config,
          key,
          businessId: b.id,
          refreshToken,
        },
        async ({ credentials }) => {
          const metrica = metricaFactory(credentials.access_token);
          return Promise.all([
            metrica.counters(),
            metrica.goals(input.counterId),
          ]);
        },
      );
      if (
        !(counters.counters || []).some((c) => String(c.id) === input.counterId)
      )
        throw new AppError(403, "Счетчик недоступен этому подключению.");
      if (!(goals.goals || []).some((g) => String(g.id) === input.goalId))
        throw new AppError(403, "Цель не найдена в выбранном счетчике.");
      const response = command(
        db,
        req.user.id,
        b.id,
        requestKey,
        hash(JSON.stringify(input)),
        (business) => {
          business.state.counterId = input.counterId;
          business.state.goalId = input.goalId;
          event(db, business.id, {
            kind: "analytics",
            title: "Цель Метрики выбрана",
            reason: `Счетчик ${input.counterId}, цель ${input.goalId}.`,
            rule: "user",
          });
          return { message: "Цель Метрики сохранена" };
        },
      );
      res.json(response);
    },
  );
  app.get(
    "/api/businesses/:id/metrica/setup",
    authenticated,
    async (req, res) => {
      const b = requireBusiness(db, req.user.id, req.params.id);
      if (b.state.mode === "demo")
        throw new AppError(409, "В демо используется тестовая аналитика.");
      if (!b.state.counterId || !b.state.goalId)
        throw new AppError(409, "Сначала выберите счетчик и цель Метрики.");
      const result = await withYandexConnection(
        { db, config, key, businessId: b.id, refreshToken },
        async ({ credentials }) => {
          const metrica = metricaFactory(credentials.access_token);
          const [counters, goals] = await Promise.all([
            metrica.counters(),
            metrica.goals(b.state.counterId),
          ]);
          const counter = (counters.counters || []).find(
              (item) => String(item.id) === String(b.state.counterId),
            ),
            goal = (goals.goals || []).find(
              (item) => String(item.id) === String(b.state.goalId),
            );
          return buildMetricaSetup({
            counter,
            goal,
            website: b.state.website,
          });
        },
      );
      res.json(result);
    },
  );
  app.post("/api/businesses/:id/reports", authenticated, (req, res) => {
    const requestKey = z.string().uuid().parse(req.headers["idempotency-key"]);
    const input = z
      .object({
        login: z.string().trim().max(160).default(""),
        scenario: z.enum(["normal", "revised", "pending"]).default("normal"),
      })
      .strict()
      .parse(req.body);
    res
      .status(202)
      .json(enqueueReport(db, req.user.id, req.params.id, requestKey, input));
  });
  app.get(
    "/api/businesses/:id/reports/:reportId/raw",
    authenticated,
    (req, res) => {
      const b = requireBusiness(db, req.user.id, req.params.id);
      const report = db
        .prepare(
          "SELECT source,login,date_from AS dateFrom,date_to AS dateTo,currency,include_vat AS includeVat,received_at AS receivedAt,request_id AS requestId,raw_hash AS sha256,raw_tsv AS rawTsv,metrica_json AS metricaJson FROM report_snapshots WHERE id=? AND business_id=?",
        )
        .get(req.params.reportId, b.id);
      if (!report) throw new AppError(404, "Отчет не найден.");
      const { metricaJson, ...source } = report;
      res
        .set(
          "Content-Disposition",
          'attachment; filename="ritm-report-source.json"',
        )
        .json({
          ...source,
          metrica: metricaJson ? JSON.parse(metricaJson) : null,
        });
    },
  );
  app.get(
    "/api/businesses/:id/reports/:reportId/xlsx",
    authenticated,
    async (req, res) => {
      const b = requireBusiness(db, req.user.id, req.params.id);
      const report = db
        .prepare(
          `SELECT rs.source,rs.login,rs.date_from,rs.date_to,rs.received_at,
                  rs.rows_json,rs.totals_json,j.payload AS job_payload
           FROM report_snapshots rs JOIN jobs j ON j.id=rs.job_id
           WHERE rs.id=? AND rs.business_id=?`,
        )
        .get(req.params.reportId, b.id);
      if (!report) throw new AppError(404, "Отчет не найден.");
      const file = await exportReportXlsx(report);
      res
        .type(
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .set(
          "Content-Disposition",
          `attachment; filename="ritm-report-${report.date_from}-${report.date_to}.xlsx"`,
        )
        .send(Buffer.from(file));
    },
  );
  app.post("/api/businesses/:id/analyze", authenticated, async (req, res) => {
    const requestKey = z.string().uuid().parse(req.headers["idempotency-key"]);
    const original = requireBusiness(db, req.user.id, req.params.id);
    const fingerprint = hash("analyze/v1");
    const previous = db
      .prepare("SELECT * FROM commands WHERE business_id=? AND key=?")
      .get(original.id, requestKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError(409, "Ключ уже использован другой операцией.");
      return res.json(JSON.parse(previous.response));
    }
    if (!original.state.campaigns.length)
      throw new AppError(
        409,
        "Сначала создайте направления и соберите статистику.",
      );
    if (analyzing.has(req.user.id) || analyzing.size >= 4)
      throw new AppError(
        429,
        "Аналитик занят. Повторите запрос после завершения текущего анализа.",
      );
    analyzing.add(req.user.id);
    try {
      const report = await analyst(original.state);
      const response = command(
        db,
        req.user.id,
        original.id,
        requestKey,
        fingerprint,
        (b) => {
          if (b.version !== original.version)
            throw new AppError(
              409,
              "Данные изменились во время анализа. Запустите его заново.",
              "stale_analysis",
            );
          b.state.analysis = {
            ...report,
            createdAt: new Date().toISOString(),
            stateVersion: b.version + 1,
          };
          event(db, b.id, {
            kind: "analysis",
            title: "Подготовлены рекомендации",
            reason:
              report.provider === "rules"
                ? "Python-анализ по правилам. Реклама и лимиты не изменены."
                : "Локальная LLM подготовила предложения. Реклама и лимиты не изменены.",
            rule: report.version,
          });
          return { message: "Анализ готов. Настройки рекламы не изменены." };
        },
      );
      res.json(response);
    } finally {
      analyzing.delete(req.user.id);
    }
  });
  app.post("/api/businesses/:id/command", authenticated, (req, res) => {
    const key = z.string().uuid().parse(req.headers["idempotency-key"]);
    const input = z
      .object({
        action: z.enum([
          "tick",
          "toggle",
          "campaign",
          "budget",
          "settings",
          "analytics",
          "generate",
          "approve",
          "launch",
          "rollback",
          "schedule",
        ]),
        payload: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(req.body);
    const response = command(
      db,
      req.user.id,
      req.params.id,
      key,
      hash(JSON.stringify(input)),
      (b) => {
        const s = b.state,
          p = input.payload;
        // A live workspace may update its local profile, but every action that could
        // control advertising remains behind the live gate. Provider writes have no
        // route in this release.
        if (s.mode !== "demo" && input.action !== "settings")
          throw new AppError(
            409,
            "Управление реальной рекламой закрыто до приемки интеграции. Доступно подключение и чтение кабинета.",
            "live_gate",
          );
        let message = "Сохранено";
        let entries = [];
        switch (input.action) {
          case "schedule":
            s.shadowAnalysis = z.boolean().parse(p.enabled);
            entries = [
              {
                kind: "control",
                title: s.shadowAnalysis
                  ? "Фоновый анализ включен"
                  : "Фоновый анализ выключен",
                reason:
                  "Проверка сохраненных данных не чаще раза в час при изменениях. Никаких показов, списаний или изменений кампаний.",
                rule: "user",
              },
            ];
            if (!s.shadowAnalysis)
              db.prepare(
                "UPDATE jobs SET status='cancelled',error='Расписание выключено пользователем.' WHERE business_id=? AND kind='shadow_analysis' AND status='pending'",
              ).run(b.id);
            break;
          case "tick":
            entries = tickDemo(s);
            message = "Тестовый день рассчитан";
            if (!entries.length)
              entries = [
                {
                  kind: "sync",
                  title: "Статистика обновлена",
                  reason:
                    "Смоделирован один день показов. Новых решений пока нет.",
                  rule: "demo",
                },
              ];
            break;
          case "toggle":
            s.running = !s.running;
            if (
              s.running &&
              !s.campaigns.some(
                (c) => c.status === "active" && c.allocation > c.spent,
              )
            )
              throw new AppError(
                409,
                "Нет активных направлений с доступным бюджетом.",
              );
            entries = [
              {
                kind: "control",
                title: s.running ? "Реклама возобновлена" : "Реклама на паузе",
                reason: "По вашему запросу. Бюджет и история сохранены.",
                rule: "user",
              },
            ];
            break;
          case "campaign": {
            const c = s.campaigns.find((c) => c.id === p.id);
            if (!c) throw new AppError(404, "Направление не найдено.");
            const before = structuredClone(c);
            if (c.status === "paused" && c.spent >= c.allocation) {
              const free =
                s.budget -
                totals(s).reserve -
                s.campaigns.reduce((sum, item) => sum + item.allocation, 0);
              if (free <= 0)
                throw new AppError(
                  409,
                  "Нет свободного лимита. Измените бюджет или его распределение.",
                );
              c.allocation += free;
            }
            c.status = c.status === "paused" ? "active" : "paused";
            c.revision++;
            entries = [
              {
                kind: c.status === "paused" ? "pause" : "resume",
                title:
                  c.status === "paused"
                    ? "Направление остановлено"
                    : "Направление возобновлено",
                reason: c.name,
                targetId: c.id,
                before,
                after: structuredClone(c),
                rule: "user",
              },
            ];
            break;
          }
          case "budget": {
            const budget = money.parse(p.budget),
              target = p.targetCpa === undefined
                ? withStartingTargetCpa({ budget }).targetCpa
                : money.parse(p.targetCpa);
            const before = { budget: s.budget, targetCpa: s.targetCpa };
            s.budget = budget;
            s.targetCpa = target;
            rebalance(s);
            s.settingsRevision++;
            entries = [
              {
                kind: "budget",
                title: "Обновили бюджет и цель",
                reason: `Бюджет ${budget / 100} ₽. Системный ориентир эффективности пересчитан по лимиту и будет уточняться по подтвержденным обращениям.`,
                before,
                after: { budget, targetCpa: target },
                rule: "user",
              },
            ];
            break;
          }
          case "settings": {
            const parsed = withStartingTargetCpa(businessSchema.parse(p));
            if (
              parsed.periodStart !== s.periodStart ||
              parsed.periodEnd !== s.periodEnd
            )
              throw new AppError(
                409,
                "Даты действующего периода нельзя менять. Создайте новый бизнес для другого периода.",
              );
            const budgetChanged = parsed.budget !== s.budget;
            const before = {
              name: s.name,
              timezone: s.timezone,
              budget: s.budget,
              targetCpa: s.targetCpa,
            };
            Object.assign(s, parsed);
            if (budgetChanged) rebalance(s);
            s.settingsRevision++;
            entries = [
              {
                kind: "settings",
                title: "Профиль бизнеса обновлен",
                reason: budgetChanged
                  ? "Изменен общий бюджет; свободные лимиты перераспределены между активными направлениями."
                  : "Профиль сохранен. Лимиты направлений не изменены. Новые описания будут использованы при следующей подготовке объявлений.",
                before,
                after: {
                  name: s.name,
                  timezone: s.timezone,
                  budget: s.budget,
                  targetCpa: s.targetCpa,
                },
                rule: "user",
              },
            ];
            break;
          }
          case "analytics":
            s.counterId = "DEMO-804162";
            s.goalId = "appointment";
            entries = [
              {
                kind: "analytics",
                title: "Тестовая аналитика подключена",
                reason:
                  "Цель «Запись на услугу». Это тестовая конфигурация, установка кода на сайт не выполнялась.",
                rule: "demo",
              },
            ];
            break;
          case "generate":
            s.creatives = generateCreatives(s);
            entries = [
              {
                kind: "creative",
                title: "Подготовили три варианта текста",
                reason:
                  "Близость, забота и цена. Тексты собраны по шаблонам из анкеты; проверьте их перед запуском.",
                rule: "templates/1",
              },
            ];
            break;
          case "approve": {
            const c = s.creatives.find((c) => c.id === p.id);
            if (!c) throw new AppError(404, "Объявление не найдено.");
            c.status = "approved";
            entries = [
              {
                kind: "approved",
                title: "Объявление согласовано",
                reason: c.title,
                rule: "user",
              },
            ];
            break;
          }
          case "launch":
            launchDemo(s);
            entries = [
              {
                kind: "launch",
                title: "Тестовый план запущен",
                reason:
                  "Поиск и знакомство с бизнесом. 10% бюджета оставлены в резерве.",
                rule: "user",
              },
            ];
            break;
          case "rollback": {
            const history = events(db, b.id),
              entry = history.find((e) => e.id === p.id);
            if (!entry) throw new AppError(404, "Изменение не найдено.");
            entries = [rollback(s, entry, history)];
            message = "Изменение отменено";
            break;
          }
        }
        assertBudget(s);
        for (const e of entries) event(db, b.id, e);
        return { message };
      },
    );
    res.json(response);
  });
  app.get(
    "/api/businesses/:id/provider/:resource",
    authenticated,
    async (req, res) => {
      const b = requireBusiness(db, req.user.id, req.params.id);
      if (b.state.mode === "demo")
        throw new AppError(409, "Демо не обращается к реальным кабинетам.");
      const response = await withYandexConnection(
        {
          db,
          config,
          key,
          businessId: b.id,
          refreshToken,
        },
        async ({ credentials, metadata }) => {
          let currentMetadata = metadata;
          const refreshClients = async () => {
            const result = await directFactory({
              accessToken: credentials.access_token,
              sandbox: currentMetadata.sandbox,
            }).clients();
            currentMetadata = {
              ...currentMetadata,
              clients: result.Clients || [],
              validation: "verified",
              validationMessage: null,
              validatedAt: new Date().toISOString(),
            };
            db.prepare(
              "UPDATE connections SET metadata=? WHERE business_id=? AND provider='yandex'",
            ).run(JSON.stringify(currentMetadata), b.id);
            return result;
          };
          if (req.params.resource === "clients") return refreshClients();
          const directResource = ["campaigns", "report"].includes(
            req.params.resource,
          );
          if (directResource && !currentMetadata.clients?.length)
            await refreshClients();
          const login = String(
            req.query.login || currentMetadata.clients?.[0]?.Login || "",
          );
          if (
            directResource &&
            !currentMetadata.clients.some((c) => c.Login === login)
          )
            throw new AppError(403, "Кабинет не доступен этому подключению.");
          const client = directFactory({
            accessToken: credentials.access_token,
            login,
            sandbox: currentMetadata.sandbox,
          });
          if (req.params.resource === "campaigns") return client.campaigns();
          if (req.params.resource === "report")
            return client.report(b.state.periodStart, b.state.periodEnd);
          if (req.params.resource === "counters")
            return metricaFactory(credentials.access_token).counters();
          if (req.params.resource === "goals")
            return metricaFactory(credentials.access_token).goals(
              req.query.counterId,
            );
          if (req.params.resource === "metrica-stats") {
            if (!b.state.counterId || !b.state.goalId)
              throw new AppError(
                409,
                "Сначала выберите счетчик и цель Метрики.",
              );
            return metricaFactory(credentials.access_token).statistics(
              b.state.counterId,
              b.state.goalId,
              b.state.periodStart,
              b.state.periodEnd,
            );
          }
          throw new AppError(404, "Ресурс не найден.");
        },
      );
      res.json(response);
    },
  );
  app.get("/api/businesses/:id/export", authenticated, (req, res) => {
    const b = requireBusiness(db, req.user.id, req.params.id);
    const csvCell = (v) =>
      '"' +
      String(v)
        .replace(/^(?:\s*[=+@-]|[\t\r\n])/, "'$&")
        .replaceAll('"', '""') +
      '"';
    const rows = [
      [
        "Направление",
        "Канал",
        "Расход RUB",
        "Обращения",
        "Клиенты",
        "Лимит RUB",
      ],
      ...b.state.campaigns.map((c) => [
        c.name,
        c.channel,
        c.spent / 100,
        c.leads,
        b.state.clientsTracked ? c.clients : "",
        c.allocation / 100,
      ]),
    ];
    res
      .set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="ritm-report.csv"',
      })
      .send("\uFEFF" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n"));
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "API не найден", code: "not_found" }),
  );
  const dist = resolve("dist");
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get("/{*path}", (req, res) =>
      res.sendFile(resolve(dist, "index.html")),
    );
  }
  app.use((error, req, res, next) => {
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: "Проверьте заполненные поля.",
        code: "validation",
        fields: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    if (error.type === "entity.parse.failed")
      return res
        .status(400)
        .json({ error: "Некорректный JSON.", code: "validation" });
    if (!(error instanceof AppError))
      console.error(
        JSON.stringify({ event: "server_error", type: error.name }),
      );
    res.status(error.status || 500).json({
      error:
        error instanceof AppError
          ? error.message
          : "Не удалось выполнить действие. Попробуйте снова.",
      code: error.code || "internal_error",
    });
  });
  return app;
}
