import { createHash } from "node:crypto";
import { AppError, event, requireBusiness, transaction } from "./db.js";
import {
  buildDirectCommands,
  directChangeForPreflight,
  executeDirectCommands,
  heldCampaign,
  reconcileDirectObjects,
} from "./direct.js";

const keys = ["campaign", "suspend", "adgroup", "keywords", "ads"];
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const moscowDate = (now) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));

function rowView(row) {
  return {
    changeId: row.change_id,
    businessId: row.business_id,
    status: row.status,
    inflightKey: row.inflight_key,
    suspendVerified: !!row.suspend_verified,
    calls: JSON.parse(row.calls_json),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    errorCode: row.error_code,
    reconciliation: row.reconciliation_json
      ? JSON.parse(row.reconciliation_json)
      : null,
  };
}

export function directExecution(db, userId, businessId, changeId) {
  requireBusiness(db, userId, businessId);
  const row = db
    .prepare(
      "SELECT * FROM direct_executions WHERE business_id=? AND change_id=?",
    )
    .get(businessId, changeId);
  if (!row) throw new AppError(404, "Исполнение плана не найдено.");
  return rowView(row);
}

// This only opens a one-shot journal. No production route or worker calls it.
export function beginDirectExecution(
  db,
  userId,
  businessId,
  changeId,
  { enabled = false, now = Date.now() } = {},
) {
  if (!enabled)
    throw new AppError(409, "Реальная запись в Директ отключена.", "live_gate");
  return transaction(db, () => {
    const { business, change } = directChangeForPreflight(
      db,
      userId,
      businessId,
      changeId,
    );
    const approval = db
      .prepare(
        "SELECT * FROM direct_approvals WHERE change_id=? AND business_id=?",
      )
      .get(changeId, business.id);
    const latest = db
      .prepare(
        "SELECT id,report_json FROM direct_preflights WHERE business_id=? AND change_id=? ORDER BY checked_at DESC,rowid DESC LIMIT 1",
      )
      .get(business.id, changeId);
    const connection = db
      .prepare(
        "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
      )
      .get(business.id);
    const connectionId = connection
      ? JSON.parse(connection.metadata).connectionId
      : null;
    const report = latest ? JSON.parse(latest.report_json) : null;
    const fresh = report && Date.parse(report.checkedAt);
    const built = buildDirectCommands(change.plan);
    if (
      business.state.mode === "demo" ||
      change.status !== "succeeded" ||
      change.reconciliation?.status !== "prepared" ||
      hash(change.commands) !== hash(built.commands) ||
      !approval ||
      approval.consumed_at ||
      approval.preflight_id !== latest?.id ||
      approval.connection_id !== connectionId ||
      approval.plan_fingerprint !== hash(change.plan) ||
      !report?.ready ||
      report.planFingerprint !== hash(change.plan) ||
      report.connectionId !== connectionId ||
      !Number.isFinite(fresh) ||
      now < fresh ||
      now - fresh > 10 * 60_000 ||
      Date.parse(approval.expires_at) <= now ||
      change.plan.periodStart <= moscowDate(now)
    )
      throw new AppError(
        409,
        "Подтверждение или проверка устарели. Повторите preflight.",
        "stale_preflight",
      );
    if (
      db
        .prepare("SELECT 1 FROM direct_executions WHERE change_id=?")
        .get(changeId)
    )
      throw new AppError(
        409,
        "Этот план уже передавался на исполнение. Сначала сверьте его состояние.",
        "direct_execution_exists",
      );
    if (
      db
        .prepare(
          "SELECT 1 FROM direct_executions WHERE business_id=? AND status IN ('running','needs_reconciliation')",
        )
        .get(business.id)
    )
      throw new AppError(
        409,
        "У бизнеса уже есть незавершенное исполнение Директа.",
        "direct_execution_active",
      );
    const at = new Date(now).toISOString();
    db.prepare(
      `INSERT INTO direct_executions(change_id,business_id,connection_id,plan_fingerprint,status,
      inflight_key,suspend_verified,calls_json,started_at,updated_at)
      VALUES(?,?,?,?,'running',NULL,0,'[]',?,?)`,
    ).run(changeId, business.id, connectionId, hash(change.plan), at, at);
    db.prepare(
      "UPDATE direct_approvals SET consumed_at=? WHERE change_id=? AND consumed_at IS NULL",
    ).run(at, changeId);
    event(db, business.id, {
      kind: "direct_execution_started",
      title: "Открыт одноразовый журнал исполнения",
      reason: "Каждый внешний шаг требует отдельной контрольной точки.",
      rule: "direct/execution@1",
      jobId: changeId,
    });
    return directExecution(db, userId, business.id, changeId);
  });
}

