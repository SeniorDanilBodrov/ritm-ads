import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { exportReportXlsx, excelText } from "../server/report-xlsx.js";

const report = (overrides = {}) => ({
  source: "yandex",
  login: "cabinet",
  date_from: "2026-11-01",
  date_to: "2026-11-02",
  received_at: "2026-11-03T10:20:30.000Z",
  rows_json: JSON.stringify([
    {
      Date: "2026-11-01",
      CampaignId: "9007199254740993",
      CampaignName: "Маникюр",
      AdId: "8007199254740993",
      spent: 12_345,
      clicks: 7,
      impressions: 321,
      conversions: 2,
    },
  ]),
  totals_json: JSON.stringify({
    spent: 12_345,
    clicks: 7,
    impressions: 321,
    conversions: 2,
  }),
  ...overrides,
});

test("xlsx report keeps identifiers as text and metrics as numbers", async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await exportReportXlsx(report()));
  const sheet = workbook.getWorksheet("Отчёт");
  assert.equal(sheet.getCell("A1").value, "Отчёт по рекламе");
  assert.equal(sheet.getCell("B9").value, "9007199254740993");
  assert.equal(sheet.getCell("D9").value, "8007199254740993");
  assert.equal(sheet.getCell("E9").value, 123.45);
  assert.equal(sheet.getCell("E9").numFmt, '#,##0.00 "₽"');
  assert.ok(sheet.getCell("A9").value instanceof Date);
  assert.equal(sheet.views[0].ySplit, 8);
  assert.deepEqual(sheet.autoFilter, "A8:H9");
});

test("xlsx report neutralizes spreadsheet formulas including leading whitespace", async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    await exportReportXlsx(
      report({
        login: " =WEBSERVICE(\"https://example.invalid\")",
        rows_json: JSON.stringify([
          {
            Date: "2026-11-01",
            CampaignId: "+1+1",
            CampaignName: "\t@SUM(1,1)",
            AdId: "-2+3",
            spent: 0,
            clicks: 0,
            impressions: 0,
            conversions: 0,
          },
        ]),
      }),
    ),
  );
  const sheet = workbook.getWorksheet("Отчёт");
  assert.equal(sheet.getCell("B5").value, "' =WEBSERVICE(\"https://example.invalid\")");
  assert.equal(sheet.getCell("B9").value, "'+1+1");
  assert.equal(sheet.getCell("C9").value, "'\t@SUM(1,1)");
  assert.equal(sheet.getCell("D9").value, "'-2+3");
  for (const address of ["B5", "B9", "C9", "D9"])
    assert.equal(typeof sheet.getCell(address).value, "string");
});

test("xlsx report rejects malformed dates and excessive row counts", async () => {
  await assert.rejects(
    exportReportXlsx(
      report({
        rows_json: JSON.stringify([
          {
            Date: "2026-02-30",
            CampaignId: "1",
            spent: 0,
            clicks: 0,
            impressions: 0,
            conversions: 0,
          },
        ]),
      }),
    ),
    /некорректную дату/i,
  );
  await assert.rejects(
    exportReportXlsx(report({ rows_json: JSON.stringify(Array(100_001).fill({})) })),
    (error) => error.status === 413 && error.code === "xlsx_row_limit",
  );
});

test("excelText removes invalid XML control characters", () => {
  assert.equal(excelText("name\u0000value"), "name value");
});
