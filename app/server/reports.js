import { randomUUID, createHash } from "node:crypto";
import { AppError, requireBusiness, transaction, event } from "./db.js";
import { decrypt } from "./security.js";
import {
  DirectClient,
  MetricaClient,
  parseReport,
  ProviderError,
} from "./providers.js";
import { withYandexConnection } from "./oauth.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const LEASE = 60000,
  MAX_POLLS = 30;
const sum = (rows, key) => {
  const value = rows.reduce((n, r) => n + r[key], 0);
  if (!Number.isSafeInteger(value))
    throw new ProviderError("Итог отчета слишком велик.");
  return value;
};
export const reportTotals = (rows) => ({
  spent: sum(rows, "spent"),
  clicks: sum(rows, "clicks"),
  impressions: sum(rows, "impressions"),
  conversions: sum(rows, "conversions"),
  rowCount: rows.length,
});

function metricaSummary(raw, state, dateFrom, dateTo) {
  const totals = raw?.totals;
  if (
    !Array.isArray(totals) ||
    totals.length < 2 ||
    totals
      .slice(0, 2)
      .some(
        (value) => !Number.isSafeInteger(Number(value)) || Number(value) < 0,
  )
  )
    throw new ProviderError(
      "Метрика вернула некорректные итоговые показатели.",
    );
  return {
    status: "ready",
    counterId: String(state.counterId),
    goalId: String(state.goalId),
    dateFrom,
    dateTo,
    visits: Number(totals[0]),
    goalReaches: Number(totals[1]),
    sampled: raw.sampled === true,
  };
}

export function compareReports(previous, current) {
  if (!previous)
    return {
      status: "first",
      deltaSpent: 0,
      changedRows: 0,
      missingRows: 0,
      addedRows: 0,
      conservativeSpent: reportTotals(current).spent,
    };
  const key = (r) => r.Date + ":" + r.CampaignId + (r.AdId ? `:${r.AdId}` : ""),
    old = new Map(previous.map((r) => [key(r), r])),
    next = new Map(current.map((r) => [key(r), r]));
  let changedRows = 0,
    missingRows = 0,
    addedRows = 0,
    conservativeSpent = 0;
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(id),
      b = next.get(id);
    if (!a) addedRows++;
    else if (!b) missingRows++;
    else if (
      a.spent !== b.spent ||
      a.clicks !== b.clicks ||
      a.impressions !== b.impressions ||
      a.conversions !== b.conversions
    )
      changedRows++;
    conservativeSpent += Math.max(a?.spent || 0, b?.spent || 0);
  }
  if (!Number.isSafeInteger(conservativeSpent))
    throw new ProviderError("Итог сверки слишком велик.");
  return {
    status: changedRows || missingRows || addedRows ? "changed" : "unchanged",
    deltaSpent: reportTotals(current).spent - reportTotals(previous).spent,
    changedRows,
    missingRows,
    addedRows,
    conservativeSpent,
  };
}

function connection(db, businessId, login) {
  const row = db
    .prepare(
      "SELECT * FROM connections WHERE business_id=? AND provider='yandex'",
    )
    .get(businessId);
  if (!row) throw new AppError(409, "Сначала подключите Яндекс.");
  const metadata = JSON.parse(row.metadata),
    account = metadata.clients.find((c) => c.Login === login);
  if (!account)
    throw new AppError(403, "Кабинет не принадлежит этому подключению.");
  if (account.Currency !== "RUB")
    throw new AppError(
      409,
      "Сохранение отчетов пока поддерживает только кабинет в RUB. Валюта не определена или отличается.",
    );
  return {
    row,
    metadata,
    signature: metadata.connectionId
      ? digest(metadata.connectionId)
      : digest(row.encrypted + row.metadata),
  };
}
function today(timezone, now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}
function demoTsv(state, date, revised) {
  const rows = state.campaigns.map((c, i) =>
    [
      date,
      String(i + 1),
      c.name.replace(/[\t\r\n]/g, " "),
      c.impressions,
      c.clicks,
      ((c.spent + (revised && i === 0 ? 12500 : 0)) / 100).toFixed(2),
    ].join("\t"),
  );
  return (
    ["Date\tCampaignId\tCampaignName\tImpressions\tClicks\tCost", ...rows].join(
      "\n",
    ) + "\n"
  );
}

