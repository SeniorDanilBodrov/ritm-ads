import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./db.js";
import {
  buildDirectCommands,
  evaluateDirectPreflight,
  executeDirectCommands,
  heldCampaign,
  normalizeDirectKeyword,
  reconcileDirectObjects,
} from "./direct.js";
import { reconcileUnifiedNetworkObjects } from "./direct-unified-network.js";
import {
  assertPostgresNetworkReach,
  assertPostgresSearchReach,
} from "./postgres-direct-reach.js";
import { buildUnifiedNetworkCommands } from "./direct-unified-network.js";
import { approvedDirectImageHash } from "./postgres-direct-images.js";

const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const moscowDate = (now = Date.now()) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));

async function ownedBusiness(db, userId, businessId) {
  const row = await db
    .prepare("SELECT * FROM businesses WHERE id=? AND user_id=?")
    .get(businessId, userId);
  if (!row) throw new AppError(404, "Бизнес не найден.", "business_missing");
  return { ...row, state: JSON.parse(row.state) };
}

export async function reservePostgresCampaignBudget(
  tx,
  userId,
  businessId,
  changeId,
  requestedLimitKopecks,
  at = new Date().toISOString(),
) {
  const row = await tx
    .prepare(
      "SELECT id,state FROM businesses WHERE id=? AND user_id=? FOR UPDATE",
    )
    .get(businessId, userId);
  if (!row) throw new AppError(404, "Бизнес не найден.", "business_missing");
  const ownerLimitKopecks = JSON.parse(row.state)?.budget;
  if (
    !Number.isSafeInteger(ownerLimitKopecks) ||
    ownerLimitKopecks <= 0 ||
    !Number.isSafeInteger(requestedLimitKopecks) ||
    requestedLimitKopecks <= 0
  )
    throw new AppError(
      409,
      "Не удалось проверить общий бюджет бизнеса.",
      "portfolio_budget_invalid",
    );
  const allocations = await tx
    .prepare(
      `SELECT cba.change_id,cba.limit_kopecks
       FROM campaign_budget_allocations cba
       JOIN campaign_ad_lifecycle cl
         ON cl.business_id=cba.business_id AND cl.change_id=cba.change_id
       WHERE cba.business_id=?
         AND cl.status IN ('creating','paused','moderation','active','needs_reconciliation')
       FOR UPDATE`,
    )
    .all(businessId);
  const reservedKopecks = allocations.reduce((total, allocation) => {
    if (allocation.change_id === changeId) return total;
    const limit = Number(allocation.limit_kopecks);
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new AppError(
        409,
        "В портфеле найдена кампания с некорректным лимитом.",
        "portfolio_budget_invalid",
      );
    return total + limit;
  }, 0);
  if (reservedKopecks + requestedLimitKopecks > ownerLimitKopecks)
    throw new AppError(
      409,
      "Лимиты кампаний превысят общий бюджет бизнеса. Уменьшите лимит новой кампании или освободите остаток другой кампании.",
      "portfolio_budget_exceeded",
    );
  await tx
    .prepare(
      `INSERT INTO campaign_budget_allocations
       (business_id,change_id,limit_kopecks,updated_at)
       VALUES(?,?,?,?)
       ON CONFLICT(business_id,change_id) DO UPDATE SET
         limit_kopecks=excluded.limit_kopecks,updated_at=excluded.updated_at`,
    )
    .run(businessId, changeId, requestedLimitKopecks, at);
  return {
    ownerLimitKopecks,
    reservedKopecks,
    requestedLimitKopecks,
    availableKopecks:
      ownerLimitKopecks - reservedKopecks - requestedLimitKopecks,
  };
}

async function addEvent(db, businessId, payload) {
  const value = { id: randomUUID(), at: new Date().toISOString(), ...payload };
  await db
    .prepare("INSERT INTO events VALUES(?,?,?,?)")
    .run(value.id, businessId, value.at, JSON.stringify(value));
}

function executionView(row) {
  if (!row) return null;
  return {
    status: row.status,
    inflightKey: row.inflight_key,
    suspendVerified: !!row.suspend_verified,
    calls: JSON.parse(row.calls_json),
    errorCode: row.error_code,
    updatedAt: row.updated_at,
    reconciliation: row.reconciliation_json
      ? JSON.parse(row.reconciliation_json)
      : null,
  };
}

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function reconcileWithRetry(reconcile, attempts = 3) {
  let lastError = null;
  let lastResult = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await wait(350 * 2 ** (attempt - 1));
    try {
      lastResult = await reconcile();
      lastError = null;
      if (lastResult?.matched) return lastResult;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError && !lastResult) throw lastError;
  return lastResult;
}

