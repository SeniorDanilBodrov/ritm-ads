import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./db.js";
import { compareReports, reportTotals } from "./reports.js";
import { DirectClient, MetricaClient, parseReport, ProviderError } from "./providers.js";
import { decrypt } from "./security.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function today(timezone, now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

function demoTsv(state, date) {
  const rows = state.campaigns.map((campaign, index) => [
    date,
    String(index + 1),
    campaign.name.replace(/[\t\r\n]/g, " "),
    campaign.impressions,
    campaign.clicks,
    (campaign.spent / 100).toFixed(2),
  ].join("\t"));
  return ["Date\tCampaignId\tCampaignName\tImpressions\tClicks\tCost", ...rows].join("\n") + "\n";
}

function observation(totals, metrica) {
  if (!metrica || metrica.status !== "ready")
    return {
      title: "Расходы получены, обращения пока не подтверждены",
      reason: "Ритм сохранил отчёт Директа, но не может сопоставить его с целью Метрики. Реклама не менялась.",
      status: "needs_analytics",
    };
  if (!metrica.goalReaches)
    return {
      title: "Пока нет подтверждённых обращений",
      reason: `За период расход составил ${Math.round(totals.spent / 100)} ₽. Данных недостаточно для изменения рекламы.`,
      status: "not_enough_data",
    };
  const cpa = Math.round(totals.spent / metrica.goalReaches) / 100;
  return {
    title: `Одно обращение стоит ${cpa.toLocaleString("ru-RU")} ₽`,
    reason: `Подтверждено обращений: ${metrica.goalReaches}. Ритм наблюдает за динамикой и пока ничего не меняет автоматически.`,
    status: "observing",
    cpa,
  };
}

async function business(tx, userId, businessId) {
  const row = await tx.prepare("SELECT * FROM businesses WHERE id=? AND user_id=?").get(businessId, userId);
  if (!row) throw new AppError(404, "Бизнес не найден.", "business_missing");
  return { ...row, state: JSON.parse(row.state) };
}

async function event(tx, businessId, payload) {
  const value = { id: randomUUID(), at: new Date().toISOString(), ...payload };
  await tx.prepare("INSERT INTO events VALUES(?,?,?,?)").run(value.id, businessId, value.at, JSON.stringify(value));
}

export async function enqueuePostgresReport(db, userId, businessId, key, { login = "" } = {}, now = Date.now()) {
  return db.transaction(async (tx) => {
    const current = await business(tx, userId, businessId);
    const fingerprint = digest(JSON.stringify({ action: "report_sync", type: "campaign" }));
    const prior = await tx.prepare("SELECT * FROM commands WHERE business_id=? AND key=?").get(current.id, key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new AppError(409, "Ключ уже использован другой операцией.");
      return JSON.parse(prior.response);
    }
    const active = await tx.prepare("SELECT id FROM jobs WHERE business_id=? AND kind='report_sync' AND status IN ('pending','running')").get(current.id);
    if (active) throw new AppError(409, "Отчёт уже ожидает выполнения. Обновите статус позже.");
    const dateFrom = current.state.periodStart;
    const dateTo = [current.state.periodEnd, today(current.state.timezone, now)].sort()[0];
    if (dateFrom > dateTo) throw new AppError(409, "Период ещё не начался.");
    let payload;
    if (current.state.mode === "demo") {
      payload = { source: "demo", login: "demo", dateFrom, dateTo, rawTsv: demoTsv(current.state, dateFrom), failures: 0 };
    } else {
      const connection = await tx.prepare("SELECT metadata FROM connections WHERE business_id=? AND provider='yandex'").get(current.id);
      if (!connection) throw new AppError(409, "Сначала подключите Яндекс.");
      const metadata = JSON.parse(connection.metadata);
      const clients = metadata.clients || [];
      const account = clients.find((item) => item.Login === login) || (clients.length === 1 ? clients[0] : null);
      if (!account?.Login) throw new AppError(400, "Выберите рекламный кабинет для отчёта.");
      if (account.Currency !== "RUB") throw new AppError(409, "Отчёт пока поддерживает только кабинет в RUB.");
      payload = { source: "yandex", login: account.Login, dateFrom, dateTo, rawTsv: null, failures: 0 };
    }
    const id = randomUUID();
    await tx.prepare("INSERT INTO jobs(id,business_id,kind,status,available_at,payload) VALUES(?,?,'report_sync','pending',?,?)").run(id, current.id, now, JSON.stringify(payload));
    const response = { ok: true, jobId: id, message: "Отчёт поставлен в очередь. Реклама не меняется." };
    await tx.prepare("INSERT INTO commands VALUES(?,?,?,?)").run(current.id, key, fingerprint, JSON.stringify(response));
    return response;
  });
}