export function enqueueReport(
  db,
  userId,
  businessId,
  key,
  {
    login = "",
    scenario = "normal",
    reportType = "campaign",
    adIds = [],
    abPlanId = null,
  } = {},
  now = Date.now(),
) {
  return transaction(db, () => {
    const b = requireBusiness(db, userId, businessId),
      fingerprint = digest(
        JSON.stringify({
          action: "report_sync",
          login,
          scenario,
          reportType,
          adIds,
          abPlanId,
        }),
      );
    const prior = db
      .prepare("SELECT * FROM commands WHERE business_id=? AND key=?")
      .get(b.id, key);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new AppError(409, "Ключ уже использован другой операцией.");
      return JSON.parse(prior.response);
    }
    if (
      db
        .prepare(
          "SELECT id FROM jobs WHERE business_id=? AND kind='report_sync' AND status IN ('pending','running')",
        )
        .get(b.id)
    )
      throw new AppError(
        409,
        "Отчет уже ожидает выполнения. Обновите статус позже.",
      );
    const dateFrom = b.state.periodStart,
      dateTo = [b.state.periodEnd, today(b.state.timezone, now)].sort()[0];
    if (dateFrom > dateTo) throw new AppError(409, "Период еще не начался.");
    if (!["campaign", "ad"].includes(reportType))
      throw new AppError(400, "Некорректный тип отчёта.");
    if (
      reportType === "ad" &&
      (!Array.isArray(adIds) ||
        adIds.length !== 2 ||
        new Set(adIds.map(String)).size !== 2 ||
        adIds.some((id) => !/^[1-9]\d*$/.test(String(id))))
    )
      throw new AppError(400, "Для A/B-отчёта нужны два объявления.");
    let source,
      signature = null,
      rawTsv = null;
    if (b.state.mode === "demo") {
      if (reportType !== "campaign")
        throw new AppError(400, "A/B-отчёт доступен только для Директа.");
      if (!b.state.campaigns.length)
        throw new AppError(409, "Сначала создайте тестовый план.");
      if (login)
        throw new AppError(400, "В демо нельзя указать настоящий логин.");
      source = "demo";
      login = "demo";
      rawTsv = demoTsv(b.state, dateFrom, scenario === "revised");
    } else {
      if (scenario !== "normal")
        throw new AppError(
          400,
          "Тестовые сценарии недоступны для настоящего кабинета.",
        );
      const c = connection(db, b.id, login);
      source = c.metadata.sandbox ? "yandex-sandbox" : "yandex";
      signature = c.signature;
    }
    const id = randomUUID(),
      payload = {
        source,
        login,
        dateFrom,
        dateTo,
        signature,
        rawTsv,
        scenario,
        reportType,
        adIds: adIds.map(String),
        abPlanId,
        failures: 0,
      };
    db.prepare(
      "INSERT INTO jobs(id,business_id,kind,status,available_at,payload) VALUES(?,?,'report_sync','pending',?,?)",
    ).run(id, b.id, now, JSON.stringify(payload));
    const response = {
      ok: true,
      jobId: id,
      message: "Отчет поставлен в очередь. Реклама не изменяется.",
    };
    db.prepare("INSERT INTO commands VALUES(?,?,?,?)").run(
      b.id,
      key,
      fingerprint,
      JSON.stringify(response),
    );
    return response;
  });
}

export function enqueueAbReport(
  db,
  userId,
  businessId,
  key,
  planId,
  now = Date.now(),
) {
  requireBusiness(db, userId, businessId);
  const row = db
    .prepare(
      `SELECT p.plan_json AS ab_plan,c.plan_json AS direct_plan
       FROM direct_ab_plans p JOIN direct_changes c ON c.id=p.change_id
       WHERE p.id=? AND p.business_id=?`,
    )
    .get(planId, businessId);
  if (!row) throw new AppError(404, "A/B-план не найден.");
  const abPlan = JSON.parse(row.ab_plan),
    directPlan = JSON.parse(row.direct_plan),
    adIds = [abPlan.control?.adId, abPlan.variant?.adId].map(String);
  if (adIds.some((id) => !/^[1-9]\d*$/.test(id)))
    throw new AppError(409, "Сначала создайте и сверьте вариант Б.");
  return enqueueReport(
    db,
    userId,
    businessId,
    key,
    {
      login: directPlan.login,
      scenario: "normal",
      reportType: "ad",
      adIds,
      abPlanId: planId,
    },
    now,
  );
}