// A lost response from Campaigns.add must never be replayed blindly. After a
// quiet period we can, however, prove that no remote campaign exists by reading
// the complete campaign list. Only that verified no-write case is released so
// the owner can prepare a fresh, versioned plan.
export async function releaseMissingPostgresDirectExecutions(
  db,
  userId,
  businessId,
  client,
  now = Date.now(),
) {
  await ownedBusiness(db, userId, businessId);
  const rows = await db
    .prepare(
      `SELECT de.change_id,de.calls_json,de.inflight_key,de.updated_at,dc.plan_json
       FROM direct_executions de
       JOIN direct_changes dc ON dc.id=de.change_id AND dc.business_id=de.business_id
       WHERE de.business_id=? AND de.status='needs_reconciliation'`,
    )
    .all(businessId);
  const candidates = rows.filter((row) => {
    const calls = JSON.parse(row.calls_json || "[]");
    const age = now - Date.parse(row.updated_at);
    return (
      calls.length === 0 &&
      (!row.inflight_key || row.inflight_key === "campaign") &&
      Number.isFinite(age) &&
      age >= 10 * 60_000
    );
  });
  if (!candidates.length) return { released: 0, externalReads: 0 };
  const remote = await client.campaigns();
  if (remote?.LimitedBy)
    return { released: 0, externalReads: 1, incomplete: true };
  const names = new Set((remote?.Campaigns || []).map((item) => item.Name));
  const missing = candidates.filter((row) => {
    const name = JSON.parse(row.plan_json || "{}")?.campaignName;
    return typeof name === "string" && !names.has(name);
  });
  if (!missing.length) return { released: 0, externalReads: 1 };
  await db.transaction(async (tx) => {
    const at = new Date(now).toISOString();
    for (const row of missing) {
      const reconciliation = {
        status: "verified_absent",
        matched: false,
        checkedAt: at,
      };
      await tx
        .prepare(
          `UPDATE direct_executions
           SET status='failed_no_write',inflight_key=NULL,error_code='verified_no_remote_campaign',
               reconciliation_json=?,updated_at=?
           WHERE business_id=? AND change_id=? AND status='needs_reconciliation'`,
        )
        .run(JSON.stringify(reconciliation), at, businessId, row.change_id);
      await tx
        .prepare(
          `UPDATE campaign_ad_lifecycle
           SET status='draft',reason=?,updated_at=?
           WHERE business_id=? AND change_id=?`,
        )
        .run(
          "Директ подтвердил, что кампания не была создана. Можно подготовить новый вариант.",
          at,
          businessId,
          row.change_id,
        );
      await tx
        .prepare(
          "DELETE FROM campaign_budget_allocations WHERE business_id=? AND change_id=?",
        )
        .run(businessId, row.change_id);
      await addEvent(tx, businessId, {
        kind: "direct_execution_absent",
        title: "Неудачная попытка безопасно закрыта",
        reason:
          "Директ не нашёл удалённую кампанию. Повтор возможен только новым планом.",
        rule: "direct/execution@2",
        jobId: row.change_id,
      });
    }
  });
  return { released: missing.length, externalReads: 1 };
}

function changeViewWithDetails(
  row,
  { preflight = null, approval = null, execution = null } = {},
) {
  const commands = JSON.parse(row.commands_json);
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    attempts: Number(row.attempts || 0),
    availableAt: Number(row.available_at || 0),
    plan: JSON.parse(row.plan_json),
    commands,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    reconciliation: row.reconciliation_json
      ? JSON.parse(row.reconciliation_json)
      : null,
    summary: {
      campaigns: 1,
      adGroups: 1,
      ads:
        commands.find((item) => item.key === "ads")?.params?.Ads?.length || 0,
      keywords:
        commands.find((item) => item.key === "keywords")?.params?.Keywords
          ?.length || 0,
      externalCalls: 0,
    },
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preflight: preflight ? JSON.parse(preflight.report_json) : null,
    approval:
      approval && Date.parse(approval.expires_at) > Date.now()
        ? {
            status: "confirmed",
            changeId: row.id,
            planFingerprint: approval.plan_fingerprint,
            confirmedAt: approval.confirmed_at,
            expiresAt: approval.expires_at,
            externalWrites: 0,
          }
        : null,
    execution: executionView(execution),
  };
}

async function changeView(db, row) {
  const [preflight, approval, execution] = await Promise.all([
    db
      .prepare(
        "SELECT report_json FROM direct_preflights WHERE business_id=? AND change_id=? ORDER BY checked_at DESC LIMIT 1",
      )
      .get(row.business_id, row.id),
    db
      .prepare(
        "SELECT * FROM direct_approvals WHERE business_id=? AND change_id=? AND consumed_at IS NULL",
      )
      .get(row.business_id, row.id),
    db
      .prepare(
        "SELECT * FROM direct_executions WHERE business_id=? AND change_id=?",
      )
      .get(row.business_id, row.id),
  ]);
  return changeViewWithDetails(row, { preflight, approval, execution });
}

async function directChange(db, userId, businessId, changeId) {
  const business = await ownedBusiness(db, userId, businessId);
  const row = await db
    .prepare(
      `SELECT dc.*,j.status,j.attempts,j.available_at,j.error
       FROM direct_changes dc JOIN jobs j ON j.id=dc.id
       WHERE dc.id=? AND dc.business_id=?`,
    )
    .get(changeId, business.id);
  if (!row) throw new AppError(404, "Подготовленный план не найден.");
  return { business, row, change: await changeView(db, row) };
}

export async function postgresDirectChanges(db, userId, businessId) {
  await ownedBusiness(db, userId, businessId);
  const [rows, preflights, approvals, executions] = await Promise.all([
    db
      .prepare(
        `SELECT dc.*,j.status,j.attempts,j.available_at,j.error
         FROM direct_changes dc JOIN jobs j ON j.id=dc.id
         WHERE dc.business_id=? ORDER BY dc.created_at DESC LIMIT 20`,
      )
      .all(businessId),
    db
      .prepare(
        "SELECT change_id,report_json FROM direct_preflights WHERE business_id=? ORDER BY checked_at DESC",
      )
      .all(businessId),
    db
      .prepare(
        "SELECT * FROM direct_approvals WHERE business_id=? AND consumed_at IS NULL",
      )
      .all(businessId),
    db
      .prepare("SELECT * FROM direct_executions WHERE business_id=?")
      .all(businessId),
  ]);
  const firstPreflight = new Map();
  for (const row of preflights)
    if (!firstPreflight.has(row.change_id))
      firstPreflight.set(row.change_id, row);
  const approvalByChange = new Map(
    approvals.map((row) => [row.change_id, row]),
  );
  const executionByChange = new Map(
    executions.map((row) => [row.change_id, row]),
  );
  return rows.map((row) =>
    changeViewWithDetails(row, {
      preflight: firstPreflight.get(row.id),
      approval: approvalByChange.get(row.id),
      execution: executionByChange.get(row.id),
    }),
  );
}

