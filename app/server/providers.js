import { AppError } from "./db.js";
import { request as httpsRequest } from "node:https";

function ipv4Fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: options.method || "GET",
        headers: options.headers,
        family: 4,
        signal: options.signal,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            request.destroy(new Error("response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            headers: {
              get: (name) =>
                response.headers[String(name).toLowerCase()] || null,
            },
            json: async () => JSON.parse(body),
            text: async () => body,
          });
        });
      },
    );
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

export class ProviderError extends AppError {
  constructor(
    message,
    retryable = false,
    requestId = null,
    retryAfter = 30,
    authFailure = false,
    providerStatus = null,
  ) {
    super(502, message, "provider_error");
    Object.assign(this, {
      retryable,
      requestId,
      retryAfter,
      authFailure,
      providerStatus,
    });
  }
}

export function describeDirectValidationFailure(error) {
  const providerCode = Number(error?.providerCode);
  if (providerCode === 58)
    return {
      validation: "blocked",
      validationCode: "application_access_pending",
      validationMessage:
        "Код принят. Заявка приложения Ритма на доступ к API Директа ещё не одобрена Яндексом. Повторно подключать кабинет не нужно — после одобрения нажмите «Проверить доступ».",
    };
  if (providerCode === 513)
    return {
      validation: "blocked",
      validationCode: "direct_account_missing",
      validationMessage:
        "Код принят, но на этом Яндекс ID ещё нет кабинета Директа. Создайте кабинет в Яндекс Директе, затем нажмите «Проверить доступ».",
    };
  if (providerCode === 3000)
    return {
      validation: "blocked",
      validationCode: "direct_api_disabled",
      validationMessage:
        "Код принят, но для этого кабинета закрыт доступ к API Директа. Проверьте настройки API и ограничения по IP, затем повторите проверку.",
    };
  if (providerCode === 54)
    return {
      validation: "reauth_required",
      validationCode: "direct_rights_missing",
      validationMessage:
        "Код принят, но у этого аккаунта недостаточно прав на кабинет Директа. Войдите представителем с правом редактирования и подключите кабинет заново.",
    };
  if (error?.retryable)
    return {
      validation: "pending",
      validationCode: "direct_temporarily_unavailable",
      validationMessage:
        "Код принят. Директ пока не ответил — повторите проверку через несколько минут.",
    };
  return {
    validation: "reauth_required",
    validationCode: providerCode
      ? `direct_${providerCode}`
      : "direct_access_failed",
    validationMessage:
      "Код принят, но Яндекс не разрешил доступ к Директу. Проверьте, что выбран нужный аккаунт, и подключите кабинет заново.",
  };
}
function parseDirectJson(body) {
  let output = "",
    inString = false,
    escaped = false;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "-" || /[0-9]/.test(char)) {
      let end = i + 1;
      while (end < body.length && /[0-9.eE+-]/.test(body[end])) end++;
      const value = body.slice(i, end);
      output +=
        /^-?(0|[1-9][0-9]*)$/.test(value) &&
        !Number.isSafeInteger(Number(value))
          ? JSON.stringify(value)
          : value;
      i = end - 1;
      continue;
    }
    output += char;
  }
  return JSON.parse(output);
}

