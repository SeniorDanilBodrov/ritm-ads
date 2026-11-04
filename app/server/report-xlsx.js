import ExcelJS from "exceljs";
import { AppError } from "./db.js";

const MAX_XLSX_ROWS = 100_000;

const sourceLabel = (source) =>
  source === "demo"
    ? "Тестовый источник"
    : source === "yandex-sandbox"
      ? "Яндекс · Sandbox"
      : "Яндекс Директ";

export const excelText = (value) => {
  const text = String(value ?? "").replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
    " ",
  );
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
};

const finiteNumber = (value, label) => {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number))
    throw new AppError(500, `Отчёт содержит некорректное поле «${label}».`);
  return number;
};

const reportDate = (value) => {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
    throw new AppError(500, "Отчёт содержит некорректную дату.");
  const date = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text)
    throw new AppError(500, "Отчёт содержит некорректную дату.");
  return date;
};

const parseJson = (value, fallback, label) => {
  if (value === undefined || value === null || value === "") return fallback;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new AppError(500, `Не удалось прочитать ${label} отчёта.`);
  }
};

export async function exportReportXlsx(report) {
  const rows = parseJson(report.rows_json, [], "строки");
  const totals = parseJson(report.totals_json, {}, "итоги");
  const payload = parseJson(report.job_payload, {}, "параметры");
  if (!Array.isArray(rows))
    throw new AppError(500, "Строки отчёта имеют неверный формат.");
  if (rows.length > MAX_XLSX_ROWS)
    throw new AppError(
      413,
      `В Excel можно выгрузить не более ${MAX_XLSX_ROWS.toLocaleString("ru-RU")} строк за один раз. Сократите период.`,
      "xlsx_row_limit",
    );

  const workbook = new ExcelJS.Workbook();
  const generatedAt = new Date();
  workbook.creator = "Ритм";
  workbook.created = generatedAt;
  workbook.modified = generatedAt;
  const sheet = workbook.addWorksheet("Отчёт", {
    views: [{ state: "frozen", ySplit: 8 }],
    properties: { defaultRowHeight: 18 },
  });
  sheet.columns = [
    { key: "date", width: 14 },
    { key: "campaignId", width: 18 },
    { key: "campaign", width: 36 },
    { key: "adId", width: 18 },
    { key: "spent", width: 16 },
    { key: "clicks", width: 13 },
    { key: "impressions", width: 14 },
    { key: "conversions", width: 16 },
  ];

  sheet.mergeCells("A1:H1");
  const title = sheet.getCell("A1");
  title.value = "Отчёт по рекламе";
  title.font = {
    name: "Aptos Display",
    size: 18,
    bold: true,
    color: { argb: "FFFFFFFF" },
  };
  title.alignment = { vertical: "middle" };
  title.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF0D5D49" },
  };
  sheet.getRow(1).height = 30;

  const receivedAt = new Date(report.received_at || generatedAt);
  const summary = [
    ["Источник", sourceLabel(report.source)],
    ["Период", `${report.date_from} — ${report.date_to}`],
    ["Кабинет", excelText(report.login || "Демо")],
    ["Получен", Number.isFinite(receivedAt.getTime()) ? receivedAt : generatedAt],
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
    "Обращения",
  ];
  header.height = 24;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle" };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF176A55" },
    };
  });

  for (const row of rows) {
    const target = sheet.addRow({
      date: reportDate(row.Date),
      campaignId: excelText(row.CampaignId),
      campaign: excelText(row.CampaignName || ""),
      adId: excelText(row.AdId || ""),
      spent: finiteNumber(row.spent, "Расход") / 100,
      clicks: finiteNumber(row.clicks, "Клики"),
      impressions: finiteNumber(row.impressions, "Показы"),
      conversions: finiteNumber(row.conversions, "Обращения"),
    });
    target.getCell("date").numFmt = "yyyy-mm-dd";
    target.getCell("spent").numFmt = '#,##0.00 "₽"';
    target.getCell("clicks").numFmt = "#,##0";
    target.getCell("impressions").numFmt = "#,##0";
    target.getCell("conversions").numFmt = "#,##0";
  }

  const totalsRow = headerRow + rows.length + 1;
  sheet.getCell(totalsRow, 4).value = "Итого";
  sheet.getCell(totalsRow, 5).value = finiteNumber(totals.spent, "Итоговый расход") / 100;
  sheet.getCell(totalsRow, 6).value = finiteNumber(totals.clicks, "Итоговые клики");
  sheet.getCell(totalsRow, 7).value = finiteNumber(totals.impressions, "Итоговые показы");
  sheet.getCell(totalsRow, 8).value = finiteNumber(totals.conversions, "Итоговые обращения");
  sheet.getRow(totalsRow).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FF17231F" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE5F264" },
    };
  });
  for (let column = 5; column <= 8; column += 1)
    sheet.getCell(totalsRow, column).numFmt =
      column === 5 ? '#,##0.00 "₽"' : "#,##0";

  if (rows.length)
    sheet.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: headerRow + rows.length, column: 8 },
    };
  return workbook.xlsx.writeBuffer();
}