export function attachPostgresDirectImageHashes(input, imageHashes, network) {
  if (!imageHashes.length) return input;
  return network
    ? {
        ...input,
        ads: input.ads.map((ad) => ({ ...ad, adImageHashes: imageHashes })),
      }
    : {
        ...input,
        ads: input.ads.map((ad, index) => ({
          ...ad,
          adImageHash: imageHashes[index % imageHashes.length],
        })),
      };
}

export async function preparePostgresDirectPlan(
  db,
  userId,
  businessId,
  requestKey,
  input,
  directContext = null,
) {
  return db.transaction(async (tx) => {
    const business = await ownedBusiness(tx, userId, businessId);
    if (business.state.mode === "demo")
      throw new AppError(409, "Реальный план недоступен в демо.");
    if (!business.state.postgresPilot?.planConfirmedAt)
      throw new AppError(
        409,
        "Сначала подтвердите общий рекламный план.",
        "plan_not_confirmed",
      );
    const approved = (business.state.creatives || []).filter(
      (item) => item.status === "approved",
    );
    if (!approved.length)
      throw new AppError(
        409,
        "Согласуйте хотя бы один текст объявления.",
        "creative_not_approved",
      );
    const network = input?.channel === "network";
    const approvedTitles = new Set(
      approved.map((creative) => creative.title.slice(0, 56)),
    );
    const approvedTexts = new Set(
      approved.map((creative) => creative.text.slice(0, 81)),
    );
    const creativesChanged = network
      ? !input?.ads?.length ||
        input.ads.some(
          (ad) =>
            !ad?.titles?.length ||
            !ad?.texts?.length ||
            ad.titles.some((title) => !approvedTitles.has(title)) ||
            ad.texts.some((text) => !approvedTexts.has(text)),
        )
      : !input?.ads?.length ||
        input.ads.some(
          (ad) =>
            !approved.some(
              (creative) =>
                creative.title.slice(0, 56) === ad.title &&
                creative.text.slice(0, 81) === ad.text,
            ),
        );
    if (creativesChanged)
      throw new AppError(
        409,
        "В плане можно использовать только согласованные тексты.",
        "creative_changed",
      );
    let resolvedInput = input;
    const creativeAssetIds = [
      ...new Set(
        (Array.isArray(input?.creativeAssetIds)
          ? input.creativeAssetIds
          : input?.creativeAssetId
            ? [input.creativeAssetId]
            : []
        ).filter(Boolean),
      ),
    ].slice(0, 5);
    if (network && !creativeAssetIds.length)
      throw new AppError(
        409,
        "Для Рекламной сети выберите согласованное изображение.",
        "creative_image_missing",
      );
    if (creativeAssetIds.length) {
      if (!directContext?.connectionId)
        throw new AppError(
          409,
          "Сначала подключите кабинет Директа.",
          "yandex_missing",
        );
      const adImageHashes = await Promise.all(
        creativeAssetIds.map((assetId) =>
          approvedDirectImageHash(
            tx,
            userId,
            business.id,
            assetId,
            directContext.connectionId,
            input.login,
          ),
        ),
      );
      resolvedInput = attachPostgresDirectImageHashes(
        input,
        adImageHashes,
        network,
      );
    }
    if (network) assertPostgresNetworkReach(resolvedInput);
    else assertPostgresSearchReach(resolvedInput);
    const built = network
      ? buildUnifiedNetworkCommands(resolvedInput)
      : buildDirectCommands(resolvedInput);
    const existing = await tx
      .prepare(
        `SELECT dc.*,j.status,j.attempts,j.available_at,j.error
         FROM direct_changes dc JOIN jobs j ON j.id=dc.id
         WHERE dc.business_id=? AND dc.idempotency_key=?`,
      )
      .get(business.id, requestKey);
    if (existing) {
      if (
        fingerprint(JSON.parse(existing.plan_json)) !== fingerprint(built.plan)
      )
        throw new AppError(
          409,
          "Этот запрос уже использован для другого плана.",
          "idempotency_conflict",
        );
      return changeView(tx, existing);
    }
    const id = randomUUID();
    const now = Date.now();
    const at = new Date(now).toISOString();
    const reconciliation = {
      status: "prepared",
      expectedCommands: built.commands.length,
      preparedCommands: built.commands.length,
      externalCalls: 0,
      checkedAt: at,
    };
    await tx
      .prepare(
        "INSERT INTO jobs(id,business_id,kind,status,available_at,attempts,payload,error) VALUES(?,?,'direct_change','succeeded',?,0,?,NULL)",
      )
      .run(id, business.id, now, JSON.stringify({ mode: "dry_run" }));
    await tx
      .prepare(
        `INSERT INTO direct_changes(id,business_id,idempotency_key,mode,plan_json,commands_json,result_json,reconciliation_json,created_at,updated_at)
         VALUES(?,?,?,'dry_run',?,?,NULL,?,?,?)`,
      )
      .run(
        id,
        business.id,
        requestKey,
        JSON.stringify(built.plan),
        JSON.stringify(built.commands),
        JSON.stringify(reconciliation),
        at,
        at,
      );
    await tx
      .prepare(
        `INSERT INTO campaign_ad_lifecycle(business_id,change_id,status,reason,updated_at)
         VALUES(?,?,'draft',?,?)
         ON CONFLICT(business_id,change_id) DO NOTHING`,
      )
      .run(
        business.id,
        id,
        "План подготовлен локально. В Директе ничего не создано.",
        at,
      );
    await addEvent(tx, business.id, {
      kind: "direct_plan",
      title: "Подготовлен план кампании",
      reason: network
        ? `${built.summary.ads} комбинаторных объявлений для Рекламной сети. В Директе ничего не менялось.`
        : `${built.summary.ads} объявлений и ${built.summary.keywords} фраз. В Директе ничего не менялось.`,
      rule: built.schema,
      jobId: id,
    });
    const row = await tx
      .prepare(
        `SELECT dc.*,j.status,j.attempts,j.available_at,j.error
         FROM direct_changes dc JOIN jobs j ON j.id=dc.id WHERE dc.id=?`,
      )
      .get(id);
    return changeView(tx, row);
  });
}