export function recordDirectExecutionCheckpoint(
  db,
  userId,
  businessId,
  changeId,
  checkpoint,
  now = Date.now(),
) {
  return transaction(db, () => {
    const current = directExecution(db, userId, businessId, changeId);
    if (current.status !== "running")
      throw new AppError(409, "Исполнение остановлено до сверки.");
    const expected = keys[current.calls.length];
    const { phase, key, ids, holdState } = checkpoint || {};
    if (phase === "before") {
      if (key !== expected || current.inflightKey)
        throw new AppError(409, "Нарушен порядок команд Директа.");
      if (key === "adgroup" && !current.suspendVerified)
        throw new AppError(409, "Остановка кампании не подтверждена.");
      db.prepare(
        "UPDATE direct_executions SET inflight_key=?,updated_at=? WHERE change_id=?",
      ).run(key, new Date(now).toISOString(), changeId);
    } else if (phase === "acknowledged") {
      const change = db
        .prepare("SELECT commands_json FROM direct_changes WHERE id=?")
        .get(changeId);
      const command = JSON.parse(change.commands_json)[current.calls.length];
      const expectedCount =
        key === "suspend"
          ? 1
          : (
              command.params.Campaigns ||
              command.params.AdGroups ||
              command.params.Keywords ||
              command.params.Ads
            )?.length;
      if (
        key !== expected ||
        current.inflightKey !== key ||
        !Array.isArray(ids) ||
        ids.length !== expectedCount ||
        new Set(ids).size !== ids.length ||
        ids.some(
          (id) =>
            !(Number.isSafeInteger(id) && id > 0) &&
            !(typeof id === "string" && /^[1-9]\d*$/.test(id)),
        ) ||
        (key === "suspend" &&
          (ids[0] !== current.calls[0].ids[0] ||
            (holdState && !["SUSPENDED", "OFF_DRAFT"].includes(holdState))))
      )
        throw new AppError(409, "Некорректное подтверждение команды Директа.");
      db.prepare(
        "UPDATE direct_executions SET inflight_key=NULL,calls_json=?,updated_at=? WHERE change_id=?",
      ).run(
        JSON.stringify([
          ...current.calls,
          {
            key,
            ids,
            ...(key === "suspend"
              ? { holdState: holdState || "SUSPENDED" }
              : {}),
          },
        ]),
        new Date(now).toISOString(),
        changeId,
      );
    } else if (phase === "suspend_verified") {
      if (
        key !== "suspend" ||
        current.inflightKey ||
        current.calls.length !== 2 ||
        current.calls[1].key !== "suspend"
      )
        throw new AppError(409, "Нет подтвержденной остановки кампании.");
      db.prepare(
        "UPDATE direct_executions SET suspend_verified=1,updated_at=? WHERE change_id=?",
      ).run(new Date(now).toISOString(), changeId);
    } else throw new AppError(400, "Неизвестная контрольная точка.");
    return directExecution(db, userId, businessId, changeId);
  });
}

// A failed or interrupted write is never retried automatically.
export function stopDirectExecution(
  db,
  userId,
  businessId,
  changeId,
  errorCode = "unknown_result",
  now = Date.now(),
) {
  return transaction(db, () => {
    const current = directExecution(db, userId, businessId, changeId);
    if (current.status !== "running") return current;
    const code = /^[a-z_]{1,64}$/.test(errorCode)
      ? errorCode
      : "unknown_result";
    db.prepare(
      "UPDATE direct_executions SET status='needs_reconciliation',error_code=?,updated_at=? WHERE change_id=?",
    ).run(code, new Date(now).toISOString(), changeId);
    event(db, businessId, {
      kind: "direct_execution_needs_reconciliation",
      title: "Исполнение остановлено для сверки",
      reason:
        "Автоматический повтор запрещен; внешнее состояние требуется проверить.",
      rule: "direct/execution@1",
      jobId: changeId,
    });
    return directExecution(db, userId, businessId, changeId);
  });
}