export async function runPostgresReportCycle(db, { key, now = Date.now() } = {}) {
  const job = await db.transaction(async (tx) => {
    const value = await tx.prepare("SELECT * FROM jobs WHERE kind='report_sync' AND status='pending' AND available_at<=? ORDER BY available_at,ctid LIMIT 1 FOR UPDATE SKIP LOCKED").get(now);
    if (!value) return null;
    await tx.prepare("UPDATE jobs SET status='running',attempts=attempts+1,available_at=? WHERE id=?").run(now + 60_000, value.id);
    return { ...value, attempts: Number(value.attempts) + 1 };
  });
  if (!job) return { status: "idle" };
  const payload = JSON.parse(job.payload);
  try {
    let rawTsv = payload.rawTsv;
    let metrica = null;
    if (payload.source === "yandex") {
      const connection = await db.prepare("SELECT encrypted,metadata FROM connections WHERE business_id=? AND provider='yandex'").get(job.business_id);
      if (!connection) throw new AppError(409, "Подключение Яндекса удалено.");
      const credentials = decrypt(connection.encrypted, key, `${job.business_id}:yandex`);
      const metadata = JSON.parse(connection.metadata);
      const result = await new DirectClient({ accessToken: credentials.access_token, login: payload.login, sandbox: metadata.sandbox === true }).report(payload.dateFrom, payload.dateTo);
      if (result.pending) {
        const delay = Number(result.retryAfter);
        if (!Number.isFinite(delay) || delay < 1 || delay > 86400) throw new ProviderError("Некорректное время ожидания отчёта.");
        await db.prepare("UPDATE jobs SET status='pending',available_at=?,error=NULL WHERE id=? AND status='running'").run(now + Math.ceil(delay) * 1000, job.id);
        return { status: "pending" };
      }
      if (result.includeVat !== true || typeof result.rawTsv !== "string") throw new ProviderError("Директ вернул отчёт в неожиданном формате.");
      rawTsv = result.rawTsv;
      const owner = await db.prepare("SELECT state FROM businesses WHERE id=?").get(job.business_id);
      const state = owner ? JSON.parse(owner.state) : null;
      if (/^\d+$/.test(String(state?.counterId || "")) && /^\d+$/.test(String(state?.goalId || ""))) {
        try {
          const statistics = await new MetricaClient(credentials.access_token).statistics(state.counterId, state.goalId, payload.dateFrom, payload.dateTo);
          const values = statistics?.totals;
          if (Array.isArray(values) && values.length >= 2 && values.slice(0, 2).every((value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0))
            metrica = { status: "ready", counterId: String(state.counterId), goalId: String(state.goalId), dateFrom: payload.dateFrom, dateTo: payload.dateTo, visits: Number(values[0]), goalReaches: Number(values[1]), sampled: statistics.sampled === true };
          else metrica = { status: "unavailable", counterId: String(state.counterId), goalId: String(state.goalId), dateFrom: payload.dateFrom, dateTo: payload.dateTo };
        } catch {
          metrica = { status: "unavailable", counterId: String(state.counterId), goalId: String(state.goalId), dateFrom: payload.dateFrom, dateTo: payload.dateTo };
        }
      }
    }
    const rows = parseReport(rawTsv);
    const totals = reportTotals(rows);
    const scope = digest(JSON.stringify([payload.source, payload.login, payload.dateFrom, payload.dateTo, "RUB", true]));
    const rawHash = digest(rawTsv);
    return db.transaction(async (tx) => {
      const previous = await tx.prepare("SELECT * FROM report_snapshots WHERE business_id=? AND scope=? ORDER BY ctid DESC LIMIT 1").get(job.business_id, scope);
      const comparison = compareReports(previous ? JSON.parse(previous.rows_json) : null, rows);
      const id = previous?.raw_hash === rawHash ? previous.id : randomUUID();
      if (id !== previous?.id) {
        await tx.prepare(`INSERT INTO report_snapshots(id,business_id,job_id,scope,source,login,date_from,date_to,currency,include_vat,received_at,request_id,raw_hash,raw_tsv,rows_json,totals_json,previous_id,comparison_json,metrica_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id, job.business_id, job.id, scope, payload.source, payload.login, payload.dateFrom, payload.dateTo, "RUB", 1, new Date(now).toISOString(), null, rawHash, rawTsv, JSON.stringify(rows), JSON.stringify(totals), previous?.id || null, JSON.stringify(comparison), metrica ? JSON.stringify(metrica) : null,
        );
        await event(tx, job.business_id, { kind: "report", title: "Тестовый отчёт сохранён", reason: "Расходы и обращения сохранены отдельным снимком. Реклама не менялась.", rule: "postgres-report/1", jobId: job.id, reportId: id });
        const summary = observation(totals, metrica);
        await event(tx, job.business_id, { kind: "observation", title: summary.title, reason: summary.reason, rule: "postgres-autopilot/observe", reportId: id, status: summary.status, cpa: summary.cpa ?? null });
      }
      await tx.prepare("UPDATE jobs SET status='succeeded',available_at=?,error=NULL,payload=? WHERE id=?").run(now, JSON.stringify({ ...payload, rawTsv: null, resultSnapshotId: id, empty: rows.length === 0 }), job.id);
      return { status: "succeeded", snapshotId: id };
    });
  } catch (error) {
    await db.transaction(async (tx) => {
      const retry = error instanceof ProviderError && error.retryable && Number(job.attempts) < 3;
      await tx.prepare("UPDATE jobs SET status=?,available_at=?,error=? WHERE id=?").run(retry ? "pending" : "failed", retry ? now + 15_000 * 2 ** (Number(job.attempts) - 1) : now, retry ? "Площадка временно недоступна. Повторим получение отчёта." : "Отчёт не сохранён. Проверьте подключение и период, затем запросите его ещё раз.", job.id);
      if (retry) return;
      await event(tx, job.business_id, { kind: "report_error", title: "Отчёт не сохранён", reason: "Данные не прошли проверку. Предыдущие снимки оставлены без изменений.", rule: "postgres-report/1", jobId: job.id });
    });
    return { status: "failed" };
  }
}

export function startPostgresReportWorker(db, { key } = {}) {
  let pending = null;
  const tick = () => {
    if (pending) return;
    pending = runPostgresReportCycle(db, { key }).catch(() => undefined).finally(() => { pending = null; });
  };
  const timer = setInterval(tick, 5_000);
  timer.unref();
  tick();
  return async () => { clearInterval(timer); if (pending) await pending; };
}