export async function preflightPostgresDirectPlan(
  db,
  userId,
  businessId,
  changeId,
  requestKey,
  { clientForLogin, clients, connectionId },
) {
  const { business, change } = await directChange(
    db,
    userId,
    businessId,
    changeId,
  );
  if (change.execution)
    throw new AppError(
      409,
      "Кампания уже создана. Перейдите к модерации объявлений.",
      "direct_execution_exists",
    );
  const previous = await db
    .prepare(
      "SELECT change_id,report_json FROM direct_preflights WHERE business_id=? AND idempotency_key=?",
    )
    .get(business.id, requestKey);
  if (previous) {
    if (previous.change_id !== change.id)
      throw new AppError(409, "Этот запрос уже относится к другому плану.");
    return JSON.parse(previous.report_json);
  }
  const remote = await clientForLogin.campaigns();
  const report = evaluateDirectPreflight(business, change, {
    clients,
    campaigns: remote.Campaigns || [],
    limitedBy: remote.LimitedBy,
    readCalls: 2,
    connectionId,
  });
  await db.transaction(async (tx) => {
    const id = randomUUID();
    await tx
      .prepare(
        "INSERT INTO direct_preflights(id,business_id,change_id,idempotency_key,checked_at,report_json) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        business.id,
        change.id,
        requestKey,
        report.checkedAt,
        JSON.stringify(report),
      );
    await tx
      .prepare(
        `UPDATE campaign_ad_lifecycle SET status=?,reason=?,updated_at=?
         WHERE business_id=? AND change_id=?`,
      )
      .run(
        report.ready ? "ready" : "blocked",
        report.ready
          ? "Кабинет и план проверены. Можно подтвердить создание выключенного черновика."
          : "Проверка нашла препятствия. В Директе ничего не менялось.",
        new Date().toISOString(),
        business.id,
        change.id,
      );
    await addEvent(tx, business.id, {
      kind: "direct_preflight",
      title: report.ready ? "Проверка пройдена" : "Нужны исправления",
      reason: report.ready
        ? "Кабинет доступен, бюджет и даты проверены. Записей в Директ не было."
        : `${report.findings.filter((item) => item.severity === "blocker").length} препятствий до создания черновика.`,
      rule: report.schema,
      jobId: change.id,
    });
  });
  return report;
}

export async function confirmPostgresDirectPlan(
  db,
  userId,
  businessId,
  changeId,
  planFingerprint,
  now = Date.now(),
) {
  return db.transaction(async (tx) => {
    const { business, change } = await directChange(
      tx,
      userId,
      businessId,
      changeId,
    );
    const latest = await tx
      .prepare(
        "SELECT id,report_json FROM direct_preflights WHERE business_id=? AND change_id=? ORDER BY checked_at DESC LIMIT 1",
      )
      .get(business.id, change.id);
    const connection = await tx
      .prepare(
        "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
      )
      .get(business.id);
    const metadata = connection ? JSON.parse(connection.metadata) : null;
    const report = latest ? JSON.parse(latest.report_json) : null;
    if (
      !report?.ready ||
      report.planFingerprint !== planFingerprint ||
      planFingerprint !== fingerprint(change.plan) ||
      report.connectionId !== metadata?.connectionId ||
      now - Date.parse(report.checkedAt) > 10 * 60_000 ||
      now < Date.parse(report.checkedAt) ||
      change.plan.periodStart <= moscowDate(now)
    )
      throw new AppError(
        409,
        "Проверка устарела или план изменился. Проверьте его снова.",
        "stale_preflight",
      );
    const confirmedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + 10 * 60_000).toISOString();
    await tx
      .prepare(
        `INSERT INTO direct_approvals(change_id,business_id,preflight_id,plan_fingerprint,connection_id,confirmed_at,expires_at,consumed_at)
         VALUES(?,?,?,?,?,?,?,NULL)
         ON CONFLICT(change_id) DO UPDATE SET preflight_id=excluded.preflight_id,
         plan_fingerprint=excluded.plan_fingerprint,connection_id=excluded.connection_id,
         confirmed_at=excluded.confirmed_at,expires_at=excluded.expires_at,consumed_at=NULL`,
      )
      .run(
        change.id,
        business.id,
        latest.id,
        planFingerprint,
        metadata.connectionId,
        confirmedAt,
        expiresAt,
      );
    await addEvent(tx, business.id, {
      kind: "direct_plan_confirmed",
      title: "Создание выключенного черновика подтверждено",
      reason: "Подтверждение действует 10 минут. Показы ещё не запущены.",
      rule: "direct/approval@1",
      jobId: change.id,
    });
    return {
      status: "confirmed",
      changeId: change.id,
      planFingerprint,
      confirmedAt,
      expiresAt,
      externalWrites: 0,
    };
  });
}