// One SQLite-backed server owns this queue. A restart must never replay a write.
export function markInterruptedDirectExecutions(db, now = Date.now()) {
  return transaction(db, () => {
    const interrupted = db
      .prepare(
        "SELECT change_id,business_id FROM direct_executions WHERE status='running'",
      )
      .all();
    const at = new Date(now).toISOString();
    for (const item of interrupted) {
      db.prepare(
        "UPDATE direct_executions SET status='needs_reconciliation',error_code='process_interrupted',updated_at=? WHERE change_id=?",
      ).run(at, item.change_id);
      event(db, item.business_id, {
        kind: "direct_execution_needs_reconciliation",
        title: "Исполнение прервано перезапуском",
        reason:
          "Автоматический повтор запрещен; внешнее состояние требуется проверить.",
        rule: "direct/execution@1",
        jobId: item.change_id,
      });
    }
    return interrupted.length;
  });
}

// Reads only IDs already acknowledged in the journal. An uncertain add result
// must stay blocked: a campaign name is not a safe substitute for its ID.
export async function inspectDirectExecution(
  db,
  userId,
  businessId,
  changeId,
  client,
  connectionId,
  now = Date.now(),
) {
  const current = directExecution(db, userId, businessId, changeId);
  const stored = db
    .prepare("SELECT connection_id FROM direct_executions WHERE change_id=?")
    .get(changeId);
  if (stored.connection_id !== connectionId)
    throw new AppError(
      409,
      "Кабинет изменился. Сверка с новым подключением запрещена.",
    );
  if (current.status !== "needs_reconciliation")
    throw new AppError(409, "Для этого исполнения сверка не требуется.");
  const ids = Object.fromEntries(
    current.calls.map((item) => [item.key, item.ids]),
  );
  const campaignId = ids.campaign?.[0];
  const adGroupId = ids.adgroup?.[0];
  const [campaigns, groups, keywords, ads] = await Promise.all([
    campaignId ? client.campaignsByIds([campaignId]) : null,
    adGroupId ? client.adGroupsByIds([adGroupId]) : null,
    ids.keywords?.length ? client.keywordsByIds(ids.keywords) : null,
    ids.ads?.length ? client.adsByIds(ids.ads) : null,
  ]);
  const objects = {
    campaign: campaigns?.Campaigns || [],
    adGroups: groups?.AdGroups || [],
    keywords: keywords?.Keywords || [],
    ads: ads?.Ads || [],
  };
  const matched =
    (!campaignId ||
      objects.campaign.some(
        (item) => item.Id === campaignId && heldCampaign(item),
      )) &&
    (!adGroupId ||
      objects.adGroups.some(
        (item) => item.Id === adGroupId && item.CampaignId === campaignId,
      )) &&
    (!ids.keywords ||
      ids.keywords.every((id) =>
        objects.keywords.some(
          (item) => item.Id === id && item.AdGroupId === adGroupId,
        ),
      )) &&
    (!ids.ads ||
      ids.ads.every((id) =>
        objects.ads.some(
          (item) => item.Id === id && item.AdGroupId === adGroupId,
        ),
      ));
  const complete =
    current.calls.length === keys.length &&
    !current.inflightKey &&
    current.suspendVerified;
  const reconciliation = {
    status: !matched ? "mismatch" : complete ? "matched" : "incomplete",
    matched: !!matched && complete,
    checkedAt: new Date(now).toISOString(),
    readCalls: [
      campaignId,
      adGroupId,
      ids.keywords?.length,
      ids.ads?.length,
    ].filter(Boolean).length,
    objects,
    unresolvedStep: current.inflightKey,
  };
  return transaction(db, () => {
    const latest = directExecution(db, userId, businessId, changeId);
    if (
      latest.status !== "needs_reconciliation" ||
      latest.updatedAt !== current.updatedAt ||
      JSON.stringify(latest.reconciliation) !==
        JSON.stringify(current.reconciliation)
    )
      throw new AppError(409, "Исполнение изменилось во время сверки.");
    db.prepare(
      "UPDATE direct_executions SET status=?,reconciliation_json=?,updated_at=? WHERE change_id=?",
    ).run(
      complete && matched ? "succeeded" : "needs_reconciliation",
      JSON.stringify(reconciliation),
      reconciliation.checkedAt,
      changeId,
    );
    event(db, businessId, {
      kind:
        complete && matched
          ? "direct_execution_verified"
          : "direct_execution_inspected",
      title:
        complete && matched
          ? "Внешние объекты сверены"
          : "Проверены известные внешние ID",
      reason:
        complete && matched
          ? "Кампания не показывается, все созданные объекты найдены."
          : "Неопределенный шаг остается заблокированным; автоматического повтора нет.",
      rule: "direct/execution@1",
      jobId: changeId,
    });
    return directExecution(db, userId, businessId, changeId);
  });
}