export async function requestJson(url, options = {}, fetcher = fetch) {
  let response;
  const {
    timeoutMs = 20000,
    preserveLargeIntegers = false,
    ...requestOptions
  } = options;
  try {
    response = await fetcher(url, {
      ...requestOptions,
      signal: requestOptions.signal || AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProviderError(
      "Площадка не ответила вовремя. Попробуйте позже.",
      true,
    );
  }
  if (!response.ok)
    throw new ProviderError(
      response.status === 401
        ? "Доступ отозван. Подключите кабинет заново."
        : response.status === 504
          ? "Площадка не ответила вовремя. Попробуйте позже."
          : "Площадка временно отклонила запрос.",
      response.status === 429 || response.status >= 500,
      response.headers.get("requestid"),
      30,
      response.status === 401,
      response.status,
    );
  return preserveLargeIntegers
    ? parseDirectJson(await response.text())
    : response.json();
}
export class DirectClient {
  constructor({ accessToken, login, sandbox = false, fetcher = fetch }) {
    if (sandbox)
      throw new ProviderError(
        "Песочница Яндекс Директа недоступна с 15 июля 2026 года. Используйте production API только для чтения или локальный dry-run.",
        false,
        null,
        0,
        false,
        410,
      );
    Object.assign(this, { accessToken, login, sandbox, fetcher });
    this.base = "https://api.direct.yandex.com/json/v501/";
  }
  headers() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "Accept-Language": "ru",
      "Content-Type": "application/json",
      ...(this.login ? { "Client-Login": this.login } : {}),
    };
  }
  async call(service, method, params) {
    const data = await requestJson(
      this.base + service,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ method, params }),
        preserveLargeIntegers: true,
      },
      this.fetcher,
    );
    if (data.error) {
      const error = new ProviderError(
        `Ошибка Директа ${data.error.error_code}. Проверьте доступ и параметры кабинета.`,
        [52, 9000].includes(data.error.error_code),
        data.error.request_id,
        30,
        [53, 1002].includes(data.error.error_code),
      );
      error.providerCode = Number(data.error.error_code);
      throw error;
    }
    if (!data.result)
      throw new ProviderError("Директ вернул ответ без результата.");
    for (const [key, value] of Object.entries(data.result))
      if (
        key.endsWith("Results") &&
        Array.isArray(value) &&
        value.some((v) => v.Errors?.length)
      ) {
        const error = new ProviderError(
          "Директ выполнил запрос частично. Перед повтором нужна сверка объектов.",
        );
        error.itemErrors = value.flatMap((item, index) =>
          (item.Errors || []).map((entry) => ({
            index,
            code: entry.Code,
            message: entry.Message,
            details: entry.Details,
          })),
        );
        throw error;
      }
    return data.result;
  }
  clients() {
    return this.call("clients", "get", {
      FieldNames: ["Login", "ClientId", "Currency"],
    });
  }
  advertiserMarkingDetails() {
    return this.call("clients", "get", {
      FieldNames: ["Login", "ClientId", "Type"],
      TinInfoFieldNames: ["TinType", "Tin"],
      OrganizationFieldNames: ["Name"],
    });
  }
  campaigns() {
    return this.call("campaigns", "get", {
      SelectionCriteria: {},
      FieldNames: ["Id", "Name", "State", "Status", "Type"],
      Page: { Limit: 1000 },
    });
  }
  createCampaigns(items) {
    return this.call("campaigns", "add", { Campaigns: items });
  }
  createAdGroups(items) {
    return this.call("adgroups", "add", { AdGroups: items });
  }
  createAds(items) {
    return this.call("ads", "add", { Ads: items });
  }
  createAdImages(items) {
    if (!Array.isArray(items) || !items.length || items.length > 100)
      throw new AppError(400, "Передайте от одного до ста изображений.");
    return this.call("adimages", "add", { AdImages: items });
  }
  adImagesByHashes(hashes) {
    if (
      !Array.isArray(hashes) ||
      !hashes.length ||
      hashes.some((value) => !/^[A-Za-z0-9_-]+$/.test(String(value)))
    )
      throw new AppError(400, "Некорректные идентификаторы изображений.");
    return this.call("adimages", "get", {
      SelectionCriteria: { AdImageHashes: hashes.map(String) },
      FieldNames: ["AdImageHash", "Name", "Type", "Associated"],
      Page: { Limit: Math.min(hashes.length, 10_000) },
    });
  }
  adImages() {
    return this.call("adimages", "get", {
      SelectionCriteria: {},
      FieldNames: ["AdImageHash", "Name", "Type", "Associated"],
      Page: { Limit: 10_000 },
    });
  }
  createKeywords(items) {
    return this.call("keywords", "add", { Keywords: items });
  }
  campaignsByIds(ids) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.some((id) => !/^[1-9]\d*$/.test(String(id)))
    )
      throw new AppError(400, "Некорректные идентификаторы кампаний");
    return this.call("campaigns", "get", {
      SelectionCriteria: { Ids: ids.map(directId) },
      FieldNames: ["Id", "Name", "State", "Status", "Type"],
    });
  }
  campaignBudgetById(id) {
    validateDirectIds([id], "кампаний");
    return this.call("campaigns", "get", {
      SelectionCriteria: { Ids: [directId(id)] },
      FieldNames: [
        "Id",
        "Name",
        "State",
        "Status",
        "StatusPayment",
        "Type",
        "Currency",
        "StartDate",
        "EndDate",
      ],
      TextCampaignFieldNames: ["BiddingStrategy"],
      UnifiedCampaignFieldNames: ["BiddingStrategy", "CounterIds"],
    });
  }
  updateTextCampaignPeriodBudget(
    id,
    { spendLimitKopecks, startDate, endDate },
  ) {
    validateDirectIds([id], "кампаний");
    if (
      !Number.isSafeInteger(spendLimitKopecks) ||
      spendLimitKopecks <= 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(endDate)
    )
      throw new AppError(400, "Некорректный периодный лимит кампании");
    return this.call("campaigns", "update", {
      Campaigns: [
        {
          Id: directId(id),
          TextCampaign: {
            BiddingStrategy: {
              Search: {
                BiddingStrategyType: "WB_MAXIMUM_CLICKS",
                WbMaximumClicks: {
                  CustomPeriodBudget: {
                    SpendLimit: spendLimitKopecks * 10_000,
                    StartDate: startDate,
                    EndDate: endDate,
                    AutoContinue: "NO",
                  },
                },
              },
              Network: { BiddingStrategyType: "SERVING_OFF" },
            },
          },
        },
      ],
    });
  }
  adGroupsByCampaignId(id) {
    validateDirectIds([id], "кампаний");
    return this.call("adgroups", "get", {
      SelectionCriteria: { CampaignIds: [directId(id)] },
      FieldNames: ["Id", "CampaignId", "Name", "Status", "Type"],
    });
  }
  adGroupsByIds(ids) {
    validateDirectIds(ids, "групп объявлений");
    return this.call("adgroups", "get", {
      SelectionCriteria: { Ids: ids.map(directId) },
      FieldNames: ["Id", "Name", "CampaignId", "Status", "Type"],
    });
  }
  adsByAdGroupId(id) {
    validateDirectIds([id], "групп объявлений");
    return this.call("ads", "get", {
      SelectionCriteria: { AdGroupIds: [directId(id)] },
      FieldNames: ["Id", "AdGroupId", "State", "Status", "Type"],
      TextAdFieldNames: ["Title", "Title2", "Text", "Href", "AdImageHash"],
      ResponsiveAdFieldNames: ["Titles", "Texts", "Href"],
    });
  }
  keywordsByAdGroupId(id) {
    validateDirectIds([id], "групп объявлений");
    return this.call("keywords", "get", {
      SelectionCriteria: { AdGroupIds: [directId(id)] },
      FieldNames: ["Id", "AdGroupId", "Keyword", "State", "Status"],
    });
  }
  adsByIds(ids) {
    validateDirectIds(ids, "объявлений");
    return this.call("ads", "get", {
      SelectionCriteria: { Ids: ids.map(directId) },
      FieldNames: ["Id", "CampaignId", "AdGroupId", "State", "Status", "Type"],
      TextAdFieldNames: ["Title", "Title2", "Text", "Href", "AdImageHash"],
      ResponsiveAdFieldNames: ["Titles", "Texts", "Href"],
    });
  }
  moderateAds(ids) {
    validateDirectIds(ids, "объявлений");
    return this.call("ads", "moderate", {
      SelectionCriteria: { Ids: ids.map(directId) },
    });
  }
  deleteAds(ids) {
    validateDirectIds(ids, "объявлений");
    return this.call("ads", "delete", {
      SelectionCriteria: { Ids: ids.map(directId) },
    });
  }
  suspendAds(ids) {
    validateDirectIds(ids, "объявлений");
    return this.call("ads", "suspend", {
      SelectionCriteria: { Ids: ids.map(directId) },
    });
  }
  keywordsByIds(ids) {
    validateDirectIds(ids, "ключевых фраз");
    return this.call("keywords", "get", {
      SelectionCriteria: { Ids: ids.map(directId) },
      FieldNames: [
        "Id",
        "CampaignId",
        "AdGroupId",
        "Keyword",
        "State",
        "Status",
      ],
    });
  }
  suspendCampaigns(ids) {
    validateDirectIds(ids, "кампаний");
    return this.call("campaigns", "suspend", {
      SelectionCriteria: { Ids: ids.map(directId) },
    });
  }
  archiveCampaigns(ids) {
    validateDirectIds(ids, "кампаний");
    return this.call("campaigns", "archive", {
      SelectionCriteria: { Ids: ids.map(directId) },
    });
  }
  resumeCampaigns(ids) {
    validateDirectIds(ids, "кампаний");
    return this.call("campaigns", "resume", {
      SelectionCriteria: { Ids: ids.map(directId) },
    });
  }
  async report(dateFrom, dateTo, { reportType = "campaign", adIds = [] } = {}) {
    if (!["campaign", "ad"].includes(reportType))
      throw new AppError(400, "Некорректный тип отчёта");
    if (reportType === "ad") validateDirectIds(adIds, "объявлений");
    const spec = {
      SelectionCriteria: {
        DateFrom: dateFrom,
        DateTo: dateTo,
        ...(reportType === "ad"
          ? {
              Filter: [
                {
                  Field: "AdId",
                  Operator: "IN",
                  Values: adIds.map(String),
                },
              ],
            }
          : {}),
      },
      FieldNames:
        reportType === "ad"
          ? [
              "Date",
              "CampaignId",
              "CampaignName",
              "AdGroupId",
              "AdId",
              "Impressions",
              "Clicks",
              "Conversions",
              "Cost",
            ]
          : [
              "Date",
              "CampaignId",
              "CampaignName",
              "Impressions",
              "Clicks",
              "Conversions",
              "Cost",
            ],
      ReportName: `ritm-${reportType}-${dateFrom}-${dateTo}`,
      ReportType:
        reportType === "ad"
          ? "AD_PERFORMANCE_REPORT"
          : "CAMPAIGN_PERFORMANCE_REPORT",
      DateRangeType: "CUSTOM_DATE",
      Format: "TSV",
      IncludeVAT: "YES",
      IncludeDiscount: "YES",
    };
    let res;
    try {
      res = await this.fetcher(this.base + "reports", {
        method: "POST",
        headers: {
          ...this.headers(),
          processingMode: "auto",
          returnMoneyInMicros: "false",
          skipReportHeader: "true",
          skipReportSummary: "true",
        },
        body: JSON.stringify({ params: spec }),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new ProviderError("Отчет не получен. Проверьте соединение.", true);
    }
    if (res.status === 201 || res.status === 202)
      return {
        pending: true,
        retryAfter: Math.max(1, Number(res.headers.get("retryIn")) || 30),
      };
    if (res.status !== 200)
      throw new ProviderError(
        "Не удалось получить отчет Директа.",
        res.status >= 500 || res.status === 429,
        res.headers.get("requestid"),
        30,
        res.status === 401 || res.status === 403,
        res.status,
      );
    const rawTsv = await readReportBody(res);
    return {
      pending: false,
      rows: parseReport(rawTsv),
      rawTsv,
      requestId: res.headers.get("requestid"),
      includeVat: true,
      at: new Date().toISOString(),
    };
  }
}

const directId = (id) =>
  Number.isSafeInteger(Number(id)) ? Number(id) : JSON.rawJSON(String(id));

function validateDirectIds(ids, label) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.some((id) => !/^[1-9]\d*$/.test(String(id)))
  )
    throw new AppError(400, `Некорректные идентификаторы ${label}`);
}
export function parseReport(text) {
  const [header, ...lines] = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (!header)
    throw new ProviderError("Пустой ответ не является готовым отчетом.");
  const names = header.split("\t");
  if (
    new Set(names).size !== names.length ||
    !["CampaignId", "Date", "Cost"].every((k) => names.includes(k))
  )
    throw new ProviderError("Формат отчета Директа изменился.");
  const seen = new Set();
  const dataLines = lines.filter(Boolean);
  if (dataLines.length > 10000)
    throw new ProviderError(
      "Отчет слишком большой для этой версии. Сократите период.",
    );
  return dataLines.map((line) => {
    if (line.split("\t").length !== names.length)
      throw new ProviderError("Неполная строка отчета.");
    const row = Object.fromEntries(
      line.split("\t").map((v, i) => [names[i], v]),
    );
    const raw = String(row.Cost);
    if (!/^\d+(\.\d{1,2})?$/.test(raw))
      throw new ProviderError("В отчете некорректная сумма.");
    const [whole, fraction = ""] = raw.split(".");
    const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    const parsedDate = new Date(row.Date + "T00:00:00Z");
    const identity =
      row.Date + ":" + row.CampaignId + (row.AdId ? `:${row.AdId}` : "");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(row.Date) ||
      !Number.isFinite(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== row.Date ||
      !/^\d+$/.test(row.CampaignId) ||
      seen.has(identity)
    )
      throw new ProviderError(
        "Некорректная дата, ID или повтор строки отчета.",
      );
    seen.add(identity);
    const metric = (value) => {
      if (
        !/^\d+$/.test(String(value ?? "0")) ||
        !Number.isSafeInteger(Number(value ?? 0))
      )
        throw new ProviderError("Некорректный показатель в отчете.");
      return Number(value ?? 0);
    };
    if (amount > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ProviderError("Сумма отчета выходит за допустимый диапазон.");
    return {
      ...row,
      spent: Number(amount),
      clicks: metric(row.Clicks),
      impressions: metric(row.Impressions),
      conversions: metric(row.Conversions),
    };
  });
}

async function readReportBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError("Отчет не содержит данных.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new ProviderError("Отчет превышает 2 МБ. Сократите период.");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("Загрузка отчета прервалась.", true);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new ProviderError("В отчете некорректная кодировка UTF-8.");
  }
}
export class MetricaClient {
  constructor(accessToken, fetcher = ipv4Fetch) {
    this.accessToken = accessToken;
    this.fetcher = fetcher;
  }
  get(path) {
    return requestJson(
      "https://api-metrika.yandex.net" + path,
      { headers: { Authorization: `OAuth ${this.accessToken}` } },
      this.fetcher,
    );
  }
  counters() {
    return this.get("/management/v1/counters?per_page=1000");
  }
  goals(id) {
    if (!/^\d+$/.test(String(id)))
      throw new AppError(400, "Некорректный счетчик");
    return this.get(`/management/v1/counter/${id}/goals`);
  }
  statistics(id, goalId, dateFrom = "6daysAgo", dateTo = "today") {
    if (!/^\d+$/.test(String(id)) || !/^\d+$/.test(String(goalId)))
      throw new AppError(400, "Некорректный счетчик или цель");
    const query = new URLSearchParams({
      ids: String(id),
      metrics: `ym:s:visits,ym:s:goal${goalId}reaches`,
      date1: dateFrom,
      date2: dateTo,
      accuracy: "full",
    });
    return this.get(`/stat/v1/data?${query}`);
  }
  campaignStatistics(
    id,
    goalId,
    campaignId,
    dateFrom = "6daysAgo",
    dateTo = "today",
  ) {
    if (
      !/^\d+$/.test(String(id)) ||
      !/^\d+$/.test(String(goalId)) ||
      !/^\d+$/.test(String(campaignId))
    )
      throw new AppError(400, "Некорректный счетчик, цель или кампания");
    const query = new URLSearchParams({
      ids: String(id),
      metrics: `ym:s:visits,ym:s:goal${goalId}reaches`,
      filters: `ym:s:lastsignDirectClickOrder==${campaignId}`,
      attribution: "lastsign",
      date1: dateFrom,
      date2: dateTo,
      accuracy: "full",
    });
    return this.get(`/stat/v1/data?${query}`);
  }
}

export function revokeYandexToken(
  accessToken,
  clientId,
  clientSecret,
  fetcher = fetch,
) {
  if (!accessToken || !clientId || !clientSecret)
    throw new AppError(503, "Отзыв токена не настроен.", "not_configured");
  const body = new URLSearchParams({ access_token: accessToken });
  return requestJson(
    "https://oauth.yandex.ru/revoke_token",
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    fetcher,
  );
}

export function refreshYandexToken(
  refreshToken,
  clientId,
  clientSecret,
  fetcher = fetch,
) {
  if (!refreshToken || !clientId || !clientSecret)
    throw new AppError(
      503,
      "Обновление токена Яндекса не настроено.",
      "not_configured",
    );
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return requestJson(
    "https://oauth.yandex.ru/token",
    {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      timeoutMs: 45000,
    },
    fetcher,
  );
}