async function checkpointExecution(db, businessId, changeId, checkpoint) {
  await db.transaction(async (tx) => {
    const row = await tx
      .prepare(
        "SELECT * FROM direct_executions WHERE business_id=? AND change_id=?",
      )
      .get(businessId, changeId);
    if (!row || row.status !== "running")
      throw new AppError(409, "Создание черновика остановлено до сверки.");
    const calls = JSON.parse(row.calls_json);
    const at = new Date().toISOString();
    if (checkpoint.phase === "before") {
      if (row.inflight_key)
        throw new AppError(409, "Предыдущий шаг ещё не подтверждён.");
      await tx
        .prepare(
          "UPDATE direct_executions SET inflight_key=?,updated_at=? WHERE change_id=?",
        )
        .run(checkpoint.key, at, changeId);
    } else if (checkpoint.phase === "acknowledged") {
      if (row.inflight_key !== checkpoint.key)
        throw new AppError(409, "Ответ Директа не совпал с ожидаемым шагом.");
      await tx
        .prepare(
          "UPDATE direct_executions SET inflight_key=NULL,calls_json=?,updated_at=? WHERE change_id=?",
        )
        .run(
          JSON.stringify([
            ...calls,
            {
              key: checkpoint.key,
              ids: checkpoint.ids,
              ...(checkpoint.holdState
                ? { holdState: checkpoint.holdState }
                : {}),
            },
          ]),
          at,
          changeId,
        );
    } else if (checkpoint.phase === "suspend_verified") {
      await tx
        .prepare(
          "UPDATE direct_executions SET suspend_verified=1,updated_at=? WHERE change_id=?",
        )
        .run(at, changeId);
    }
  });
}

