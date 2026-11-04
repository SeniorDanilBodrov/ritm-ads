import express from "express";
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  attachAdvertisingPlan,
  businessSchema,
  withStartingTargetCpa,
} from "./app.js";
import { AppError } from "./db.js";
import {
  seedDemo,
  freshBusiness,
  totals,
  assertBudget,
  tickDemo,
  rebalance,
  generateCreatives,
} from "./engine.js";
import { onboardingAssistant } from "./onboarding-chat.js";
import { advertisingPlanInputHash, createAdvertisingPlan } from "./ai-plan.js";
import {
  token,
  hash,
  cookie,
  encrypt,
  sessionCookie,
  sameOrigin,
  isLoopbackOrigin,
  secureEquals,
} from "./security.js";
import {
  DirectClient,
  describeDirectValidationFailure,
  revokeYandexToken,
} from "./providers.js";
import { MetricaClient } from "./providers.js";
import { decrypt } from "./security.js";
import { buildMetricaSetup } from "./metrica-setup.js";
import {
  acceptanceProtocol,
  acceptanceRunsPostgres,
  enqueueAcceptanceRunPostgres,
} from "./acceptance-jobs.js";
import { enqueuePostgresReport } from "./postgres-reports.js";
import {
  claimRemotePlan,
  completeRemotePlan,
  failRemotePlan,
  remoteAiEnabled,
  remotePlanJob,
} from "./remote-ai.js";
import {
  approvePostgresCreativeImage,
  enqueuePostgresCreativeImage,
  postgresCreativeImageFile,
  postgresCreativeImages,
  removePostgresCreativeImage,
} from "./postgres-creatives.js";
import {
  inspectPostgresDirectImageUpload,
  uploadApprovedPostgresCreativeToDirect,
} from "./postgres-direct-images.js";
import { canRunAutopilot, canWritePaidAdvertising } from "./live-ads.js";
import {
  confirmPostgresDirectPlan,
  executePostgresDirectPlan,
  inspectPostgresDirectExecution,
  postgresDirectChanges,
  preflightPostgresDirectPlan,
  preparePostgresDirectPlan,
} from "./postgres-direct.js";
import {
  inspectPostgresDirectControl,
  inspectPostgresModerationAction,
  inspectPostgresModerationReadiness,
  postgresControlReviews,
  postgresModerationActions,
  submitPostgresModeration,
} from "./postgres-direct-moderation.js";
import {
  inspectPostgresResumeAction,
  postgresResumeActions,
  resumePostgresVerifiedCampaign,
} from "./postgres-direct-resume.js";
import {
  applyPostgresDirectAbDecision,
  bindPostgresAudienceExperiment,
  createPostgresAudienceExperiment,
  createPostgresDirectAbPlan,
  createVerifiedPostgresAbVariant,
  enqueuePostgresAbReport,
  inspectPostgresAbVariantAction,
  inspectPostgresDirectAbDecision,
  postgresAudienceExperiments,
  postgresDirectAbActions,
  postgresDirectAbDecisionActions,
  postgresDirectAbPlans,
  postgresDirectAbPlanView,
} from "./postgres-ab.js";
import {
  applyPostgresOptimizerAction,
  createPostgresManualSuspendAction,
  postgresAutopilotView,
  rollbackPostgresOptimizerAction,
  runPostgresAutopilotTick,
} from "./postgres-autopilot.js";
import { exportReportXlsx } from "./report-xlsx.js";

const googleJwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

async function requireBusiness(db, userId, id) {
  const row = id
    ? await db
        .prepare("SELECT * FROM businesses WHERE id=? AND user_id=?")
        .get(id, userId)
    : await db
        .prepare(
          "SELECT * FROM businesses WHERE user_id=? ORDER BY ctid DESC LIMIT 1",
        )
        .get(userId);
  if (!row)
    throw new AppError(
      404,
      "Бизнес не найден. Создайте его в настройках.",
      "business_missing",
    );
  return { ...row, state: JSON.parse(row.state) };
}

async function event(db, businessId, payload) {
  const value = { id: randomUUID(), at: new Date().toISOString(), ...payload };
  await db
    .prepare("INSERT INTO events VALUES(?,?,?,?)")
    .run(value.id, businessId, value.at, JSON.stringify(value));
  return value;
}

async function events(db, businessId) {
  const rows = await db
    .prepare(
      "SELECT payload FROM events WHERE business_id=? ORDER BY ctid DESC LIMIT 150",
    )
    .all(businessId);
  return rows.map((row) => JSON.parse(row.payload));
}

async function reportView(db, businessId) {
  const rows = await db
    .prepare(
      `SELECT rs.*,j.payload AS job_payload
    FROM report_snapshots rs JOIN jobs j ON j.id=rs.job_id
    WHERE rs.business_id=? ORDER BY rs.ctid DESC LIMIT 10`,
    )
    .all(businessId);
  return rows.map((row) => {
    const payload = JSON.parse(row.job_payload);
    const totals = JSON.parse(row.totals_json);
    return {
      id: row.id,
      empty: payload.empty ?? totals.rowCount === 0,
      metrica: row.metrica_json ? JSON.parse(row.metrica_json) : null,
      reportType: payload.reportType || "campaign",
      requestedAdIds: payload.adIds || [],
      abPlanId: payload.abPlanId || null,
      source: row.source,
      login: row.login,
      dateFrom: row.date_from,
      dateTo: row.date_to,
      currency: row.currency,
      includeVat: !!row.include_vat,
      receivedAt: row.received_at,
      rawHash: row.raw_hash,
      previousId: row.previous_id,
      totals,
      comparison: JSON.parse(row.comparison_json),
      rows: JSON.parse(row.rows_json).slice(0, 100),
    };
  });
}

