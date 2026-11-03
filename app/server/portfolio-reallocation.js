import { AppError, transaction } from "./db.js";
import { adLifecycle } from "./ad-lifecycle.js";

function campaignIdFromExecution(db, businessId, changeId) {
  const row = db
    .prepare(
      "SELECT calls_json,connection_id FROM direct_executions WHERE business_id=? AND change_id=? AND status='succeeded'",
    )
    .get(businessId, changeId);
  const campaignId = row && JSON.parse(row.calls_json).find((call) => call.key === "campaign")?.ids?.[0];
  if (!row || !Number.isSafeInteger(campaignId))
    throw new AppError(409, "Нельзя подтвердить кампанию для перераспределения.");
  return { campaignId, connectionId: row.connection_id };
}

function planForChange(db, businessId, changeId) {
  const row = db
    .prepare("SELECT plan_json FROM direct_changes WHERE id=? AND business_id=?")
    .get(changeId, businessId);
  if (!row) throw new AppError(409, "План кампании для перераспределения не найден.");
  const plan = JSON.parse(row.plan_json);
  if (!Number.isSafeInteger(plan.budget) || plan.budget <= 0)
    throw new AppError(409, "Исходный лимит кампании некорректен.");
  return plan;
}

function remoteBudget(response, campaignId) {
  const campaign = response?.Campaigns?.length === 1 ? response.Campaigns[0] : null;
  const period = campaign?.TextCampaign?.BiddingStrategy?.Search?.WbMaximumClicks?.CustomPeriodBudget;
  const micros = period?.SpendLimit;
  if (
    !campaign ||
    campaign.Id !== campaignId ||
    campaign.Type !== "TEXT_CAMPAIGN" ||
    campaign.TextCampaign?.BiddingStrategy?.Search?.BiddingStrategyType !== "WB_MAXIMUM_CLICKS" ||
    campaign.TextCampaign?.BiddingStrategy?.Network?.BiddingStrategyType !== "SERVING_OFF" ||
    !Number.isSafeInteger(micros) ||
    micros <= 0 ||
    micros % 10_000 !== 0 ||
    period?.AutoContinue !== "NO"
  )
    throw new AppError(409, "Лимит или стратегия кампании изменились.");
  return {
    limitKopecks: micros / 10_000,
    periodStart: period.StartDate,
    periodEnd: period.EndDate,
    state: campaign.State,
  };
}

async function verifiedBudget(client, entry, plan) {
  const result = remoteBudget(await client.campaignBudgetById(entry.campaignId), entry.campaignId);
  if (
    result.limitKopecks !== entry.previousLimitKopecks ||
    result.periodStart !== plan.periodStart ||
    result.periodEnd !== plan.periodEnd ||
    result.state !== "ON"
  )
    throw new AppError(409, "Кампания изменилась после контрольного среза.");
  return result;
}

async function updateAndRead(client, campaignId, before, requestedLimitKopecks) {
  const result = await client.updateTextCampaignPeriodBudget(campaignId, {
    spendLimitKopecks: requestedLimitKopecks,
    startDate: before.periodStart,
    endDate: before.periodEnd,
  });
  if (
    !Array.isArray(result?.UpdateResults) ||
    result.UpdateResults.length !== 1 ||
    result.UpdateResults[0].Id !== campaignId ||
    result.UpdateResults[0].Errors?.length
  )
    throw new AppError(502, "Директ не подтвердил изменение лимита.");
  const after = remoteBudget(await client.campaignBudgetById(campaignId), campaignId);
  if (
    after.limitKopecks !== requestedLimitKopecks ||
    after.periodStart !== before.periodStart ||
    after.periodEnd !== before.periodEnd ||
    after.state !== "ON"
  )
    throw new AppError(502, "Новый лимит не подтверждён чтением Директа.");
  return after;
}