export async function executePostgresDirectPlan(
  db,
  userId,
  businessId,
  changeId,
  planFingerprint,
  client,
  now = Date.now(),
) {
  await releaseMissingPostgresDirectExecutions(
    db,
    userId,
    businessId,
    client,
    now,
  );
  const prepared = await db.transaction(async (tx) => {
    const { business, change } = await directChange(
      tx,
      userId,
      businessId,
      changeId,
    );
    const approval = await tx
      .prepare(
        "SELECT * FROM direct_approvals WHERE business_id=? AND change_id=?",
      )
      .get(business.id, change.id);
    const latest = await tx
      .prepare(
        "SELECT id,report_json FROM direct_preflights WHERE business_id=? AND change_id=? ORDER BY checked_at DESC LIMIT 1",
      )
      .get(business.id, change.id);
    const connection = await tx
      .prepare(
        "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
      )
      .get(business.id);
    const metadata = connection ? JSON.parse(connection.metadata) : null;
    const report = latest ? JSON.parse(latest.report_json) : null;
    const existing = await tx
      .prepare("SELECT 1 AS found FROM direct_executions WHERE change_id=?")
      .get(change.id);
    if (existing)
      throw new AppError(
        409,
        "Этот план уже передавался в Директ. Повторная отправка запрещена.",
        "direct_execution_exists",
      );
    if (
      !approval ||
      approval.consumed_at ||
      approval.plan_fingerprint !== planFingerprint ||
      planFingerprint !== fingerprint(change.plan) ||
      approval.preflight_id !== latest?.id ||
      approval.connection_id !== metadata?.connectionId ||
      !report?.ready ||
      Date.parse(approval.expires_at) <= now ||
      change.plan.periodStart <= moscowDate(now)
    )
      throw new AppError(
        409,
        "Подтверждение устарело. Повторите проверку.",
        "stale_preflight",
      );
    const active = await tx
      .prepare(
        "SELECT 1 AS found FROM direct_executions WHERE business_id=? AND status IN ('running','needs_reconciliation')",
      )
      .get(business.id);
    if (active)
      throw new AppError(
        409,
        "Сначала завершите сверку предыдущей операции.",
        "direct_execution_active",
      );
    const at = new Date(now).toISOString();
    await reservePostgresCampaignBudget(
      tx,
      userId,
      business.id,
      change.id,
      change.plan.budget,
      at,
    );
    await tx
      .prepare(
        `INSERT INTO direct_executions(change_id,business_id,connection_id,plan_fingerprint,status,inflight_key,suspend_verified,calls_json,started_at,updated_at,error_code,reconciliation_json)
         VALUES(?,?,?,?,'running',NULL,0,'[]',?,?,NULL,NULL)`,
      )
      .run(
        change.id,
        business.id,
        metadata.connectionId,
        planFingerprint,
        at,
        at,
      );
    await tx
      .prepare(
        "UPDATE direct_approvals SET consumed_at=? WHERE change_id=? AND consumed_at IS NULL",
      )
      .run(at, change.id);
    await tx
      .prepare(
        "UPDATE campaign_ad_lifecycle SET status='creating',reason=?,updated_at=? WHERE business_id=? AND change_id=?",
      )
      .run(
        "Создаём только выключенный черновик и сохраняем каждый ответ Директа.",
        at,
        business.id,
        change.id,
      );
    await addEvent(tx, business.id, {
      kind: "direct_execution_started",
      title: "Начато создание выключенного черновика",
      reason: "Каждый внешний шаг записывается до перехода к следующему.",
      rule: "direct/execution@1",
      jobId: change.id,
    });
    return { business, change };
  });

  try {
    const result = await executeDirectCommands(
      client,
      prepared.change.commands,
      {
        checkpoint: (item) =>
          checkpointExecution(
            db,
            prepared.business.id,
            prepared.change.id,
            item,
          ),
      },
    );
    const reconciliation = await reconcileWithRetry(() =>
      prepared.change.plan.channel === "network"
        ? reconcileUnifiedNetworkObjects(
            client,
            result.calls,
            prepared.change.plan,
          )
        : reconcileDirectObjects(client, result.calls, prepared.change.plan),
    );
    if (!reconciliation.matched)
      throw new AppError(
        409,
        "Созданные объекты не прошли полную сверку.",
        "direct_reconciliation",
      );
    await db.transaction(async (tx) => {
      const at = new Date().toISOString();
      await tx
        .prepare(
          "UPDATE direct_executions SET status='succeeded',inflight_key=NULL,reconciliation_json=?,updated_at=? WHERE change_id=?",
        )
        .run(JSON.stringify(reconciliation), at, prepared.change.id);
      await tx
        .prepare(
          "UPDATE campaign_ad_lifecycle SET status='paused',reason=?,updated_at=? WHERE business_id=? AND change_id=?",
        )
        .run(
          "Выключенная кампания и все объекты созданы и повторно прочитаны. Показы не идут.",
          at,
          prepared.business.id,
          prepared.change.id,
        );
      await addEvent(tx, prepared.business.id, {
        kind: "direct_execution_verified",
        title: "Выключенная кампания создана",
        reason: "Все объекты сверены чтением API. Показы не запущены.",
        rule: "direct/execution@1",
        jobId: prepared.change.id,
      });
    });
  } catch (error) {
    await db.transaction(async (tx) => {
      const at = new Date().toISOString();
      await tx
        .prepare(
          "UPDATE direct_executions SET status='needs_reconciliation',error_code=?,updated_at=? WHERE change_id=?",
        )
        .run(error?.code || "unknown_result", at, prepared.change.id);
      await tx
        .prepare(
          "UPDATE campaign_ad_lifecycle SET status='needs_reconciliation',reason=?,updated_at=? WHERE business_id=? AND change_id=?",
        )
        .run(
          "Ответ Директа нужно сверить. Автоматический повтор заблокирован.",
          at,
          prepared.business.id,
          prepared.change.id,
        );
      await addEvent(tx, prepared.business.id, {
        kind: "direct_execution_uncertain",
        title: "Создание остановлено для сверки",
        reason: "Повторная отправка запрещена, чтобы не создать дубликаты.",
        rule: "direct/execution@1",
        jobId: prepared.change.id,
      });
    });
    throw error;
  }
  const row = await db
    .prepare(
      "SELECT * FROM direct_executions WHERE business_id=? AND change_id=?",
    )
    .get(prepared.business.id, prepared.change.id);
  return executionView(row);
}