export function finishDirectExecution(
  db,
  userId,
  businessId,
  changeId,
  reconciliation,
  now = Date.now(),
) {
  return transaction(db, () => {
    const current = directExecution(db, userId, businessId, changeId);
    if (
      current.status !== "running" ||
      current.inflightKey ||
      !current.suspendVerified ||
      current.calls.length !== keys.length ||
      current.calls.some((call, index) => call.key !== keys[index]) ||
      reconciliation?.status !== "matched" ||
      reconciliation.matched !== true ||
      !reconciliation.objects?.campaign?.some(
        (item) => item.Id === current.calls[0].ids[0] && heldCampaign(item),
      ) ||
      !reconciliation.objects?.adGroups?.some(
        (item) =>
          item.Id === current.calls[2].ids[0] &&
          item.CampaignId === current.calls[0].ids[0],
      ) ||
      !current.calls[3].ids.every((id) =>
        reconciliation.objects?.keywords?.some(
          (item) =>
            item.Id === id && item.AdGroupId === current.calls[2].ids[0],
        ),
      ) ||
      !current.calls[4].ids.every((id) =>
        reconciliation.objects?.ads?.some(
          (item) =>
            item.Id === id && item.AdGroupId === current.calls[2].ids[0],
        ),
      )
    )
      throw new AppError(409, "Полная сверка Директа не подтверждена.");
    db.prepare(
      "UPDATE direct_executions SET status='succeeded',reconciliation_json=?,updated_at=? WHERE change_id=?",
    ).run(
      JSON.stringify(reconciliation),
      new Date(now).toISOString(),
      changeId,
    );
    event(db, businessId, {
      kind: "direct_execution_verified",
      title: "Внешние объекты сверены",
      reason: "Все ID сохранены; кампания не показывается.",
      rule: "direct/execution@1",
      jobId: changeId,
    });
    return directExecution(db, userId, businessId, changeId);
  });
}

// Not wired to HTTP or the background worker. Tests inject a fake Direct client.
export async function runApprovedDirectExecution(
  db,
  userId,
  businessId,
  changeId,
  client,
  { enabled = false, now = Date.now() } = {},
) {
  beginDirectExecution(db, userId, businessId, changeId, { enabled, now });
  const { change } = directChangeForPreflight(db, userId, businessId, changeId);
  try {
    const result = await executeDirectCommands(client, change.commands, {
      checkpoint: (item) =>
        recordDirectExecutionCheckpoint(db, userId, businessId, changeId, item),
    });
    const reconciliation = await reconcileDirectObjects(client, result.calls);
    return finishDirectExecution(
      db,
      userId,
      businessId,
      changeId,
      reconciliation,
    );
  } catch (error) {
    stopDirectExecution(
      db,
      userId,
      businessId,
      changeId,
      error?.code || "unknown_result",
    );
    throw error;
  }
}