function context(db, job, p) {
  const row = db
      .prepare("SELECT * FROM businesses WHERE id=?")
      .get(job.business_id),
    state = JSON.parse(row.state);
  if (
    state.periodStart !== p.dateFrom ||
    state.periodEnd < p.dateTo ||
    (state.mode === "demo") !== (p.source === "demo")
  )
    throw new AppError(
      409,
      "Период или режим бизнеса изменен. Запросите новый отчет.",
    );
  if (p.source === "demo") return null;
  if ((p.reportType || "campaign") === "ad") {
    const planRow = db
      .prepare(
        "SELECT plan_json FROM direct_ab_plans WHERE id=? AND business_id=?",
      )
      .get(p.abPlanId, job.business_id);
    if (!planRow)
      throw new AppError(409, "A/B-план изменён. Запросите новый отчёт.");
    const plan = JSON.parse(planRow.plan_json),
      currentIds = [plan.control?.adId, plan.variant?.adId].map(String);
    if (JSON.stringify(currentIds) !== JSON.stringify(p.adIds || []))
      throw new AppError(409, "Состав A/B-вариантов изменён.");
  }
  const c = connection(db, job.business_id, p.login);
  if (c.signature !== p.signature)
    throw new AppError(409, "Подключение изменилось. Запросите новый отчет.");
  return c;
}