// All local facts are frozen before a write.  The donor is reduced first: if
// the second write is interrupted, the system can only have lowered spending,
// never exceeded the portfolio budget.  It deliberately never retries a
// partially dispatched transfer.
export async function reallocateVerifiedPortfolio(
  db,
  businessId,
  action,
  client,
  connectionId,
) {
  const guard = JSON.parse(action.guard_json);
  const transfer = guard?.reallocation?.transferKopecks;
  const recipient = guard?.reallocation?.recipient;
  const donor = guard?.reallocation?.donor;
  if (
    guard.totalBudgetIncreaseAllowed !== false ||
    !Number.isSafeInteger(transfer) ||
    transfer <= 0 ||
    !recipient ||
    !donor ||
    recipient.changeId !== action.change_id ||
    recipient.changeId === donor.changeId ||
    !Number.isSafeInteger(recipient.campaignId) ||
    !Number.isSafeInteger(donor.campaignId) ||
    !Number.isSafeInteger(recipient.previousLimitKopecks) ||
    !Number.isSafeInteger(donor.previousLimitKopecks) ||
    !Number.isSafeInteger(donor.spentKopecks) ||
    donor.spentKopecks < 0 ||
    transfer > donor.previousLimitKopecks - donor.spentKopecks
  )
    throw new AppError(409, "План перераспределения неполный или небезопасный.");
  if (
    adLifecycle(db, businessId, recipient.changeId).status !== "active" ||
    adLifecycle(db, businessId, donor.changeId).status !== "active"
  )
    throw new AppError(409, "Одна из кампаний больше не активна.");
  const recipientRef = campaignIdFromExecution(db, businessId, recipient.changeId);
  const donorRef = campaignIdFromExecution(db, businessId, donor.changeId);
  if (
    recipientRef.campaignId !== recipient.campaignId ||
    donorRef.campaignId !== donor.campaignId ||
    recipientRef.connectionId !== recipient.connectionId ||
    donorRef.connectionId !== donor.connectionId ||
    recipientRef.connectionId !== donorRef.connectionId ||
    !connectionId ||
    recipientRef.connectionId !== connectionId
  )
    throw new AppError(409, "Подключение или состав кампаний изменились.");
  const recipientPlan = planForChange(db, businessId, recipient.changeId);
  const donorPlan = planForChange(db, businessId, donor.changeId);
  if (recipientPlan.login !== donorPlan.login)
    throw new AppError(409, "Кампании относятся к разным рекламным кабинетам.");

  let writeAttempted = false;
  try {
    const [recipientBefore, donorBefore] = await Promise.all([
      verifiedBudget(client, recipient, recipientPlan),
      verifiedBudget(client, donor, donorPlan),
    ]);
    const donorLimit = donorBefore.limitKopecks - transfer;
    const recipientLimit = recipientBefore.limitKopecks + transfer;
    if (donorLimit < donor.spentKopecks || recipientLimit <= recipientBefore.limitKopecks)
      throw new AppError(409, "Свободный остаток кампании изменился.");
    writeAttempted = true;
    await updateAndRead(client, donor.campaignId, donorBefore, donorLimit);
    await updateAndRead(client, recipient.campaignId, recipientBefore, recipientLimit);
    transaction(db, () => {
      const at = new Date().toISOString();
      for (const [changeId, limitKopecks] of [
        [donor.changeId, donorLimit],
        [recipient.changeId, recipientLimit],
      ])
        db.prepare(
          `INSERT INTO campaign_budget_allocations(business_id,change_id,limit_kopecks,updated_at)
           VALUES(?,?,?,?)
           ON CONFLICT(business_id,change_id)
           DO UPDATE SET limit_kopecks=excluded.limit_kopecks,updated_at=excluded.updated_at`,
        ).run(businessId, changeId, limitKopecks, at);
    });
    return {
      status: "applied",
      reason: `Перенесено ${transfer} коп. из кампании с более высокой стоимостью обращения; общий лимит портфеля не изменился.`,
    };
  } catch (error) {
    return {
      status: writeAttempted ? "needs_reconciliation" : "failed_no_write",
      reason: writeAttempted
        ? "Перераспределение могло быть применено частично. Автоматический повтор запрещён до сверки лимитов в Direct."
        : "Проверка лимитов перед перераспределением не пройдена; внешние команды не отправлялись.",
      error,
    };
  }
}
