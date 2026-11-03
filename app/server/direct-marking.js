import { AppError } from "./db.js";

// Only boolean signals leave the server. The tax number and advertiser name
// stay in the Direct response and are neither stored nor sent to the browser.
export function summarizeDirectMarking(response, now = Date.now()) {
  const clients = response?.Clients;
  if (!Array.isArray(clients) || clients.length !== 1)
    throw new AppError(
      502,
      "Не удалось прочитать данные рекламодателя в Директе.",
    );
  const advertiser = clients[0];
  const clientType = advertiser.Type || "UNKNOWN";
  const organizationType = advertiser.TinInfo?.TinType || "UNKNOWN";
  const hasTaxId = Boolean(String(advertiser.TinInfo?.Tin || "").trim());
  const hasName = Boolean(
    String(advertiser.ErirAttributes?.Organization?.Name || "").trim(),
  );
  const supportedOrganizationTypes = [
    "LEGAL",
    "INDIVIDUAL",
    "PHYSICAL",
    "FOREIGN_LEGAL",
    "FOREIGN_PHYSICAL",
  ];
  const organizationNameRequired = [
    "LEGAL",
    "INDIVIDUAL",
    "FOREIGN_LEGAL",
  ].includes(organizationType);
  const findings = [];
  if (clientType !== "CLIENT")
    findings.push(
      "Для агентского кабинета нужно отдельно проверить рекламодателя и договор в Директе.",
    );
  if (!hasTaxId) findings.push("В Директе не найден ИНН рекламодателя.");
  if (organizationNameRequired && !hasName)
    findings.push("В Директе не найдено имя или название рекламодателя.");
  if (!supportedOrganizationTypes.includes(organizationType))
    findings.push(
      "Директ не вернул тип рекламодателя. Проверьте основные данные в кабинете.",
    );
  return {
    checkedAt: new Date(now).toISOString(),
    source: "Direct API clients.get",
    clientType,
    organizationType,
    hasTaxId,
    hasName,
    findings,
    basicFieldsPresent: findings.length === 0,
    manualReviewRequired: true,
    launchAuthorized: false,
    externalWrites: 0,
  };
}