export async function runReportCycle(
  db,
  {
    now = Date.now(),
    key,
    config,
    refreshToken,
    clientFactory = (options) => new DirectClient(options),
    metricaFactory = (accessToken) => new MetricaClient(accessToken),
  } = {},
) {
  const job = transaction(db, () => {
    for (const abandoned of db
      .prepare(
        "SELECT id,business_id FROM jobs WHERE kind='report_sync' AND status='running' AND attempts>=? AND available_at<=?",
      )
      .all(MAX_POLLS, now))
      event(db, abandoned.business_id, {
        kind: "report_error",
        title: "Получение отчета прервано",
        reason:
          "Достигнут предел попыток восстановления. Предыдущие снимки сохранены.",
        rule: "report-sync/1",
        jobId: abandoned.id,
      });
    db.prepare(
      "UPDATE jobs SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'pending' END,error='Обработка прервана; срок аренды истек.' WHERE kind='report_sync' AND status='running' AND available_at<=?",
    ).run(MAX_POLLS, now);
    const j = db
      .prepare(
        "SELECT * FROM jobs WHERE kind='report_sync' AND status='pending' AND available_at<=? ORDER BY available_at,rowid LIMIT 1",
      )
      .get(now);
    if (!j) return null;
    db.prepare(
      "UPDATE jobs SET status='running',attempts=attempts+1,available_at=? WHERE id=?",
    ).run(now + LEASE, j.id);
    return { ...j, attempts: j.attempts + 1 };
  });
  if (!job) return { status: "idle" };
  const p = JSON.parse(job.payload),
    owns = () =>
      db
        .prepare(
          "SELECT id FROM jobs WHERE id=? AND status='running' AND attempts=?",
        )
        .get(job.id, job.attempts);
  try {
    const c = context(db, job, p);
    let result;
    if (p.source === "demo")
      result =
        p.scenario === "pending" && job.attempts === 1
          ? { pending: true, retryAfter: 5 }
          : { pending: false, rawTsv: p.rawTsv, includeVat: true };
    else {
      const state = JSON.parse(
        db
          .prepare("SELECT state FROM businesses WHERE id=?")
          .get(job.business_id).state,
      );
      const readReport = async ({ credentials, metadata }) => {
        const direct = await clientFactory({
          accessToken: credentials.access_token,
          login: p.login,
          sandbox: metadata.sandbox,
        }).report(p.dateFrom, p.dateTo, {
          reportType: p.reportType || "campaign",
          adIds: p.adIds || [],
        });
        if (direct.pending || (p.reportType || "campaign") !== "campaign")
          return direct;
        if (
          !/^\d+$/.test(String(state.counterId)) ||
          !/^\d+$/.test(String(state.goalId))
        )
          return { ...direct, metrica: null };
        try {
          const raw = await metricaFactory(credentials.access_token).statistics(
            state.counterId,
            state.goalId,
            p.dateFrom,
            p.dateTo,
          );
          return {
            ...direct,
            metrica: metricaSummary(raw, state, p.dateFrom, p.dateTo),
          };
        } catch {
          return {
            ...direct,
            metrica: {
              status: "unavailable",
              counterId: String(state.counterId),
              goalId: String(state.goalId),
              dateFrom: p.dateFrom,
              dateTo: p.dateTo,
            },
          };
        }
      };
      result = config
        ? await withYandexConnection(
            {
              db,
              config,
              key,
              businessId: job.business_id,
              refreshToken,
              now,
            },
            readReport,
          )
        : await readReport({
            credentials: decrypt(
              c.row.encrypted,
              key,
              job.business_id + ":yandex",
            ),
            metadata: c.metadata,
          });
    }
    if (!owns()) return { status: "lease_lost" };
    if (result.pending) {
      const delay = Number(result.retryAfter);
      if (!Number.isFinite(delay) || delay < 1 || delay > 86400)
        throw new ProviderError("Некорректное время ожидания отчета.");
      const status = job.attempts >= MAX_POLLS ? "failed" : "pending";
      return transaction(db, () => {
        if (!owns()) return { status: "lease_lost" };
        context(db, job, p);
        db.prepare(
          "UPDATE jobs SET status=?,available_at=?,error=? WHERE id=?",
        ).run(
          status,
          now + Math.ceil(delay) * 1000,
          status === "failed"
            ? "Отчет не готов после 30 проверок. Попробуйте позже."
            : null,
          job.id,
        );
        if (status === "failed")
          event(db, job.business_id, {
            kind: "report_error",
            title: "Отчет пока не готов",
            reason:
              "После 30 проверок ожидание остановлено. Предыдущий снимок не заменен нулями.",
            rule: "report-sync/1",
            jobId: job.id,
          });
        return { status };
      });
    }
    if (
      result.includeVat !== true ||
      typeof result.rawTsv !== "string" ||
      Buffer.byteLength(result.rawTsv) > 2 * 1024 * 1024
    )
      throw new ProviderError("Отчет не соответствует ожидаемому формату.");
    const columns = result.rawTsv.split(/\r?\n/, 1)[0].split("\t"),
      requiredColumns = [
        "Date",
        "CampaignId",
        "CampaignName",
        "Cost",
        "Clicks",
        "Impressions",
        ...((p.reportType || "campaign") === "ad" ? ["AdGroupId", "AdId"] : []),
      ];
    if (requiredColumns.some((name) => !columns.includes(name)))
      throw new ProviderError("В отчете отсутствуют запрошенные столбцы.");
    const rows = parseReport(result.rawTsv);
    if (rows.some((r) => r.Date < p.dateFrom || r.Date > p.dateTo))
      throw new ProviderError("В отчете есть строки вне запрошенного периода.");
    const totals = reportTotals(rows),
      scope = digest(
        JSON.stringify([
          p.source,
          p.login,
          p.dateFrom,
          p.dateTo,
          "RUB",
          true,
          p.reportType || "campaign",
          p.adIds || [],
        ]),
      ),
      rawHash = digest(result.rawTsv);
    return transaction(db, () => {
      if (!owns()) return { status: "lease_lost" };
      context(db, job, p);
      const previous = db
        .prepare(
          "SELECT * FROM report_snapshots WHERE business_id=? AND scope=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(job.business_id, scope);
      const comparison = compareReports(
        previous ? JSON.parse(previous.rows_json) : null,
        rows,
      );
      const metricaJson = result.metrica
        ? JSON.stringify(result.metrica)
        : null;
      let id =
        previous?.raw_hash === rawHash &&
        (previous?.metrica_json || null) === metricaJson
          ? previous.id
          : randomUUID();
      if (id !== previous?.id) {
        db.prepare(
          `INSERT INTO report_snapshots(
            id,business_id,job_id,scope,source,login,date_from,date_to,currency,
            include_vat,received_at,request_id,raw_hash,raw_tsv,rows_json,
            totals_json,previous_id,comparison_json,metrica_json
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          job.business_id,
          job.id,
          scope,
          p.source,
          p.login,
          p.dateFrom,
          p.dateTo,
          "RUB",
          1,
          new Date(now).toISOString(),
          result.requestId || null,
          rawHash,
          result.rawTsv,
          JSON.stringify(rows),
          JSON.stringify(totals),
          previous?.id || null,
          JSON.stringify(comparison),
          metricaJson,
        );
        event(db, job.business_id, {
          kind: "report",
          title:
            p.source === "demo"
              ? "Тестовый отчет сохранен"
              : rows.length
                ? "Отчет Директа сохранен"
                : "Отчет Директа получен — данных пока нет",
          reason: !rows.length
              ? "Яндекс вернул готовый отчет без строк: за выбранный период не было показов и расходов. Это не ошибка получения отчета."
              : comparison.status === "changed"
              ? "Показатели отличаются от предыдущего снимка. Посмотрите сверку. Расходы из двух версий не складываются."
              : "Исходный TSV и нормализованные строки сохранены отдельно от демографика.",
          rule: "report-sync/1",
          jobId: job.id,
          reportId: id,
        });
      }
      db.prepare(
        "UPDATE jobs SET status='succeeded',available_at=?,error=NULL,payload=? WHERE id=?",
      ).run(
        now,
        JSON.stringify({
          ...p,
          rawTsv: null,
          resultSnapshotId: id,
          empty: rows.length === 0,
        }),
        job.id,
      );
      return { status: "succeeded", snapshotId: id, empty: rows.length === 0 };
    });
  } catch (error) {
    return transaction(db, () => {
      if (!owns()) return { status: "lease_lost" };
      p.failures++;
      const retry =
        error instanceof ProviderError &&
        error.retryable &&
        p.failures < 3 &&
        job.attempts < MAX_POLLS;
      const status = retry
        ? "pending"
        : error instanceof AppError && error.status === 409
          ? "cancelled"
          : "failed";
      db.prepare(
        "UPDATE jobs SET status=?,available_at=?,payload=?,error=? WHERE id=?",
      ).run(
        status,
        now + 15000 * 2 ** (p.failures - 1),
        JSON.stringify(p),
        retry
          ? "Площадка недоступна. Назначена повторная попытка."
          : "Отчет не сохранен. Проверьте подключение, период и формат данных, затем запросите заново.",
        job.id,
      );
      if (!retry)
        event(db, job.business_id, {
          kind: "report_error",
          title: "Отчет не сохранен",
          reason:
            "Проверка подключения или данных не пройдена. Предыдущий снимок оставлен без изменений.",
          rule: "report-sync/1",
          jobId: job.id,
        });
      return { status };
    });
  }
}

export function reportView(db, businessId) {
  return db
    .prepare(
      `SELECT rs.*,j.payload AS job_payload
       FROM report_snapshots rs JOIN jobs j ON j.id=rs.job_id
       WHERE rs.business_id=? ORDER BY rs.rowid DESC LIMIT 10`,
    )
    .all(businessId)
    .map((r) => {
      const payload = JSON.parse(r.job_payload);
      return {
        id: r.id,
        empty: payload.empty ?? JSON.parse(r.totals_json).rowCount === 0,
        metrica: r.metrica_json ? JSON.parse(r.metrica_json) : null,
        reportType: payload.reportType || "campaign",
        requestedAdIds: payload.adIds || [],
        abPlanId: payload.abPlanId || null,
        source: r.source,
        login: r.login,
        dateFrom: r.date_from,
        dateTo: r.date_to,
        currency: r.currency,
        includeVat: !!r.include_vat,
        receivedAt: r.received_at,
        rawHash: r.raw_hash,
        previousId: r.previous_id,
        totals: JSON.parse(r.totals_json),
        comparison: JSON.parse(r.comparison_json),
        rows: JSON.parse(r.rows_json).slice(0, 100),
      };
    });
}
export function startReportWorker(db, key, config) {
  let pending = null,
    stopped = false;
  const tick = () => {
    if (stopped || pending) return;
    pending = runReportCycle(db, { key, config })
      .catch(() =>
        console.error(JSON.stringify({ event: "report_worker_error" })),
      )
      .finally(() => (pending = null));
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (pending) await pending;
  };
}
