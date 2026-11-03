import assert from "node:assert/strict";
import test from "node:test";
import { summarizeDirectMarking } from "../server/direct-marking.js";

test("marking check returns only presence signals, never tax ID or name", () => {
  const result = summarizeDirectMarking({
    Clients: [
      {
        Type: "CLIENT",
        TinInfo: { TinType: "LEGAL", Tin: "1234567890" },
        ErirAttributes: { Organization: { Name: "Пример ООО" } },
      },
    ],
  });
  assert.equal(result.basicFieldsPresent, true);
  assert.equal(result.launchAuthorized, false);
  assert.equal(result.manualReviewRequired, true);
  assert.equal(result.externalWrites, 0);
  assert.doesNotMatch(JSON.stringify(result), /1234567890|Пример ООО/);
});

test("marking check flags incomplete and agency profiles", () => {
  const result = summarizeDirectMarking({
    Clients: [{ Type: "SUBCLIENT", TinInfo: { TinType: "PHYSICAL" } }],
  });
  assert.equal(result.basicFieldsPresent, false);
  assert.equal(result.hasTaxId, false);
  assert.equal(result.hasName, false);
  assert.ok(result.findings.some((item) => item.includes("агентского")));
  assert.ok(result.findings.some((item) => item.includes("ручной проверки")));
  assert.throws(
    () => summarizeDirectMarking({ Clients: [] }),
    /Не удалось прочитать/,
  );
});