// Recover a known OFF draft. A rejected group request may be corrected only
// after the caller identifies a definite 8000 schema error and reads no groups.
export async function continueVerifiedDraftExecution(
  db,
  userId,
  businessId,
  changeId,
  client,
  connectionId,
  { enabled = false, now = Date.now(), rejectedAddCode = null } = {},
) {
  if (!enabled)
    throw new AppError(409, "Реальная запись в Директ отключена.", "live_gate");
  const current = directExecution(db, userId, businessId, changeId);
  const { change } = directChangeForPreflight(db, userId, businessId, changeId);
  const stored = db
    .prepare("SELECT connection_id FROM direct_executions WHERE change_id=?")
    .get(changeId);
  const campaignId = current.calls[0]?.ids?.[0];
  const recoveringSuspend =
    current.inflightKey === "suspend" && current.calls.length === 1;
  const recoveringGroup =
    current.inflightKey === "adgroup" &&
    current.calls.length === 2 &&
    current.calls[1].key === "suspend" &&
    current.calls[1].holdState === "OFF_DRAFT" &&
    current.suspendVerified &&
    rejectedAddCode === 8000;
  if (
    current.status !== "needs_reconciliation" ||
    (!recoveringSuspend && !recoveringGroup) ||
    current.calls[0].key !== "campaign" ||
    !Number.isSafeInteger(campaignId) ||
    stored.connection_id !== connectionId ||
    change.plan.periodStart <= moscowDate(now)
  )
    throw new AppError(409, "Продолжение черновика недоступно.");
  const [budget, groups] = await Promise.all([
    client.campaignBudgetById(campaignId),
    client.adGroupsByCampaignId(campaignId),
  ]);
  const remote = budget.Campaigns?.[0];
  const strategy =
    remote?.UnifiedCampaign?.BiddingStrategy ||
    remote?.TextCampaign?.BiddingStrategy;
  const period = strategy?.Search?.WbMaximumClicks?.CustomPeriodBudget;
  const counters =
    remote?.UnifiedCampaign?.CounterIds?.Items ||
    remote?.TextCampaign?.CounterIds?.Items ||
    [];
  if (
    budget.Campaigns?.length !== 1 ||
    remote.Id !== campaignId ||
    remote.Name !== change.plan.campaignName ||
    remote.State !== "OFF" ||
    remote.Status !== "DRAFT" ||
    !["TEXT_CAMPAIGN", "UNIFIED_CAMPAIGN"].includes(remote.Type) ||
    remote.Currency !== "RUB" ||
    remote.StartDate !== change.plan.periodStart ||
    remote.EndDate !== change.plan.periodEnd ||
    strategy?.Search?.BiddingStrategyType !== "WB_MAXIMUM_CLICKS" ||
    strategy?.Network?.BiddingStrategyType !== "SERVING_OFF" ||
    period?.SpendLimit !== change.plan.budget * 10_000 ||
    period?.StartDate !== change.plan.periodStart ||
    period?.EndDate !== change.plan.periodEnd ||
    period?.AutoContinue !== "NO" ||
    !counters.includes(Number(change.plan.counterId)) ||
    !Array.isArray(groups.AdGroups) ||
    groups.AdGroups.length !== 0 ||
    groups.LimitedBy != null
  )
    throw new AppError(
      409,
      "Черновик, бюджет или группы не совпадают с утверждённым планом.",
      "draft_reconciliation",
    );
  transaction(db, () => {
    const latest = directExecution(db, userId, businessId, changeId);
    const connection = db
      .prepare(
        "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
      )
      .get(businessId);
    if (
      latest.status !== current.status ||
      latest.updatedAt !== current.updatedAt ||
      latest.inflightKey !== current.inflightKey ||
      JSON.stringify(latest.calls) !== JSON.stringify(current.calls) ||
      JSON.parse(connection?.metadata || "null")?.connectionId !== connectionId
    )
      throw new AppError(409, "Исполнение или подключение изменилось.");
    db.prepare(
      "UPDATE direct_executions SET status='running',inflight_key=?,error_code=NULL,updated_at=? WHERE change_id=?",
    ).run(
      recoveringGroup ? null : "suspend",
      new Date(now).toISOString(),
      changeId,
    );
    event(db, businessId, {
      kind: "direct_draft_reconciled",
      title: "Выключенный черновик проверен",
      reason: recoveringGroup
        ? "После ошибки схемы 8000 группы отсутствуют; повторяется только исправленный adgroups.add."
        : "Кампания и лимит совпадают с планом; повторного campaigns.add не будет.",
      rule: "direct/execution@1",
      jobId: changeId,
    });
  });
  try {
    if (recoveringSuspend) {
      recordDirectExecutionCheckpoint(db, userId, businessId, changeId, {
        phase: "acknowledged",
        key: "suspend",
        ids: [campaignId],
        holdState: "OFF_DRAFT",
      });
      recordDirectExecutionCheckpoint(db, userId, businessId, changeId, {
        phase: "suspend_verified",
        key: "suspend",
      });
    }
    const initialCalls = directExecution(
      db,
      userId,
      businessId,
      changeId,
    ).calls;
    const result = await executeDirectCommands(client, change.commands, {
      initialCalls,
      initialResults: {
        campaign: { Id: campaignId },
        suspend: { Id: campaignId },
        campaignType: remote.Type,
      },
      checkpoint: (item) =>
        recordDirectExecutionCheckpoint(db, userId, businessId, changeId, item),
    });
    const reconciliation = await reconcileDirectObjects(client, result.calls);
    return finishDirectExecution(
      db,
      userId,
      businessId,
      changeId,
      reconciliation,
    );
  } catch (error) {
    stopDirectExecution(
      db,
      userId,
      businessId,
      changeId,
      error?.code || "unknown_result",
    );
    throw error;
  }
}