async function metricaForBusiness(db, key, business) {
  if (business.state.mode === "demo")
    throw new AppError(409, "Демо не обращается к реальным кабинетам.");
  const row = await db
    .prepare(
      "SELECT encrypted FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(business.id);
  if (!row)
    throw new AppError(409, "Сначала подключите Яндекс.", "yandex_missing");
  let credentials;
  try {
    credentials = decrypt(row.encrypted, key, `${business.id}:yandex`);
  } catch {
    throw new AppError(
      409,
      "Не удалось прочитать подключение Яндекса. Подключите кабинет заново.",
      "yandex_invalid",
    );
  }
  if (!credentials.access_token)
    throw new AppError(
      409,
      "В подключении Яндекса нет действующего токена.",
      "yandex_invalid",
    );
  return new MetricaClient(credentials.access_token);
}

async function directConnectionForBusiness(db, key, business) {
  if (business.state.mode === "demo")
    throw new AppError(409, "Демо не обращается к реальным кабинетам.");
  const row = await db
    .prepare(
      "SELECT encrypted,metadata FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(business.id);
  if (!row)
    throw new AppError(409, "Сначала подключите Яндекс.", "yandex_missing");
  let credentials;
  try {
    credentials = decrypt(row.encrypted, key, `${business.id}:yandex`);
  } catch {
    throw new AppError(
      409,
      "Не удалось прочитать подключение Яндекса. Подключите кабинет заново.",
      "yandex_invalid",
    );
  }
  if (!credentials.access_token)
    throw new AppError(
      409,
      "В подключении Яндекса нет действующего токена.",
      "yandex_invalid",
    );
  return { credentials, metadata: JSON.parse(row.metadata) };
}

async function command(db, userId, businessId, key, fingerprint, action) {
  return db.transaction(async (tx) => {
    const business = await requireBusiness(tx, userId, businessId);
    const previous = await tx
      .prepare("SELECT * FROM commands WHERE business_id=? AND key=?")
      .get(business.id, key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AppError(
          409,
          "Этот запрос уже использован для другой операции.",
          "idempotency_conflict",
        );
      return JSON.parse(previous.response);
    }
    const result = await action(business, tx);
    business.version++;
    await tx
      .prepare(
        "UPDATE businesses SET state=?,version=? WHERE id=? AND user_id=?",
      )
      .run(
        JSON.stringify(business.state),
        business.version,
        business.id,
        userId,
      );
    const response = { ok: true, version: business.version, ...result };
    await tx
      .prepare("INSERT INTO commands VALUES(?,?,?,?)")
      .run(business.id, key, fingerprint, JSON.stringify(response));
    return response;
  });
}

function idempotencyKey(req) {
  return z
    .string()
    .min(12)
    .max(200)
    .parse(req.get("Idempotency-Key") || randomUUID());
}

const defaultAdLifecycle = {
  status: "draft",
  changeId: null,
  reason:
    "Подключите кабинет и проверьте план. До отдельного подтверждения реклама не запускается.",
  updatedAt: null,
};

export function postgresAdLifecycleView(rows) {
  const adLifecycles = rows.map((row) => ({
    status: row.status,
    changeId: row.change_id,
    reason: row.reason,
    updatedAt: row.updated_at,
  }));
  return {
    adLifecycles,
    adLifecycle: adLifecycles[0] ?? defaultAdLifecycle,
  };
}

export function createPostgresApp({
  db,
  config,
  key,
  advertisingPlanner = createAdvertisingPlan,
  revokeToken = revokeYandexToken,
  directFactory = (options) => new DirectClient(options),
}) {
  const app = express();
  const attempts = new Map();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
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
  app.post("/api/internal/autopilot/tick", async (req, res) => {
    const authorization = String(req.get("authorization") || "");
    const supplied = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (
      !config.autopilotWorkerToken ||
      config.autopilotWorkerToken.length < 32 ||
      !secureEquals(supplied, config.autopilotWorkerToken)
    )
      throw new AppError(
        401,
        "Планировщик не авторизован.",
        "autopilot_worker_unauthorized",
      );
    res.json(await runPostgresAutopilotTick(db, { key, config }));
  });
  app.use("/api", (req, _res, next) => {
    sameOrigin(req, config.origin);
    next();
  });
  const auth = async (req) => {
    const value = cookie(req, "ritm_session");
    if (!value) return null;
    return db
      .prepare(
        "SELECT users.id,users.name,users.subject FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires_at>?",
      )
      .get(hash(value), Date.now());
  };
  const authenticated = async (req, _res, next) => {
    req.user = await auth(req);
    if (!req.user)
      throw new AppError(401, "Войдите в свой аккаунт.", "unauthorized");
    next();
  };
  const remoteWorker = (req) => {
    const authorization = String(req.get("authorization") || "");
    const supplied = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (
      !remoteAiEnabled(config) ||
      !secureEquals(supplied, config.remoteAiWorkerToken)
    )
      throw new AppError(
        401,
        "Воркер Риты не авторизован.",
        "remote_ai_unauthorized",
      );
  };
  app.get("/api/health", async (_req, res) => {
    await db.prepare("SELECT 1").get();
    const paidWrites = canWritePaidAdvertising(config);
    res.json({
      ok: true,
      mode: "postgres-pilot",
      liveLaunch:
        paidWrites &&
        config.directWritePilot === true &&
        config.directResumePilot === true,
      directImageUpload:
        paidWrites &&
        config.directWritePilot === true &&
        config.directImageUploadPilot === true,
      directModeration:
        paidWrites &&
        config.directWritePilot === true &&
        config.directModerationPilot === true,
      creativeImages: Boolean(config.encryptionConfigured),
      imageProvider: "kie",
      textApproval: true,
    });
  });
  app.get("/api/ready", async (_req, res) => {
    const version = await db
      .prepare("SELECT MAX(version) AS version FROM schema_version")
      .get();
    res.status(Number(version?.version) === 31 ? 200 : 503).json({
      ok: Number(version?.version) === 31,
      ready: Number(version?.version) === 31,
      database: {
        reachable: true,
        schemaVersion: Number(version?.version) || null,
      },
    });
  });
  app.get("/api/session", async (req, res) => {
    const user = await auth(req);
    const paidWrites = canWritePaidAdvertising(config);
    res.json({
      user: user
        ? {
            id: user.id,
            name: user.name,
            demo: user.subject.startsWith("demo:"),
          }
        : null,
      demoAvailable: config.demo,
      googleConfigured: Boolean(config.googleId && config.googleSecret),
      yandexConfigured: Boolean(config.yandexId && config.yandexSecret),
      liveLaunch:
        paidWrites &&
        config.directWritePilot === true &&
        config.directResumePilot === true,
      postgresPilot: true,
    });
  });
  app.post("/api/internal/ai-worker/claim", async (req, res) => {
    remoteWorker(req);
    const job = await claimRemotePlan(db);
    if (!job) return res.status(204).end();
    res.json({
      ...job,
      model: config.aiModel || "qwen3.5:4b",
    });
  });
  app.post("/api/internal/ai-worker/:id/complete", async (req, res) => {
    remoteWorker(req);
    const body = z
      .object({ attempt: z.number().int().positive(), result: z.unknown() })
      .strict()
      .parse(req.body);
    res.json(
      await completeRemotePlan(db, req.params.id, body.attempt, body.result),
    );
  });
  app.post("/api/internal/ai-worker/:id/fail", async (req, res) => {
    remoteWorker(req);
    const body = z
      .object({ attempt: z.number().int().positive() })
      .strict()
      .parse(req.body);
    res.json(await failRemotePlan(db, req.params.id, body.attempt));
  });
  app.post("/api/demo", async (req, res) => {
    if (!config.demo) throw new AppError(404, "Демо отключено.");
    const ip = req.ip;
    const now = Date.now();
    for (const [key, value] of attempts)
      if (value.until < now) attempts.delete(key);
    const limit = attempts.get(ip) || { count: 0, until: now + 60_000 };
    if (limit.count++ >= 60)
      throw new AppError(429, "Слишком много входов. Подождите минуту.");
    attempts.set(ip, limit);
    const existing = await auth(req);
    if (existing?.subject.startsWith("demo:")) return res.json({ ok: true });
    const id = randomUUID(),
      businessId = randomUUID(),
      session = token();
    await db.transaction(async (tx) => {
      await tx
        .prepare("INSERT INTO users VALUES(?,?,?,?)")
        .run(id, `demo:${id}`, "Анна", new Date().toISOString());
      await tx
        .prepare("INSERT INTO sessions VALUES(?,?,?)")
        .run(hash(session), id, Date.now() + 7 * 86400000);
      await tx
        .prepare("INSERT INTO businesses VALUES(?,?,?,1)")
        .run(businessId, id, JSON.stringify(seedDemo()));
      await event(tx, businessId, {
        kind: "connected",
        title: "Тестовый кабинет готов",
        reason:
          "Это вымышленные данные студии. Никакие реальные аккаунты не подключены.",
        rule: "demo",
      });
    });
    sessionCookie(
      res,
      session,
      config.production && !isLoopbackOrigin(config.origin),
    );
    res.status(201).json({ ok: true });
  });
  app.post("/api/logout", async (req, res) => {
    await db
      .prepare("DELETE FROM sessions WHERE hash=?")
      .run(hash(cookie(req, "ritm_session")));
    sessionCookie(
      res,
      "",
      config.production && !isLoopbackOrigin(config.origin),
      true,
    );
    res.json({ ok: true });
  });
  app.get("/auth/google/start", async (_req, res) => {
    if (!config.googleId || !config.googleSecret)
      throw new AppError(
        503,
        "Вход через Google ещё не настроен на сервере.",
        "not_configured",
      );
    const state = token(),
      verifier = token(),
      binding = token();
    await db.transaction(async (tx) => {
      await tx
        .prepare("INSERT INTO oauth_states VALUES(?,?,?,?,?,?,?)")
        .run(
          hash(state),
          "google",
          hash(binding),
          null,
          verifier,
          Date.now() + 600_000,
          null,
        );
    });
    res.cookie("ritm_oauth", binding, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.production,
      path: "/auth",
      maxAge: 600_000,
    });
    const params = new URLSearchParams({
      client_id: config.googleId,
      redirect_uri: `${config.origin}/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce: state,
      prompt: "select_account",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });
  app.get("/auth/google/callback", async (req, res) => {
    const state = String(req.query.state || ""),
      code = String(req.query.code || "");
    if (!state || !code)
      throw new AppError(400, "Авторизация отменена или не завершена.");
    const saved = await db.transaction(async (tx) => {
      const value = await tx
        .prepare(
          "SELECT * FROM oauth_states WHERE hash=? AND provider='google'",
        )
        .get(hash(state));
      if (
        !value ||
        value.expires_at < Date.now() ||
        value.session_hash !== hash(cookie(req, "ritm_oauth"))
      )
        throw new AppError(400, "Ссылка входа устарела. Начните вход заново.");
      await tx
        .prepare("DELETE FROM oauth_states WHERE hash=?")
        .run(hash(state));
      return value;
    });
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: config.googleId,
      client_secret: config.googleSecret,
      redirect_uri: `${config.origin}/auth/google/callback`,
      code_verifier: saved.verifier,
    });
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok)
      throw new AppError(
        401,
        "Google не подтвердил вход. Попробуйте ещё раз.",
        "oauth_failed",
      );
    const data = await response.json();
    let payload;
    try {
      ({ payload } = await jwtVerify(data.id_token, googleJwks, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: config.googleId,
      }));
    } catch (error) {
      if (error?.code === "ERR_JWT_EXPIRED" || error?.name === "JWTExpired")
        return res.redirect("/?authError=google-token-expired");
      throw new AppError(
        401,
        "Не удалось проверить аккаунт Google.",
        "oauth_failed",
      );
    }
    if (
      payload.nonce !== state ||
      !payload.sub ||
      payload.email_verified !== true
    )
      throw new AppError(
        401,
        "Не удалось проверить аккаунт Google.",
        "oauth_failed",
      );
    const session = token();
    await db.transaction(async (tx) => {
      let user = await tx
        .prepare("SELECT * FROM users WHERE subject=?")
        .get(`google:${payload.sub}`);
      if (!user) {
        user = {
          id: randomUUID(),
          name:
            typeof payload.name === "string"
              ? payload.name
              : "Владелец бизнеса",
        };
        await tx
          .prepare("INSERT INTO users VALUES(?,?,?,?)")
          .run(
            user.id,
            `google:${payload.sub}`,
            user.name,
            new Date().toISOString(),
          );
      }
      await tx
        .prepare("INSERT INTO sessions VALUES(?,?,?)")
        .run(hash(session), user.id, Date.now() + 7 * 86400000);
    });
    res.clearCookie("ritm_oauth", { path: "/auth" });
    sessionCookie(res, session, config.production);
    res.redirect("/?connected=google");
  });
  app.get("/auth/yandex/start", async (req, res) => {
    const user = await auth(req);
    if (!user)
      throw new AppError(401, "Сначала войдите через Google.", "unauthorized");
    if (!config.yandexId || !config.yandexSecret)
      throw new AppError(
        503,
        "Подключение Яндекса ещё не настроено на сервере.",
        "not_configured",
      );
    if (!config.encryptionConfigured)
      throw new AppError(
        503,
        "Сначала настройте постоянный ключ шифрования токенов.",
        "not_configured",
      );
    const business = await requireBusiness(db, user.id, req.query.businessId);
    if (business.state.mode === "demo")
      throw new AppError(
        409,
        "К демонстрационному бизнесу нельзя подключить реальный кабинет.",
      );
    const state = token(),
      verifier = token(),
      binding = token();
    await db.transaction(async (tx) => {
      await tx
        .prepare(
          "DELETE FROM oauth_states WHERE provider='yandex' AND user_id=? AND business_id=?",
        )
        .run(user.id, business.id);
      await tx
        .prepare("INSERT INTO oauth_states VALUES(?,?,?,?,?,?,?)")
        .run(
          hash(state),
          "yandex",
          hash(binding),
          user.id,
          verifier,
          Date.now() + 600_000,
          business.id,
        );
    });
    res.cookie("ritm_oauth", binding, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.production,
      path: "/",
      maxAge: 600_000,
    });
    const params = new URLSearchParams({
      client_id: config.yandexId,
      response_type: "code",
      redirect_uri: "https://oauth.yandex.ru/verification_code",
      force_confirm: "yes",
      state,
      device_id: verifier,
      device_name: "Ритм · рекламный кабинет",
    });
    res.redirect(`https://oauth.yandex.ru/authorize?${params}`);
  });
  app.post(
    "/api/businesses/:businessId/yandex/oauth/complete",
    async (req, res) => {
      const user = await auth(req);
      if (!user)
        throw new AppError(401, "Войдите в свой аккаунт.", "unauthorized");
      if (
        !config.yandexId ||
        !config.yandexSecret ||
        !config.encryptionConfigured
      )
        throw new AppError(
          503,
          "Подключение Яндекса ещё не настроено на сервере.",
          "not_configured",
        );
      const code =
        typeof req.body?.code === "string" ? req.body.code.trim() : "";
      if (!/^[A-Za-z0-9_-]{4,2048}$/.test(code))
        throw new AppError(
          400,
          "Вставьте код подтверждения, показанный Яндексом.",
        );
      const business = await requireBusiness(
        db,
        user.id,
        req.params.businessId,
      );
      if (business.state.mode === "demo")
        throw new AppError(
          409,
          "К демонстрационному бизнесу нельзя подключить реальный кабинет.",
        );
      const saved = await db
        .prepare(
          "SELECT * FROM oauth_states WHERE provider='yandex' AND user_id=? AND business_id=? AND session_hash=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1",
        )
        .get(user.id, business.id, hash(cookie(req, "ritm_oauth")), Date.now());
      if (!saved)
        throw new AppError(
          400,
          "Код подключения устарел. Сначала снова откройте Яндекс.",
        );
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: config.yandexId,
        client_secret: config.yandexSecret,
        redirect_uri: "https://oauth.yandex.ru/verification_code",
        device_id: saved.verifier,
        device_name: "Ритм · рекламный кабинет",
      });
      const response = await fetch("https://oauth.yandex.ru/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!response.ok)
        throw new AppError(
          401,
          "Яндекс не подтвердил код. Откройте подключение и получите новый.",
          "oauth_failed",
        );
      const credentials = await response.json();
      if (!credentials?.access_token)
        throw new AppError(
          401,
          "Яндекс не вернул токен доступа.",
          "oauth_failed",
        );
      const now = Date.now();
      const expiresIn = Number(credentials.expires_in);
      const normalized = {
        ...credentials,
        obtained_at: now,
        expires_at:
          Number.isFinite(expiresIn) && expiresIn > 0
            ? now + Math.floor(expiresIn * 1000)
            : null,
      };
      const encrypted = encrypt(normalized, key, `${business.id}:yandex`);
      const metadata = {
        connectionId: randomUUID(),
        connectedAt: new Date().toISOString(),
        clients: [],
        validation: "pending",
        validationMessage: "Токен сохранён. Проверяем доступ к Директу.",
        tokenExpiresAt: normalized.expires_at
          ? new Date(normalized.expires_at).toISOString()
          : null,
      };
      try {
        const clients = await new DirectClient({
          accessToken: normalized.access_token,
          sandbox: false,
        }).clients();
        metadata.clients = clients.Clients || [];
        metadata.validation = "verified";
        metadata.validationMessage = null;
        metadata.validatedAt = new Date().toISOString();
      } catch (error) {
        Object.assign(metadata, describeDirectValidationFailure(error));
        metadata.lastValidationAt = new Date().toISOString();
      }
      await db.transaction(async (tx) => {
        await tx
          .prepare(
            "INSERT INTO connections VALUES(?,?,?,?) ON CONFLICT(business_id,provider) DO UPDATE SET encrypted=excluded.encrypted,metadata=excluded.metadata",
          )
          .run(business.id, "yandex", encrypted, JSON.stringify(metadata));
        await tx
          .prepare("DELETE FROM oauth_states WHERE hash=?")
          .run(saved.hash);
        await event(tx, business.id, {
          kind: "connected",
          title: "Яндекс подключён",
          reason:
            metadata.validation === "verified"
              ? "Доступ к кабинету подтверждён. Реклама не менялась."
              : "Токен сохранён, но проверка кабинета ещё не завершена.",
          rule: "yandex-readonly",
        });
      });
      res.clearCookie("ritm_oauth", { path: "/" });
      res.json({
        ok: true,
        validation: metadata.validation,
        validationCode: metadata.validationCode || null,
        message: metadata.validationMessage || null,
        clients: metadata.clients.map((client) => ({
          Login: client.Login,
          ClientId: client.ClientId,
        })),
      });
    },
  );
  app.get(
    "/api/businesses/:id/provider/:resource",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      if (req.params.resource === "counters") {
        res.json(
          await metricaForBusiness(db, key, business).then((client) =>
            client.counters(),
          ),
        );
        return;
      }
      if (req.params.resource === "goals") {
        res.json(
          await metricaForBusiness(db, key, business).then((client) =>
            client.goals(String(req.query.counterId || "")),
          ),
        );
        return;
      }
      const connection = await directConnectionForBusiness(db, key, business);
      let metadata = connection.metadata;
      const refreshClients = async () => {
        try {
          const result = await new DirectClient({
            accessToken: connection.credentials.access_token,
            sandbox: false,
          }).clients();
          metadata = {
            ...metadata,
            clients: result.Clients || [],
            validation: "verified",
            validationCode: null,
            validationMessage: null,
            validatedAt: new Date().toISOString(),
            lastValidationAt: new Date().toISOString(),
          };
          await db
            .prepare(
              "UPDATE connections SET metadata=? WHERE business_id=? AND provider='yandex'",
            )
            .run(JSON.stringify(metadata), business.id);
          return result;
        } catch (error) {
          const failure = describeDirectValidationFailure(error);
          metadata = {
            ...metadata,
            ...failure,
            clients: [],
            lastValidationAt: new Date().toISOString(),
          };
          await db
            .prepare(
              "UPDATE connections SET metadata=? WHERE business_id=? AND provider='yandex'",
            )
            .run(JSON.stringify(metadata), business.id);
          throw new AppError(
            409,
            failure.validationMessage,
            failure.validationCode,
          );
        }
      };
      if (req.params.resource === "clients") {
        res.json(await refreshClients());
        return;
      }
      if (!["campaigns", "report"].includes(req.params.resource))
        throw new AppError(404, "Ресурс не найден.");
      if (!metadata.clients?.length) await refreshClients();
      const login = String(
        req.query.login || metadata.clients?.[0]?.Login || "",
      );
      if (!metadata.clients.some((client) => client.Login === login))
        throw new AppError(403, "Кабинет не доступен этому подключению.");
      const direct = new DirectClient({
        accessToken: connection.credentials.access_token,
        login,
        sandbox: false,
      });
      res.json(
        req.params.resource === "campaigns"
          ? await direct.campaigns()
          : await direct.report(
              business.state.periodStart,
              business.state.periodEnd,
            ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/metrica/bind",
    authenticated,
    async (req, res) => {
      const input = z
        .object({
          counterId: z.union([z.string(), z.number()]),
          goalId: z.union([z.string(), z.number()]),
        })
        .parse(req.body);
      const counterId = String(input.counterId),
        goalId = String(input.goalId);
      if (!/^\d+$/.test(counterId) || !/^\d+$/.test(goalId))
        throw new AppError(400, "Выберите счётчик и цель Метрики.");
      const original = await requireBusiness(db, req.user.id, req.params.id);
      const metrica = await metricaForBusiness(db, key, original);
      const [counters, goals] = await Promise.all([
        metrica.counters(),
        metrica.goals(counterId),
      ]);
      const counter = (counters.counters || []).find(
        (item) => String(item.id) === counterId,
      );
      const goal = (goals.goals || []).find(
        (item) => String(item.id) === goalId,
      );
      if (!counter || !goal)
        throw new AppError(404, "Счётчик или цель Метрики больше не доступны.");
      const response = await command(
        db,
        req.user.id,
        original.id,
        idempotencyKey(req),
        hash(JSON.stringify({ action: "metrica-bind", counterId, goalId })),
        async (business, tx) => {
          if (business.version !== original.version)
            throw new AppError(
              409,
              "Данные бизнеса изменились во время настройки Метрики. Повторите выбор.",
              "stale_business",
            );
          business.state.counterId = counterId;
          business.state.goalId = goalId;
          business.state.metrica = {
            counter: { id: counterId, name: counter.name || counterId },
            goal: { id: goalId, name: goal.name || goalId },
            selectedAt: new Date().toISOString(),
          };
          await event(tx, business.id, {
            kind: "analytics",
            title: "Обращение настроено",
            reason: `Будем считать цель «${goal.name || goalId}» в счётчике «${counter.name || counterId}».`,
            rule: "metrica",
          });
          return {
            message:
              "Обращение настроено. Теперь Ритм сможет сопоставлять его с расходами рекламы.",
          };
        },
      );
      res.json(response);
    },
  );
  app.get(
    "/api/businesses/:id/metrica/setup",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      if (!business.state.counterId || !business.state.goalId)
        throw new AppError(
          409,
          "Сначала выберите, какое действие на сайте считать обращением.",
        );
      const metrica = await metricaForBusiness(db, key, business);
      const [counters, goals] = await Promise.all([
        metrica.counters(),
        metrica.goals(business.state.counterId),
      ]);
      const counter = (counters.counters || []).find(
        (item) => String(item.id) === String(business.state.counterId),
      );
      const goal = (goals.goals || []).find(
        (item) => String(item.id) === String(business.state.goalId),
      );
      res.json(
        buildMetricaSetup({ counter, goal, website: business.state.website }),
      );
    },
  );
  app.get(
    "/api/businesses/:id/launch-readiness",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const blockers = [];
      if (
        !business.state.name ||
        !business.state.category ||
        !business.state.city
      )
        blockers.push({
          code: "business",
          title: "Расскажите о бизнесе",
          detail: "Нужны название, сфера и город, чтобы подготовить рекламу.",
        });
      if (
        !Number.isInteger(business.state.budget) ||
        business.state.budget <= 0
      )
        blockers.push({
          code: "budget",
          title: "Укажите бюджет",
          detail: "Ритм не подготовит запуск без лимита расходов.",
        });
      if (!business.state.website)
        blockers.push({
          code: "website",
          title: "Выберите страницу для клиентов",
          detail:
            "Можно указать свой сайт или создать бесплатную страницу в Яндекс Директе.",
        });
      if (
        business.state.landingMode !== "yandex_landing" &&
        (!business.state.counterId || !business.state.goalId)
      )
        blockers.push({
          code: "conversion",
          title: "Выберите обращение",
          detail:
            "Укажите форму, звонок или запись, которую считать результатом рекламы.",
        });
      const connection = await db
        .prepare(
          "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
        )
        .get(business.id);
      if (!connection)
        blockers.push({
          code: "yandex",
          title: "Подключите Яндекс",
          detail:
            "Ритм сможет проверить кабинет, но не начнёт показы без вашего отдельного подтверждения.",
        });
      else {
        const metadata = JSON.parse(connection.metadata);
        if (metadata.validation !== "verified")
          blockers.push({
            code: "yandex",
            title: "Проверьте кабинет Яндекса",
            detail:
              "Подключение сохранено, но доступ к кабинету ещё не подтверждён.",
          });
      }
      if (!business.state.aiPlan?.plan?.ads?.length)
        blockers.push({
          code: "plan",
          title: "Подготовьте объявления",
          detail: "Ритм создаст понятный план по данным вашего бизнеса.",
        });
      else if (
        business.state.aiPlan.inputHash !==
        advertisingPlanInputHash(business.state)
      )
        blockers.push({
          code: "plan_outdated",
          title: "Обновите рекламный план",
          detail: "Данные бизнеса изменились после подготовки этого варианта.",
        });
      const ready = blockers.length === 0;
      res.json({
        ready,
        status: ready ? "ready_for_review" : "needs_setup",
        title: ready
          ? "План готов к вашей проверке"
          : "До запуска осталось несколько шагов",
        detail: ready
          ? "Проверьте подготовленный план. Реклама не начнётся без отдельного подтверждения."
          : "Ритм собрал только обязательные шаги — без терминов рекламного кабинета.",
        blockers,
      });
    },
  );
  app.post(
    "/api/businesses/:id/launch-readiness/confirm",
    authenticated,
    async (req, res) => {
      z.object({ confirmed: z.literal(true) }).parse(req.body);
      const original = await requireBusiness(db, req.user.id, req.params.id);
      const missing = [
        !original.state.website,
        original.state.landingMode !== "yandex_landing" &&
          (!original.state.counterId || !original.state.goalId),
        !original.state.aiPlan?.plan?.ads?.length,
        original.state.aiPlan?.inputHash !==
          advertisingPlanInputHash(original.state),
        !Number.isInteger(original.state.budget) || original.state.budget <= 0,
      ].some(Boolean);
      const connection = await db
        .prepare(
          "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
        )
        .get(original.id);
      if (
        missing ||
        !connection ||
        JSON.parse(connection.metadata).validation !== "verified"
      )
        throw new AppError(
          409,
          "Сначала завершите обязательные шаги подготовки. Реклама не будет отправлена.",
          "launch_not_ready",
        );
      const response = await command(
        db,
        req.user.id,
        original.id,
        idempotencyKey(req),
        hash(
          JSON.stringify({ action: "confirm-plan", version: original.version }),
        ),
        async (business, tx) => {
          if (business.version !== original.version)
            throw new AppError(
              409,
              "План изменился. Проверьте его ещё раз.",
              "plan_outdated",
            );
          business.state.postgresPilot = {
            ...(business.state.postgresPilot || {}),
            planConfirmedAt: new Date().toISOString(),
          };
          await event(tx, business.id, {
            kind: "approval",
            title: "План подтверждён",
            reason: "План сохранён как проверенный. Показы не запускались.",
            rule: "postgres-launch/confirm",
          });
          return {
            message:
              "План сохранён как проверенный. Показы не начались: запуск на этом сервере пока отключён.",
          };
        },
      );
      res.json(response);
    },
  );
  app.post("/api/businesses/:id/reports", authenticated, async (req, res) => {
    const response = await enqueuePostgresReport(
      db,
      req.user.id,
      req.params.id,
      idempotencyKey(req),
      {
        login: typeof req.body?.login === "string" ? req.body.login.trim() : "",
      },
    );
    res.status(202).json(response);
  });
  app.get(
    "/api/businesses/:id/reports/:reportId/raw",
    authenticated,
    async (req, res) => {
      await requireBusiness(db, req.user.id, req.params.id);
      const report = await db
        .prepare(
          "SELECT raw_tsv FROM report_snapshots WHERE id=? AND business_id=?",
        )
        .get(req.params.reportId, req.params.id);
      if (!report) throw new AppError(404, "Снимок отчёта не найден.");
      res
        .set({
          "Content-Type": "text/tab-separated-values; charset=utf-8",
          "Content-Disposition": 'attachment; filename="ritm-report.tsv"',
        })
        .send(report.raw_tsv);
    },
  );
  app.get(
    "/api/businesses/:id/reports/:reportId/xlsx",
    authenticated,
    async (req, res) => {
      await requireBusiness(db, req.user.id, req.params.id);
      const report = await db
        .prepare(
          "SELECT source,login,date_from,date_to,received_at,rows_json,totals_json FROM report_snapshots WHERE id=? AND business_id=?",
        )
        .get(req.params.reportId, req.params.id);
      if (!report) throw new AppError(404, "Снимок отчёта не найден.");
      res
        .set({
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": 'attachment; filename="ritm-report.xlsx"',
        })
        .send(Buffer.from(await exportReportXlsx(report)));
    },
  );
  app.get("/api/businesses", authenticated, async (req, res) => {
    const rows = await db
      .prepare(
        "SELECT id,state FROM businesses WHERE user_id=? ORDER BY ctid DESC",
      )
      .all(req.user.id);
    res.json(
      rows.map((row) => ({ id: row.id, name: JSON.parse(row.state).name })),
    );
  });
  app.get("/api/workspace", authenticated, async (req, res) => {
    const business = await requireBusiness(
      db,
      req.user.id,
      req.query.businessId,
    );
    const connectionRows = await db
      .prepare("SELECT provider,metadata FROM connections WHERE business_id=?")
      .all(business.id);
    const connections = connectionRows.map((row) => ({
      provider: row.provider,
      ...JSON.parse(row.metadata),
    }));
    const kieImages = connections.some(
      (connection) => connection.provider === "kie-image",
    );
    const directChanges = await postgresDirectChanges(
      db,
      req.user.id,
      business.id,
    );
    const controlReviews = await postgresControlReviews(
      db,
      req.user.id,
      business.id,
    );
    const lifecycleRows = await db
      .prepare(
        "SELECT status,change_id,reason,updated_at FROM campaign_ad_lifecycle WHERE business_id=? ORDER BY updated_at DESC,change_id DESC",
      )
      .all(business.id);
    const lifecycleView = postgresAdLifecycleView(lifecycleRows);
    const directWriteEnabled =
      canWritePaidAdvertising(config) && config.directWritePilot === true;
    const directModerationEnabled =
      directWriteEnabled && config.directModerationPilot === true;
    const directResumeEnabled =
      directWriteEnabled && config.directResumePilot === true;
    const directAbVariantEnabled =
      directWriteEnabled && config.directAbVariantPilot === true;
    const directAbDecisionEnabled =
      directWriteEnabled && config.directAbDecisionPilot === true;
    const autopilot = await postgresAutopilotView(db, req.user.id, business.id);
    res.json({
      id: business.id,
      version: business.version,
      state: business.state,
      totals: totals(business.state),
      events: await events(db, business.id),
      reports: await reportView(db, business.id),
      reportJobs: [],
      jobs: [],
      directChanges,
      acceptanceRuns: await acceptanceRunsPostgres(db, business.id),
      abPlans: await postgresDirectAbPlans(db, req.user.id, business.id),
      controlReviews,
      shadowReviews: autopilot.shadowReviews,
      shadowReviewJobs: [],
      adLifecycles: lifecycleView.adLifecycles,
      optimizerActions: autopilot.optimizerActions,
      audienceExperiments: await postgresAudienceExperiments(
        db,
        req.user.id,
        business.id,
      ),
      creativeImages: await postgresCreativeImages(db, business.id),
      connections,
      adLifecycle: lifecycleView.adLifecycle,
      capabilities: {
        postgresPilot: true,
        google: Boolean(config.googleId && config.googleSecret),
        yandex: Boolean(config.yandexId && config.yandexSecret),
        liveLaunch: directResumeEnabled,
        directWritePilot: directWriteEnabled,
        directArchivePilot: false,
        directModerationPilot: directModerationEnabled,
        directResumePilot: directResumeEnabled,
        directImageUploadPilot:
          directWriteEnabled && config.directImageUploadPilot === true,
        directBudgetPilot: false,
        directAbVariantPilot: directAbVariantEnabled,
        directAbDecisionPilot: directAbDecisionEnabled,
        abPlanning: true,
        analyst: remoteAiEnabled(config),
        creativeImages: true,
        creativeImageSetup: Boolean(config.encryptionConfigured),
        creativeImageProvider: kieImages ? "kie" : null,
      },
    });
  });
  app.post(
    "/api/businesses/:id/direct/:changeId/audience-experiment",
    authenticated,
    async (req, res) => {
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      res
        .status(201)
        .json(
          await createPostgresAudienceExperiment(
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
    "/api/businesses/:id/direct/audience-experiments/:experimentId/bind",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const connection = await directConnectionForBusiness(db, key, business);
      const experiment = (
        await postgresAudienceExperiments(db, req.user.id, business.id)
      ).find((item) => item.id === req.params.experimentId);
      if (!experiment) throw new AppError(404, "Тест аудитории не найден.");
      const change = (
        await postgresDirectChanges(db, req.user.id, business.id)
      ).find((item) => item.id === experiment.changeId);
      if (!change) throw new AppError(404, "Подготовленный план не найден.");
      const input = z
        .object({
          controlCampaignId: z.string().regex(/^[1-9]\d*$/),
          variantCampaignId: z.string().regex(/^[1-9]\d*$/),
          controlAdId: z.string().regex(/^[1-9]\d*$/),
          variantAdId: z.string().regex(/^[1-9]\d*$/),
          budgetPerVariantKopecks: z.number().int().positive(),
        })
        .strict()
        .parse(req.body);
      res.json(
        await bindPostgresAudienceExperiment(
          db,
          req.user.id,
          business.id,
          req.params.experimentId,
          input,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          }),
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/ab-plan",
    authenticated,
    async (req, res) => {
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      res
        .status(201)
        .json(
          await createPostgresDirectAbPlan(
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
    async (req, res) => {
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      res
        .status(202)
        .json(
          await enqueuePostgresAbReport(
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
    async (req, res) => {
      res.json(
        await postgresDirectAbDecisionActions(
          db,
          req.user.id,
          req.params.id,
          req.params.planId,
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/ab-plans/:planId/decision",
    authenticated,
    async (req, res) => {
      if (
        !canWritePaidAdvertising(config) ||
        config.directWritePilot !== true ||
        config.directAbDecisionPilot !== true
      )
        throw new AppError(
          409,
          "Применение A/B-решений отключено на этом сервере.",
          "live_gate",
        );
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const input = z
        .object({
          operation: z.enum(["rollback_variant", "apply_outcome"]),
          confirmCampaignId: z.number().int().positive(),
          confirmTargetAdId: z.string().regex(/^[1-9]\d*$/),
          confirmed: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const plan = await postgresDirectAbPlanView(
        db,
        req.user.id,
        business.id,
        req.params.planId,
      );
      const change = (
        await postgresDirectChanges(db, req.user.id, business.id)
      ).find((item) => item.id === plan.changeId);
      if (!change) throw new AppError(404, "Подготовленный план не найден.");
      const connection = await directConnectionForBusiness(db, key, business);
      res.json(
        await applyPostgresDirectAbDecision(
          db,
          req.user.id,
          business.id,
          plan.id,
          requestKey,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          }),
          connection.metadata.connectionId,
          { enabled: true, ...input },
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/ab-plans/:planId/decisions/:actionId/inspect",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const plan = await postgresDirectAbPlanView(
        db,
        req.user.id,
        business.id,
        req.params.planId,
      );
      const change = (
        await postgresDirectChanges(db, req.user.id, business.id)
      ).find((item) => item.id === plan.changeId);
      if (!change) throw new AppError(404, "Подготовленный план не найден.");
      const connection = await directConnectionForBusiness(db, key, business);
      res.json(
        await inspectPostgresDirectAbDecision(
          db,
          req.user.id,
          business.id,
          plan.id,
          req.params.actionId,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          }),
        ),
      );
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/ab-actions",
    authenticated,
    async (req, res) => {
      res.json(
        await postgresDirectAbActions(
          db,
          req.user.id,
          req.params.id,
          req.params.changeId,
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/ab-variant",
    authenticated,
    async (req, res) => {
      if (
        !canWritePaidAdvertising(config) ||
        config.directWritePilot !== true ||
        config.directAbVariantPilot !== true
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
      const input = z
        .object({
          confirmCampaignId: z.number().int().positive(),
          confirmControlAdId: z.string().regex(/^[1-9]\d*$/),
          variantConfirmed: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const change = (
        await postgresDirectChanges(db, req.user.id, business.id)
      ).find((item) => item.id === req.params.changeId);
      if (!change) throw new AppError(404, "Подготовленный план не найден.");
      const connection = await directConnectionForBusiness(db, key, business);
      res.json(
        await createVerifiedPostgresAbVariant(
          db,
          req.user.id,
          business.id,
          change.id,
          requestKey,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          }),
          connection.metadata.connectionId,
          { enabled: true, ...input },
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/ab-variant/:actionId/inspect",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const change = (
        await postgresDirectChanges(db, req.user.id, business.id)
      ).find((item) => item.id === req.params.changeId);
      if (!change) throw new AppError(404, "Подготовленный план не найден.");
      const connection = await directConnectionForBusiness(db, key, business);
      res.json(
        await inspectPostgresAbVariantAction(
          db,
          req.user.id,
          business.id,
          change.id,
          req.params.actionId,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          }),
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/dry-run",
    authenticated,
    async (req, res) => {
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      let directContext = null;
      if (req.body?.creativeAssetId) {
        const business = await requireBusiness(db, req.user.id, req.params.id);
        const connection = await directConnectionForBusiness(db, key, business);
        if (
          !connection.metadata.clients?.some(
            (client) => client.Login === req.body.login,
          )
        )
          throw new AppError(403, "Кабинет не доступен этому подключению.");
        directContext = { connectionId: connection.metadata.connectionId };
      }
      res
        .status(201)
        .json(
          await preparePostgresDirectPlan(
            db,
            req.user.id,
            req.params.id,
            requestKey,
            req.body,
            directContext,
          ),
        );
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
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const connection = await directConnectionForBusiness(db, key, business);
      const changes = await postgresDirectChanges(db, req.user.id, business.id);
      const change = changes.find((item) => item.id === req.params.changeId);
      if (!change) throw new AppError(404, "Подготовленный план не найден.");
      const accounts = await directFactory({
        accessToken: connection.credentials.access_token,
        sandbox: false,
      }).clients();
      const clients = accounts.Clients || [];
      if (!clients.some((item) => item.Login === change.plan.login))
        throw new AppError(
          409,
          "Выбранный кабинет больше не доступен. Проверьте подключение.",
          "direct_account_missing",
        );
      res.json(
        await preflightPostgresDirectPlan(
          db,
          req.user.id,
          business.id,
          change.id,
          requestKey,
          {
            clients,
            connectionId: connection.metadata.connectionId,
            clientForLogin: directFactory({
              accessToken: connection.credentials.access_token,
              login: change.plan.login,
              sandbox: false,
            }),
          },
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/confirm",
    authenticated,
    async (req, res) => {
      const input = z
        .object({ planFingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(req.body);
      res.json(
        await confirmPostgresDirectPlan(
          db,
          req.user.id,
          req.params.id,
          req.params.changeId,
          input.planFingerprint,
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/execute",
    authenticated,
    async (req, res) => {
      if (!canWritePaidAdvertising(config) || config.directWritePilot !== true)
        throw new AppError(
          409,
          "Создание кампаний ещё не разрешено на этом сервере.",
          "live_gate",
        );
      const input = z
        .object({ planFingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(req.body);
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const connection = await directConnectionForBusiness(db, key, business);
      const changes = await postgresDirectChanges(db, req.user.id, business.id);
      const change = changes.find((item) => item.id === req.params.changeId);
      if (!change) throw new AppError(404, "Подготовленный план не найден.");
      res.json(
        await executePostgresDirectPlan(
          db,
          req.user.id,
          business.id,
          change.id,
          input.planFingerprint,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          }),
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/execution/inspect",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const connection = await directConnectionForBusiness(db, key, business);
      const changes = await postgresDirectChanges(db, req.user.id, business.id);
      const change = changes.find((item) => item.id === req.params.changeId);
      if (!change) throw new AppError(404, "Подготовленный план не найден.");
      res.json(
        await inspectPostgresDirectExecution(
          db,
          req.user.id,
          business.id,
          change.id,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          }),
        ),
      );
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/moderation-readiness",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const connection = await directConnectionForBusiness(db, key, business);
      const changes = await postgresDirectChanges(db, req.user.id, business.id);
      const change = changes.find((item) => item.id === req.params.changeId);
      if (!change) throw new AppError(404, "Созданная кампания не найдена.");
      res.json(
        await inspectPostgresModerationReadiness(
          db,
          req.user.id,
          business.id,
          change.id,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          }),
          connection.metadata.connectionId,
        ),
      );
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/moderation-actions",
    authenticated,
    async (req, res) => {
      res.json(
        await postgresModerationActions(
          db,
          req.user.id,
          req.params.id,
          req.params.changeId,
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/moderate",
    authenticated,
    async (req, res) => {
      if (
        !canWritePaidAdvertising(config) ||
        config.directWritePilot !== true ||
        config.directModerationPilot !== true
      )
        throw new AppError(
          409,
          "Отправка на модерацию ещё не разрешена на этом сервере.",
          "live_gate",
        );
      const input = z
        .object({
          advertiserConfirmed: z.literal(true),
          siteConfirmed: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const connection = await directConnectionForBusiness(db, key, business);
      const changes = await postgresDirectChanges(db, req.user.id, business.id);
      const change = changes.find((item) => item.id === req.params.changeId);
      if (!change) throw new AppError(404, "Созданная кампания не найдена.");
      res.json(
        await submitPostgresModeration(
          db,
          req.user.id,
          business.id,
          change.id,
          requestKey,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          }),
          connection.metadata.connectionId,
          { enabled: true, ...input },
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/moderation/:actionId/inspect",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const connection = await directConnectionForBusiness(db, key, business);
      const changes = await postgresDirectChanges(db, req.user.id, business.id);
      const change = changes.find((item) => item.id === req.params.changeId);
      if (!change) throw new AppError(404, "Созданная кампания не найдена.");
      res.json(
        await inspectPostgresModerationAction(
          db,
          req.user.id,
          business.id,
          change.id,
          req.params.actionId,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          }),
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
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const connection = await directConnectionForBusiness(db, key, business);
      const changes = await postgresDirectChanges(db, req.user.id, business.id);
      const change = changes.find((item) => item.id === req.params.changeId);
      if (!change) throw new AppError(404, "Созданная кампания не найдена.");
      res.json(
        await inspectPostgresDirectControl(
          db,
          req.user.id,
          business.id,
          change.id,
          requestKey,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          }),
          connection.metadata.connectionId,
        ),
      );
    },
  );
  app.get(
    "/api/businesses/:id/direct/:changeId/resume-actions",
    authenticated,
    async (req, res) => {
      res.json(
        await postgresResumeActions(
          db,
          req.user.id,
          req.params.id,
          req.params.changeId,
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/resume",
    authenticated,
    async (req, res) => {
      if (
        !canWritePaidAdvertising(config) ||
        config.directWritePilot !== true ||
        config.directResumePilot !== true
      )
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
          launchConfirmed: z.literal(true),
          confirmCampaignId: z.number().int().positive(),
          confirmLimitKopecks: z.number().int().positive(),
        })
        .strict()
        .parse(req.body);
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const connection = await directConnectionForBusiness(db, key, business);
      const changes = await postgresDirectChanges(db, req.user.id, business.id);
      const change = changes.find((item) => item.id === req.params.changeId);
      if (!change) throw new AppError(404, "Созданная кампания не найдена.");
      res.json(
        await resumePostgresVerifiedCampaign(
          db,
          req.user.id,
          business.id,
          change.id,
          requestKey,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          }),
          connection.metadata.connectionId,
          { enabled: true, ...confirmations },
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/resume/:actionId/inspect",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const connection = await directConnectionForBusiness(db, key, business);
      const changes = await postgresDirectChanges(db, req.user.id, business.id);
      const change = changes.find((item) => item.id === req.params.changeId);
      if (!change) throw new AppError(404, "Созданная кампания не найдена.");
      res.json(
        await inspectPostgresResumeAction(
          db,
          req.user.id,
          business.id,
          change.id,
          req.params.actionId,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: change.plan.login,
            sandbox: false,
          }),
        ),
      );
    },
  );
  app.get(
    "/api/businesses/:id/optimizer-actions",
    authenticated,
    async (req, res) => {
      res.json(await postgresAutopilotView(db, req.user.id, req.params.id));
    },
  );
  app.post(
    "/api/businesses/:id/direct/:changeId/suspend",
    authenticated,
    async (req, res) => {
      if (!canRunAutopilot(config))
        throw new AppError(
          409,
          "Защитные действия отключены на этом сервере.",
          "autopilot_gate",
        );
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const input = z
        .object({ suspendConfirmed: z.literal(true) })
        .strict()
        .parse(req.body);
      const action = await createPostgresManualSuspendAction(
        db,
        req.user.id,
        req.params.id,
        req.params.changeId,
        requestKey,
        { confirmed: input.suspendConfirmed },
      );
      res.json(
        await applyPostgresOptimizerAction(
          db,
          req.user.id,
          req.params.id,
          action.id,
          { key, config, directFactory },
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/budget-reallocation/:actionId/apply",
    authenticated,
    async (req, res) => {
      z.object({ reallocationConfirmed: z.literal(true) })
        .strict()
        .parse(req.body);
      res.json(
        await applyPostgresOptimizerAction(
          db,
          req.user.id,
          req.params.id,
          req.params.actionId,
          { key, config, directFactory },
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/optimizer-actions/:actionId/rollback",
    authenticated,
    async (req, res) => {
      const requestKey = z
        .string()
        .uuid()
        .parse(req.headers["idempotency-key"]);
      const input = z
        .object({
          spendConfirmed: z.literal(true),
          launchConfirmed: z.literal(true),
        })
        .strict()
        .parse(req.body);
      res.json(
        await rollbackPostgresOptimizerAction(
          db,
          req.user.id,
          req.params.id,
          req.params.actionId,
          requestKey,
          { key, config, directFactory, ...input },
        ),
      );
    },
  );
  app.put(
    "/api/businesses/:id/image-provider/kie",
    authenticated,
    async (req, res) => {
      if (!config.encryptionConfigured)
        throw new AppError(
          409,
          "Для ключа Kie.ai нужен постоянный ключ шифрования сервера.",
          "encryption_not_configured",
        );
      const apiKey = z
        .object({ apiKey: z.string().trim().min(16).max(512) })
        .strict()
        .parse(req.body).apiKey;
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const connectedAt = new Date().toISOString();
      await db.transaction(async (tx) => {
        await tx
          .prepare(
            "DELETE FROM connections WHERE business_id=? AND provider='openai-image'",
          )
          .run(business.id);
        await tx
          .prepare(
            `INSERT INTO connections(business_id,provider,encrypted,metadata)
             VALUES(?,?,?,?)
             ON CONFLICT(business_id,provider) DO UPDATE SET encrypted=excluded.encrypted,metadata=excluded.metadata`,
          )
          .run(
            business.id,
            "kie-image",
            encrypt({ apiKey }, key, `${business.id}:kie-image`),
            JSON.stringify({
              connectedAt,
              sandbox: false,
              clients: [],
              model: config.kieImageModel,
              purpose: "image_generation",
            }),
          );
        await event(tx, business.id, {
          kind: "creative_provider_connected",
          title: "Подключена генерация изображений",
          reason:
            "Ключ сохранён на сервере. Каждый новый вариант создаётся только после вашего действия.",
          rule: "creative/kie-gpt-image-2.5@1",
        });
      });
      res.json({ connected: true, model: config.kieImageModel });
    },
  );
  app.delete(
    "/api/businesses/:id/image-provider/kie",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      await db.transaction(async (tx) => {
        const result = await tx
          .prepare(
            "DELETE FROM connections WHERE business_id=? AND provider='kie-image'",
          )
          .run(business.id);
        if (!result.changes)
          throw new AppError(404, "Генерация Kie.ai не подключена.");
        await event(tx, business.id, {
          kind: "creative_provider_disconnected",
          title: "Генерация изображений отключена",
          reason:
            "Новые изображения больше не создаются. Уже сохранённые варианты останутся на проверке.",
          rule: "creative/kie-gpt-image-2.5@1",
        });
      });
      res.json({ connected: false });
    },
  );
  app.post(
    "/api/businesses/:id/creative-images",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const kie = await db
        .prepare(
          "SELECT 1 FROM connections WHERE business_id=? AND provider='kie-image'",
        )
        .get(business.id);
      if (!kie)
        throw new AppError(
          409,
          "Сначала подключите генерацию изображений.",
          "creative_images_disabled",
        );
      res.status(202).json(
        await enqueuePostgresCreativeImage(
          db,
          req.user.id,
          business.id,
          idempotencyKey(req),
          req.body,
          {
            model: config.kieImageModel,
          },
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/creative-images/:assetId/approve",
    authenticated,
    async (req, res) => {
      res.json(
        await approvePostgresCreativeImage(
          db,
          req.user.id,
          req.params.id,
          req.params.assetId,
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/creative-images/:assetId/direct-upload",
    authenticated,
    async (req, res) => {
      const input = z
        .object({
          login: z.string().trim().min(1).max(160),
          uploadConfirmed: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const connection = await directConnectionForBusiness(db, key, business);
      if (
        !connection.metadata.clients?.some(
          (client) => client.Login === input.login,
        )
      )
        throw new AppError(403, "Кабинет не доступен этому подключению.");
      res.json(
        await uploadApprovedPostgresCreativeToDirect(
          db,
          req.user.id,
          business.id,
          req.params.assetId,
          idempotencyKey(req),
          directFactory({
            accessToken: connection.credentials.access_token,
            login: input.login,
            sandbox: false,
          }),
          connection.metadata.connectionId,
          {
            enabled:
              canWritePaidAdvertising(config) &&
              config.directWritePilot === true &&
              config.directImageUploadPilot === true,
            ...input,
          },
        ),
      );
    },
  );
  app.post(
    "/api/businesses/:id/creative-images/:assetId/direct-upload/:jobId/inspect",
    authenticated,
    async (req, res) => {
      const input = z
        .object({ login: z.string().trim().min(1).max(160) })
        .strict()
        .parse(req.body);
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const connection = await directConnectionForBusiness(db, key, business);
      if (
        !connection.metadata.clients?.some(
          (client) => client.Login === input.login,
        )
      )
        throw new AppError(403, "Кабинет не доступен этому подключению.");
      res.json(
        await inspectPostgresDirectImageUpload(
          db,
          req.user.id,
          business.id,
          req.params.assetId,
          req.params.jobId,
          directFactory({
            accessToken: connection.credentials.access_token,
            login: input.login,
            sandbox: false,
          }),
        ),
      );
    },
  );
  app.get(
    "/api/businesses/:id/creative-images/:assetId/file",
    authenticated,
    async (req, res) => {
      const asset = await postgresCreativeImageFile(
        db,
        req.user.id,
        req.params.id,
        req.params.assetId,
      );
      res.type(asset.mimeType).send(asset.buffer);
    },
  );
  app.delete(
    "/api/businesses/:id/creative-images/:assetId",
    authenticated,
    async (req, res) => {
      res.json(
        await removePostgresCreativeImage(
          db,
          req.user.id,
          req.params.id,
          req.params.assetId,
        ),
      );
    },
  );
  app.post("/api/assistant/onboarding", authenticated, async (req, res) => {
    const message = z.string().trim().min(2).max(2000).parse(req.body.message);
    const profile = z
      .object({
        name: z.string().max(160).optional(),
        category: z.string().max(160).optional(),
        city: z.string().max(160).optional(),
        website: z.string().max(2048).optional(),
        service: z.string().max(160).optional(),
        benefit: z.string().max(160).optional(),
        price: z.number().int().min(0).max(10_000_000).optional(),
        budget: z.number().int().min(1_000).max(1_000_000).optional(),
      })
      .strict()
      .parse(req.body.profile || {});
    res.json(await onboardingAssistant({ message, profile, config }));
  });
  app.post("/api/businesses/with-plan", authenticated, async (req, res) => {
    const input = withStartingTargetCpa(businessSchema.parse(req.body));
    const id = randomUUID();
    const state = freshBusiness(input, req.user.subject.startsWith("demo:"));
    const generated = await advertisingPlanner(
      state,
      remoteAiEnabled(config) ? { ...config, aiProvider: "rules" } : config,
    );
    const plan = attachAdvertisingPlan(state, generated);
    const remoteJob = remoteAiEnabled(config) ? remotePlanJob(id, state) : null;
    await db.transaction(async (tx) => {
      await tx
        .prepare("INSERT INTO businesses VALUES(?,?,?,1)")
        .run(id, req.user.id, JSON.stringify(state));
      if (remoteJob)
        await tx
          .prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?)")
          .run(
            remoteJob.id,
            remoteJob.businessId,
            "remote_ai_plan",
            "pending",
            remoteJob.availableAt,
            0,
            remoteJob.payload,
            null,
          );
      await event(tx, id, {
        kind: "created",
        title: "Бизнес добавлен",
        reason: input.name,
        rule: "assistant",
      });
      await event(tx, id, {
        kind: "ai_plan",
        title: remoteJob
          ? "Рита начала уточнять план"
          : "Рекламный план подготовлен",
        reason: remoteJob
          ? "Базовый безопасный вариант уже доступен. Локальная модель уточнит его в фоне."
          : "План собран по данным бизнеса. Перед запуском он пройдёт проверку.",
        rule: remoteJob
          ? "remote-ollama/queued"
          : `${generated.provider}/${generated.model}`,
      });
    });
    res.status(201).json({ id, plan });
  });
  app.post("/api/businesses/:id/ai-plan", authenticated, async (req, res) => {
    const original = await requireBusiness(db, req.user.id, req.params.id);
    const generated = await advertisingPlanner(
      original.state,
      remoteAiEnabled(config) ? { ...config, aiProvider: "rules" } : config,
    );
    const response = await command(
      db,
      req.user.id,
      original.id,
      idempotencyKey(req),
      hash(
        JSON.stringify({ action: "ai-plan", inputHash: generated.inputHash }),
      ),
      async (business, tx) => {
        if (generated.inputHash !== advertisingPlanInputHash(business.state))
          throw new AppError(
            409,
            "Данные бизнеса изменились, пока Рита готовила план. Обновите план ещё раз.",
            "plan_outdated",
          );
        attachAdvertisingPlan(business.state, generated);
        business.state.postgresPilot = {
          ...(business.state.postgresPilot || {}),
          planConfirmedAt: null,
        };
        await event(tx, business.id, {
          kind: "ai_plan",
          title: "Рекламный план обновлён",
          reason:
            generated.provider === "ollama"
              ? "Рита уточнила аудитории, объявления и распределение бюджета."
              : "Рита обновила безопасный план по данным бизнеса.",
          rule: `${generated.provider}/${generated.model}`,
        });
        return { plan: business.state.aiPlan };
      },
    );
    res.status(201).json(response);
  });
  app.post(
    "/api/businesses/:id/connections/yandex/disconnect",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const row = await db
        .prepare(
          "SELECT * FROM connections WHERE business_id=? AND provider='yandex'",
        )
        .get(business.id);
      if (!row) throw new AppError(404, "Подключение Яндекса не найдено.");
      let revoked = false;
      let warning = null;
      try {
        const credentials = decrypt(
          row.encrypted,
          key,
          `${business.id}:yandex`,
        );
        const result = await revokeToken(
          credentials.access_token,
          config.yandexId,
          config.yandexSecret,
        );
        revoked = result?.status === "ok";
        if (!revoked)
          warning =
            "Подключение удалено, но Яндекс не подтвердил отзыв токена. Отзовите доступ в Яндекс ID.";
      } catch {
        warning =
          "Подключение удалено, но Яндекс не подтвердил отзыв токена. Отзовите доступ в Яндекс ID.";
      }
      await db.transaction(async (tx) => {
        await tx
          .prepare(
            "DELETE FROM connections WHERE business_id=? AND provider='yandex'",
          )
          .run(business.id);
        await tx
          .prepare(
            "UPDATE jobs SET status='cancelled',error='Подключение Яндекса отключено пользователем.' WHERE business_id=? AND kind='report_sync' AND status IN ('pending','running')",
          )
          .run(business.id);
        await event(tx, business.id, {
          kind: "disconnected",
          title: "Яндекс отключён",
          reason: revoked
            ? "Токен отозван и удалён из зашифрованного хранилища."
            : warning,
          rule: "user",
        });
      });
      res.json({ ok: true, revoked, warning });
    },
  );
  app.post("/api/businesses/:id/command", authenticated, async (req, res) => {
    const input = z
      .object({
        action: z.enum([
          "tick",
          "toggle",
          "schedule",
          "settings",
          "generate",
          "approve",
        ]),
        payload: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(req.body);
    const response = await command(
      db,
      req.user.id,
      req.params.id,
      idempotencyKey(req),
      hash(JSON.stringify(input)),
      async (business, tx) => {
        const state = business.state;
        let message = "Сохранено";
        let entries = [];
        if (input.action === "tick") {
          entries = tickDemo(state);
          message = "Тестовый день рассчитан";
        } else if (input.action === "toggle") {
          state.running = !state.running;
          entries = [
            {
              kind: "control",
              title: state.running
                ? "Реклама возобновлена"
                : "Реклама на паузе",
              reason: "По вашему запросу. Бюджет и история сохранены.",
              rule: "user",
            },
          ];
        } else if (input.action === "schedule") {
          state.shadowAnalysis = z.boolean().parse(input.payload.enabled);
          entries = [
            {
              kind: "control",
              title: state.shadowAnalysis
                ? "Наблюдение включено"
                : "Наблюдение на паузе",
              reason:
                "Наблюдение ничего не меняет в рекламе — только готовит рекомендации.",
              rule: "user",
            },
          ];
        } else if (input.action === "generate") {
          state.creatives = generateCreatives(state);
          message = "Тексты подготовлены";
          entries = [
            {
              kind: "creative",
              title: "Подготовлены варианты текста",
              reason:
                "Рита собрала три объявления по данным бизнеса. Перед запуском каждый текст нужно согласовать.",
              rule: "templates/1",
            },
          ];
        } else if (input.action === "approve") {
          const creativeId = z.string().min(1).max(160).parse(input.payload.id);
          const creative = (state.creatives || []).find(
            (item) => item.id === creativeId,
          );
          if (!creative) throw new AppError(404, "Текст объявления не найден.");
          if (creative.status === "approved") {
            message = "Текст уже согласован";
          } else {
            creative.status = "approved";
            message = "Текст согласован";
            entries = [
              {
                kind: "approved",
                title: "Текст объявления согласован",
                reason: creative.title,
                rule: "user",
              },
            ];
          }
        } else {
          const parsed = withStartingTargetCpa(
            businessSchema.parse(input.payload),
          );
          if (
            parsed.periodStart !== state.periodStart ||
            parsed.periodEnd !== state.periodEnd
          )
            throw new AppError(
              409,
              "Даты действующего периода нельзя менять. Создайте новый бизнес для другого периода.",
            );
          const budgetChanged = parsed.budget !== state.budget;
          Object.assign(state, parsed);
          if (budgetChanged) rebalance(state);
          state.postgresPilot = {
            ...(state.postgresPilot || {}),
            planConfirmedAt: null,
          };
          state.settingsRevision = Number(state.settingsRevision || 0) + 1;
          message = "Профиль бизнеса сохранён";
          entries = [
            {
              kind: "settings",
              title: "Профиль бизнеса обновлён",
              reason:
                parsed.landingMode === "yandex_landing"
                  ? "Сохранена опубликованная страница Яндекса. Код Метрики для неё не требуется."
                  : "Сохранён адрес сайта. Теперь можно выбрать обращение в Метрике.",
              rule: "user",
            },
          ];
        }
        assertBudget(state);
        for (const entry of entries) await event(tx, business.id, entry);
        return { message };
      },
    );
    res.json(response);
  });
  app.post(
    "/api/businesses/:id/acceptance-run",
    authenticated,
    async (req, res) => {
      const response = await command(
        db,
        req.user.id,
        req.params.id,
        idempotencyKey(req),
        hash("acceptance-simulation/1"),
        async (business, tx) => {
          const row = await tx
            .prepare(
              `SELECT plan_json FROM direct_changes
               WHERE business_id=? ORDER BY created_at DESC,id DESC LIMIT 1`,
            )
            .get(business.id);
          if (!row?.plan_json)
            throw new AppError(
              409,
              "Сначала подготовьте план рекламы, затем запустите его проверку.",
            );
          const run = await enqueueAcceptanceRunPostgres(
            tx,
            business,
            JSON.parse(row.plan_json),
          );
          return {
            message:
              "Тестовый прогон поставлен в очередь. Рабочая реклама не меняется.",
            acceptanceRun: run,
          };
        },
      );
      res.status(202).json(response);
    },
  );
  app.get(
    "/api/businesses/:id/acceptance-run/:runId/protocol",
    authenticated,
    async (req, res) => {
      const business = await requireBusiness(db, req.user.id, req.params.id);
      const run = (await acceptanceRunsPostgres(db, business.id)).find(
        (item) => item.id === req.params.runId,
      );
      const protocol = acceptanceProtocol(run, business.state.name);
      if (!protocol)
        throw new AppError(
          409,
          "Протокол появится после завершения тестового прогона.",
          "acceptance_pending",
        );
      res
        .set({
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="ritm-acceptance-${run.id}.txt"`,
        })
        .send(protocol);
    },
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({
      error:
        "Это действие пока недоступно в опубликованной версии. Вернитесь к основному маршруту или обновите страницу.",
      code: "postgres_pilot_pending",
    }),
  );
  const dist = resolve("dist");
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve(dist, "index.html")),
    );
  }
  app.use((error, req, res, _next) => {
    if (error instanceof z.ZodError)
      return res
        .status(400)
        .json({ error: "Проверьте заполненные поля.", code: "validation" });
    if (!(error instanceof AppError)) {
      const stackFrame = String(error?.stack || "")
        .split("\n")
        .slice(1, 3)
        .map((line) => line.trim())
        .join(" | ")
        .slice(0, 500);
      console.error(
        JSON.stringify({
          event: "server_error",
          type: error?.name || "Error",
          message: String(error?.message || "unknown_error").slice(0, 300),
          route: req?.originalUrl || req?.url || null,
          stackFrame: stackFrame || null,
        }),
      );
      if (process.env.DEBUG_POSTGRES_PILOT === "true") console.error(error);
    }
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