// Continue a search draft only after a complete read-back proves which
// objects exist.  This is deliberately narrower than a generic retry: the
// campaign and group must match the stored checkpoints, the campaign must be
// held, and only phrases that are absent from the group may be written again.
export async function continuePostgresDirectExecution(
  db,
  userId,
  businessId,
  changeId,
  client,
  { enabled = false, now = Date.now() } = {},
) {
  if (!enabled)
    throw new AppError(409, "Реальная запись в Директ отключена.", "live_gate");
  const { business, change } = await directChange(
    db,
    userId,
    businessId,
    changeId,
  );
  const current = await db
    .prepare(
      "SELECT * FROM direct_executions WHERE business_id=? AND change_id=?",
    )
    .get(business.id, change.id);
  if (!current)
    throw new AppError(404, "Создание кампании ещё не начиналось.");
  const calls = JSON.parse(current.calls_json);
  const campaignId = calls[0]?.ids?.[0];
  const groupId = calls[2]?.ids?.[0];
  const recoveringKeywords =
    current.status === "needs_reconciliation" &&
    current.inflight_key === "keywords" &&
    calls.length === 3 &&
    calls[0]?.key === "campaign" &&
    calls[1]?.key === "suspend" &&
    calls[1]?.holdState === "OFF_DRAFT" &&
    calls[2]?.key === "adgroup" &&
    !!current.suspend_verified;
  if (
    change.plan.channel === "network" ||
    !recoveringKeywords ||
    !Number.isSafeInteger(campaignId) ||
    !Number.isSafeInteger(groupId)
  )
    throw new AppError(
      409,
      "Безопасное продолжение доступно только после остановки на ключевых фразах.",
      "direct_continue_unavailable",
    );

  const plannedPhrases = change.plan.keywords.map(normalizeDirectKeyword);
  if (
    plannedPhrases.some((phrase) => !phrase) ||
    new Set(plannedPhrases).size !== plannedPhrases.length
  )
    throw new AppError(
      409,
      "После нормализации ключевые фразы совпали. Подготовьте новый план.",
      "direct_keyword_collision",
    );

  const [campaigns, groups, keywords, ads] = await Promise.all([
    client.campaignsByIds([campaignId]),
    client.adGroupsByIds([groupId]),
    client.keywordsByAdGroupId(groupId),
    client.adsByAdGroupId(groupId),
  ]);
  const campaign = campaigns.Campaigns?.find(
    (item) => String(item.Id) === String(campaignId),
  );
  const group = groups.AdGroups?.find(
    (item) => String(item.Id) === String(groupId),
  );
  const remoteKeywords = (keywords.Keywords || []).filter(
    (item) => item.Keyword !== "---autotargeting",
  );
  const remoteByPhrase = new Map(
    remoteKeywords.map((item) => [normalizeDirectKeyword(item.Keyword), item]),
  );
  const missingPhrases = plannedPhrases.filter(
    (phrase) => !remoteByPhrase.has(phrase),
  );
  const previousReconciliation = current.reconciliation_json
    ? JSON.parse(current.reconciliation_json)
    : null;
  if (
    !campaign ||
    !heldCampaign(campaign) ||
    !group ||
    String(group.CampaignId) !== String(campaignId) ||
    groups.LimitedBy != null ||
    keywords.LimitedBy != null ||
    ads.LimitedBy != null ||
    !Array.isArray(ads.Ads || []) ||
    (ads.Ads || []).length !== 0 ||
    remoteKeywords.length > plannedPhrases.length ||
    remoteKeywords.some(
      (item) =>
        String(item.AdGroupId) !== String(groupId) ||
        !plannedPhrases.includes(normalizeDirectKeyword(item.Keyword)),
    ) ||
    remoteByPhrase.size !== remoteKeywords.length ||
    (missingPhrases.length > 0 &&
      previousReconciliation?.keywordRepair?.attempted === true)
  )
    throw new AppError(
      409,
      "Кампания, группа или найденные фразы не совпадают с сохранённым планом.",
      "direct_keyword_reconciliation",
    );

  const startedAt = new Date(now).toISOString();
  await db.transaction(async (tx) => {
    const latest = await tx
      .prepare(
        "SELECT status,inflight_key,calls_json,updated_at FROM direct_executions WHERE business_id=? AND change_id=?",
      )
      .get(business.id, change.id);
    if (
      latest?.status !== "needs_reconciliation" ||
      latest.inflight_key !== "keywords" ||
      latest.updated_at !== current.updated_at ||
      latest.calls_json !== current.calls_json
    )
      throw new AppError(409, "Исполнение изменилось во время сверки.");
    await tx
      .prepare(
        "UPDATE direct_executions SET status='running',error_code=NULL,reconciliation_json=?,updated_at=? WHERE change_id=?",
      )
      .run(
        JSON.stringify({
          status: missingPhrases.length
            ? "keyword_repair_sending"
            : "keywords_read_back",
          keywordRepair: {
            attempted: missingPhrases.length > 0,
            attemptedAt: missingPhrases.length ? startedAt : null,
            missingCount: missingPhrases.length,
          },
        }),
        startedAt,
        change.id,
      );
    await addEvent(tx, business.id, {
      kind: missingPhrases.length
        ? "direct_keywords_repair_started"
        : "direct_keywords_reconciled",
      title: missingPhrases.length
        ? "Продолжаем создание с недостающих фраз"
        : "Ключевые фразы найдены",
      reason: missingPhrases.length
        ? `Полное чтение группы подтвердило отсутствие ${missingPhrases.length} фраз. Повторяются только они.`
        : "Все фразы найдены чтением API; повторного добавления не будет.",
      rule: "direct/execution@2",
      jobId: change.id,
    });
  });

  try {
    if (missingPhrases.length) {
      let writeError = null;
      try {
        await client.createKeywords(
          missingPhrases.map((Keyword) => ({
            AdGroupId: groupId,
            Keyword,
            StrategyPriority: "NORMAL",
          })),
        );
      } catch (error) {
        // A transport error can arrive after Direct has accepted the write.
        // Always read the complete group before deciding that repair failed.
        writeError = error;
      }
      const repaired = await client.keywordsByAdGroupId(groupId);
      const repairedKeywords = (repaired.Keywords || []).filter(
        (item) => item.Keyword !== "---autotargeting",
      );
      remoteByPhrase.clear();
      for (const item of repairedKeywords)
        remoteByPhrase.set(normalizeDirectKeyword(item.Keyword), item);
      if (
        repaired.LimitedBy != null ||
        repairedKeywords.length !== plannedPhrases.length ||
        remoteByPhrase.size !== plannedPhrases.length ||
        plannedPhrases.some((phrase) => !remoteByPhrase.has(phrase))
      )
        throw (
          writeError ||
          new AppError(
            409,
            "Директ не подтвердил недостающие ключевые фразы.",
            "keyword_repair_unconfirmed",
          )
        );
    }

    const keywordIds = plannedPhrases.map(
      (phrase) => remoteByPhrase.get(phrase).Id,
    );
    await checkpointExecution(db, business.id, change.id, {
      phase: "acknowledged",
      key: "keywords",
      ids: keywordIds,
    });
    const initialCalls = [
      ...calls,
      { key: "keywords", ids: keywordIds },
    ];
    const result = await executeDirectCommands(client, change.commands, {
      initialCalls,
      initialResults: {
        campaign: { Id: campaignId },
        suspend: { Id: campaignId },
        adgroup: { Id: groupId },
        keywords: { Id: keywordIds[0] },
        campaignType: campaign.Type,
      },
      checkpoint: (item) =>
        checkpointExecution(db, business.id, change.id, item),
    });
    const reconciliation = await reconcileWithRetry(() =>
      reconcileDirectObjects(client, result.calls, change.plan),
    );
    if (!reconciliation?.matched)
      throw new AppError(
        409,
        "Созданные объявления не прошли полную сверку.",
        "direct_reconciliation",
      );
    await db.transaction(async (tx) => {
      const at = new Date().toISOString();
      await tx
        .prepare(
          "UPDATE direct_executions SET status='succeeded',inflight_key=NULL,reconciliation_json=?,updated_at=? WHERE change_id=?",
        )
        .run(JSON.stringify(reconciliation), at, change.id);
      await tx
        .prepare(
          "UPDATE campaign_ad_lifecycle SET status='paused',reason=?,updated_at=? WHERE business_id=? AND change_id=?",
        )
        .run(
          "Все фразы и объявления созданы и подтверждены чтением Директа. Показы не идут.",
          at,
          business.id,
          change.id,
        );
      await addEvent(tx, business.id, {
        kind: "direct_execution_verified",
        title: "Создание объявлений завершено",
        reason:
          "Недостающие объекты добавлены, затем вся кампания сверена чтением API.",
        rule: "direct/execution@2",
        jobId: change.id,
      });
    });
  } catch (error) {
    await db.transaction(async (tx) => {
      const at = new Date().toISOString();
      await tx
        .prepare(
          "UPDATE direct_executions SET status='needs_reconciliation',error_code=?,updated_at=? WHERE change_id=?",
        )
        .run(error?.code || "unknown_result", at, change.id);
      await tx
        .prepare(
          "UPDATE campaign_ad_lifecycle SET status='needs_reconciliation',reason=?,updated_at=? WHERE business_id=? AND change_id=?",
        )
        .run(
          "Продолжение остановлено: ответ Директа снова требует сверки.",
          at,
          business.id,
          change.id,
        );
      await addEvent(tx, business.id, {
        kind: "direct_execution_uncertain",
        title: "Продолжение остановлено для сверки",
        reason: "Неподтверждённый внешний шаг не повторяется автоматически.",
        rule: "direct/execution@2",
        jobId: change.id,
      });
    });
    throw error;
  }
  const completed = await db
    .prepare(
      "SELECT * FROM direct_executions WHERE business_id=? AND change_id=?",
    )
    .get(business.id, change.id);
  return executionView(completed);
}