// Recovers partial keywords or a rejected ad by reading the entire group.
// Previously attempted object types are never replayed without read-back.
export async function continueVerifiedKeywordsExecution(
  db,
  userId,
  businessId,
  changeId,
  client,
  connectionId,
  { enabled = false, now = Date.now(), rejectedAddCode = null } = {},
) {
  if (!enabled)
    throw new AppError(409, "Реальная запись в Директ отключена.", "live_gate");
  const current = directExecution(db, userId, businessId, changeId);
  const { change } = directChangeForPreflight(db, userId, businessId, changeId);
  const stored = db
    .prepare("SELECT connection_id FROM direct_executions WHERE change_id=?")
    .get(changeId);
  const campaignId = current.calls[0]?.ids?.[0];
  const groupId = current.calls[2]?.ids?.[0];
  const recoveringKeywords =
    current.inflightKey === "keywords" && current.calls.length === 3;
  const recoveringAd =
    current.inflightKey === "ads" &&
    current.calls.length === 4 &&
    current.calls[3]?.key === "keywords";
  if (
    current.status !== "needs_reconciliation" ||
    (!recoveringKeywords && !recoveringAd) ||
    !current.suspendVerified ||
    current.calls[0]?.key !== "campaign" ||
    current.calls[1]?.key !== "suspend" ||
    current.calls[1]?.holdState !== "OFF_DRAFT" ||
    current.calls[2]?.key !== "adgroup" ||
    change.plan.ads.length !== 1 ||
    !Number.isSafeInteger(campaignId) ||
    !Number.isSafeInteger(groupId) ||
    stored.connection_id !== connectionId ||
    change.plan.periodStart <= moscowDate(now)
  )
    throw new AppError(409, "Продолжение после сверки фраз недоступно.");
  const [budget, groups, keywords, ads] = await Promise.all([
    client.campaignBudgetById(campaignId),
    client.adGroupsByCampaignId(campaignId),
    client.keywordsByAdGroupId(groupId),
    client.adsByAdGroupId(groupId),
  ]);
  const campaign = budget.Campaigns?.[0];
  const strategy = campaign?.UnifiedCampaign?.BiddingStrategy;
  const period = strategy?.Search?.WbMaximumClicks?.CustomPeriodBudget;
  const remoteKeywords = (keywords.Keywords || []).filter(
    (item) => item.Keyword !== "---autotargeting",
  );
  const plannedPhrases = change.plan.keywords.map((item) =>
    item.replaceAll(",", "").replace(/\s+/g, " ").trim(),
  );
  let mapped = plannedPhrases.map((phrase) =>
    remoteKeywords.find((item) => item.Keyword === phrase),
  );
  const missingIndexes = mapped
    .map((item, index) => (item ? -1 : index))
    .filter((index) => index >= 0);
  const repairAlreadyAttempted =
    current.reconciliation?.keywordRepair?.attempted === true;
  const repairMissingKeywords =
    recoveringKeywords &&
    missingIndexes.length > 0 &&
    rejectedAddCode === 5002 &&
    !repairAlreadyAttempted;
  const remotePhrases = new Set(remoteKeywords.map((item) => item.Keyword));
  const existingAd =
    recoveringAd && change.plan.ads.length === 1 ? ads.Ads?.[0] : null;
  const adPlan = change.plan.ads[0];
  const matchingAd =
    !!existingAd &&
    ads.Ads.length === 1 &&
    existingAd.AdGroupId === groupId &&
    existingAd.State === "OFF" &&
    existingAd.Status === "DRAFT" &&
    existingAd.Type === "RESPONSIVE_AD" &&
    ((Number.isSafeInteger(existingAd.Id) && existingAd.Id > 0) ||
      (typeof existingAd.Id === "string" &&
        /^[1-9]\d*$/.test(existingAd.Id))) &&
    existingAd.ResponsiveAd?.Titles?.length === 1 &&
    existingAd.ResponsiveAd.Titles[0].Title ===
      adPlan.title.replace(/\s*·\s*/g, ", ") &&
    existingAd.ResponsiveAd?.Texts?.length === 1 &&
    existingAd.ResponsiveAd.Texts[0].Text === adPlan.text &&
    existingAd.ResponsiveAd.Href === adPlan.href;
  if (
    budget.Campaigns?.length !== 1 ||
    campaign.Id !== campaignId ||
    campaign.Name !== change.plan.campaignName ||
    !heldCampaign(campaign) ||
    campaign.Type !== "UNIFIED_CAMPAIGN" ||
    campaign.Currency !== "RUB" ||
    campaign.StartDate !== change.plan.periodStart ||
    campaign.EndDate !== change.plan.periodEnd ||
    strategy?.Search?.BiddingStrategyType !== "WB_MAXIMUM_CLICKS" ||
    strategy?.Network?.BiddingStrategyType !== "SERVING_OFF" ||
    period?.SpendLimit !== change.plan.budget * 10_000 ||
    period?.AutoContinue !== "NO" ||
    period?.StartDate !== change.plan.periodStart ||
    period?.EndDate !== change.plan.periodEnd ||
    !campaign.UnifiedCampaign?.CounterIds?.Items?.includes(
      Number(change.plan.counterId),
    ) ||
    groups.AdGroups?.length !== 1 ||
    groups.AdGroups[0].Id !== groupId ||
    groups.AdGroups[0].CampaignId !== campaignId ||
    groups.LimitedBy != null ||
    remoteKeywords.length > plannedPhrases.length ||
    keywords.LimitedBy != null ||
    remoteKeywords.some(
      (item) =>
        !plannedPhrases.includes(item.Keyword) || item.AdGroupId !== groupId,
    ) ||
    remotePhrases.size !== remoteKeywords.length ||
    (missingIndexes.length > 0 && !repairMissingKeywords) ||
    (missingIndexes.length === 0 &&
      (mapped.some((item) => item.AdGroupId !== groupId) ||
        new Set(mapped.map((item) => item.Id)).size !== mapped.length)) ||
    (recoveringAd &&
      JSON.stringify(current.calls[3].ids) !==
        JSON.stringify(mapped.map((item) => item.Id))) ||
    (ads.Ads !== undefined && !Array.isArray(ads.Ads)) ||
    ((ads.Ads || []).length !== 0 && !matchingAd) ||
    (recoveringAd && !matchingAd && rejectedAddCode !== 5002) ||
    ads.LimitedBy != null
  )
    throw new AppError(
      409,
      "Кампания, бюджет, фразы или объявления не совпадают с планом.",
      "keyword_reconciliation",
    );
  transaction(db, () => {
    const latest = directExecution(db, userId, businessId, changeId);
    const connection = db
      .prepare(
        "SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'",
      )
      .get(businessId);
    if (
      latest.status !== current.status ||
      latest.updatedAt !== current.updatedAt ||
      latest.inflightKey !== current.inflightKey ||
      JSON.stringify(latest.calls) !== JSON.stringify(current.calls) ||
      JSON.parse(connection?.metadata || "null")?.connectionId !== connectionId
    )
      throw new AppError(409, "Исполнение или подключение изменилось.");
    const at = new Date(now).toISOString();
    if (repairMissingKeywords)
      db.prepare(
        "UPDATE direct_executions SET status='running',error_code=NULL,reconciliation_json=?,updated_at=? WHERE change_id=?",
      ).run(
        JSON.stringify({
          status: "keyword_repair_sending",
          keywordRepair: {
            attempted: true,
            attemptedAt: at,
            missingCount: missingIndexes.length,
          },
        }),
        at,
        changeId,
      );
    else
      db.prepare(
        "UPDATE direct_executions SET status='running',inflight_key=NULL,calls_json=?,error_code=NULL,updated_at=? WHERE change_id=?",
      ).run(
        JSON.stringify(
          recoveringKeywords
            ? [
                ...current.calls,
                { key: "keywords", ids: mapped.map((item) => item.Id) },
              ]
            : matchingAd
              ? [...current.calls, { key: "ads", ids: [existingAd.Id] }]
              : current.calls,
        ),
        at,
        changeId,
      );
    event(db, businessId, {
      kind: repairMissingKeywords
        ? "direct_keywords_repair_started"
        : "direct_keywords_reconciled",
      title: repairMissingKeywords
        ? "Подготовлено добавление недостающих фраз"
        : matchingAd
          ? "Созданное объявление сверено"
          : "Фразы сверены после частичного ответа",
      reason: repairMissingKeywords
        ? `После полного чтения отсутствуют ${missingIndexes.length} фраз; повторяются только отклоненные элементы без недопустимых знаков.`
        : matchingAd
          ? "Объявление найдено по точному ID и содержанию; повторного ads.add не будет."
          : "Уникальные фразы найдены; повторного keywords.add не будет.",
      rule: "direct/execution@1",
      jobId: changeId,
    });
  });
  try {
    if (repairMissingKeywords) {
      await client.createKeywords(
        missingIndexes.map((index) => ({
          AdGroupId: groupId,
          Keyword: plannedPhrases[index],
        })),
      );
      const repaired = await client.keywordsByAdGroupId(groupId);
      const repairedKeywords = (repaired.Keywords || []).filter(
        (item) => item.Keyword !== "---autotargeting",
      );
      mapped = plannedPhrases.map((phrase) =>
        repairedKeywords.find((item) => item.Keyword === phrase),
      );
      if (
        repaired.LimitedBy != null ||
        repairedKeywords.length !== plannedPhrases.length ||
        mapped.some((item) => !item || item.AdGroupId !== groupId) ||
        new Set(mapped.map((item) => item.Id)).size !== mapped.length
      )
        throw new AppError(
          409,
          "Недостающие фразы не подтверждены после записи.",
          "keyword_repair_unconfirmed",
        );
      recordDirectExecutionCheckpoint(db, userId, businessId, changeId, {
        phase: "acknowledged",
        key: "keywords",
        ids: mapped.map((item) => item.Id),
      });
    }
    const initialCalls = directExecution(
      db,
      userId,
      businessId,
      changeId,
    ).calls;
    if (matchingAd) {
      const reconciliation = await reconcileDirectObjects(client, initialCalls);
      return finishDirectExecution(
        db,
        userId,
        businessId,
        changeId,
        reconciliation,
      );
    }
    const result = await executeDirectCommands(client, change.commands, {
      initialCalls,
      initialResults: {
        campaign: { Id: campaignId },
        suspend: { Id: campaignId },
        adgroup: { Id: groupId },
        keywords: { Id: mapped[0].Id },
        campaignType: campaign.Type,
      },
      checkpoint: (item) =>
        recordDirectExecutionCheckpoint(db, userId, businessId, changeId, item),
    });
    const reconciliation = await reconcileDirectObjects(client, result.calls);
    return finishDirectExecution(
      db,
      userId,
      businessId,
      changeId,
      reconciliation,
    );
  } catch (error) {
    stopDirectExecution(
      db,
      userId,
      businessId,
      changeId,
      error?.code || "unknown_result",
    );
    throw error;
  }
}