export async function inspectPostgresDirectExecution(
  db,
  userId,
  businessId,
  changeId,
  client,
) {
  const { business, change } = await directChange(
    db,
    userId,
    businessId,
    changeId,
  );
  const row = await db
    .prepare(
      "SELECT * FROM direct_executions WHERE business_id=? AND change_id=?",
    )
    .get(business.id, change.id);
  if (!row) throw new AppError(404, "Создание кампании ещё не начиналось.");
  if (row.status !== "needs_reconciliation")
    throw new AppError(409, "Этому созданию не требуется сверка.");
  const calls = JSON.parse(row.calls_json);
  let reconciliation;
  const expectedKeys =
    change.plan.channel === "network"
      ? ["campaign", "suspend", "adgroup", "ads"]
      : ["campaign", "suspend", "adgroup", "keywords", "ads"];
  if (expectedKeys.every((key, index) => calls[index]?.key === key)) {
    reconciliation = await reconcileWithRetry(
      () =>
        change.plan.channel === "network"
          ? reconcileUnifiedNetworkObjects(client, calls, change.plan)
          : reconcileDirectObjects(client, calls, change.plan),
      2,
    );
  } else {
    const campaignId = calls.find((item) => item.key === "campaign")?.ids?.[0];
    const remote = campaignId
      ? await client.campaignsByIds([campaignId])
      : { Campaigns: [] };
    reconciliation = {
      status: "incomplete",
      matched: false,
      unresolvedStep: row.inflight_key || null,
      knownCampaignId: campaignId || null,
      knownCampaignState:
        remote.Campaigns?.find((item) => item.Id === campaignId)?.State || null,
      checkedAt: new Date().toISOString(),
    };
  }
  await db.transaction(async (tx) => {
    const at = new Date().toISOString();
    const complete = reconciliation.status === "matched";
    await tx
      .prepare(
        "UPDATE direct_executions SET status=?,reconciliation_json=?,updated_at=? WHERE change_id=?",
      )
      .run(
        complete ? "succeeded" : "needs_reconciliation",
        JSON.stringify(reconciliation),
        at,
        change.id,
      );
    await tx
      .prepare(
        "UPDATE campaign_ad_lifecycle SET status=?,reason=?,updated_at=? WHERE business_id=? AND change_id=?",
      )
      .run(
        complete ? "paused" : "needs_reconciliation",
        complete
          ? "Все созданные объекты найдены. Кампания выключена."
          : "Сверены известные объекты. Неопределённый шаг не повторяется автоматически.",
        at,
        business.id,
        change.id,
      );
    await addEvent(tx, business.id, {
      kind: complete
        ? "direct_execution_verified"
        : "direct_execution_inspected",
      title: complete ? "Кампания сверена" : "Проверены известные объекты",
      reason: complete
        ? "Все объекты найдены, кампания выключена."
        : "Повторная отправка остаётся заблокированной.",
      rule: "direct/execution@1",
      jobId: change.id,
    });
  });
  const updated = await db
    .prepare(
      "SELECT * FROM direct_executions WHERE business_id=? AND change_id=?",
    )
    .get(business.id, change.id);
  return executionView(updated);
}
