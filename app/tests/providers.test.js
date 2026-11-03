import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  DirectClient,
  describeDirectValidationFailure,
  MetricaClient,
  parseReport,
  requestJson,
  revokeYandexToken,
  refreshYandexToken,
} from "../server/providers.js";
import { encrypt, decrypt } from "../server/security.js";

test("HTTP gateway timeout is shown as a retryable timeout", async () => {
  await assert.rejects(
    () =>
      requestJson("https://provider.test", {}, async () =>
        Response.json({}, { status: 504 }),
      ),
    (error) => {
      assert.match(error.message, /не ответила вовремя/);
      assert.equal(error.retryable, true);
      assert.equal(error.providerStatus, 504);
      return true;
    },
  );
});

test("tokens are encrypted with workspace binding", () => {
  const key = randomBytes(32),
    data = { access_token: "secret" };
  const stored = encrypt(data, key, "business-a");
  assert.ok(!stored.includes("secret"));
  assert.deepEqual(decrypt(stored, key, "business-a"), data);
  assert.throws(() => decrypt(stored, key, "business-b"));
  assert.throws(() => decrypt(stored, randomBytes(32), "business-a"));
});
test("report conversion retains kopecks and rejects unknown values", () => {
  assert.deepEqual(
    parseReport("Date\tCampaignId\tCost\tClicks\n2026-10-01\t123\t12.34\t2")[0]
      .spent,
    1234,
  );
  assert.throws(() =>
    parseReport("Date\tCampaignId\tCost\n2026-10-01\t123\t--"),
  );
});
test("campaign report requests and parses Direct conversions", async () => {
  const parsed = parseReport(
    "Date\tCampaignId\tImpressions\tClicks\tConversions\tCost\n" +
      "2026-10-01\t123\t100\t7\t3\t12.34\n",
  );
  assert.equal(parsed[0].conversions, 3);
  let body;
  const client = new DirectClient({
    accessToken: "test",
    fetcher: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response("", { status: 202, headers: { retryIn: "5" } });
    },
  });
  await client.report("2026-10-01", "2026-10-02");
  assert.ok(body.params.FieldNames.includes("Conversions"));
});
test("ad report keeps two ads on the same day and requests only their IDs", async () => {
  const rows = parseReport(
    "Date\tCampaignId\tAdGroupId\tAdId\tImpressions\tClicks\tCost\n" +
      "2026-10-01\t123\t20\t401\t100\t5\t12.34\n" +
      "2026-10-01\t123\t20\t402\t120\t8\t15.00\n",
  );
  assert.deepEqual(
    rows.map((row) => row.AdId),
    ["401", "402"],
  );
  let body;
  const client = new DirectClient({
    accessToken: "test",
    fetcher: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response("", { status: 202, headers: { retryIn: "5" } });
    },
  });
  await client.report("2026-10-01", "2026-10-02", {
    reportType: "ad",
    adIds: ["401", "402"],
  });
  assert.equal(body.params.ReportType, "AD_PERFORMANCE_REPORT");
  assert.deepEqual(body.params.SelectionCriteria.Filter, [
    { Field: "AdId", Operator: "IN", Values: ["401", "402"] },
  ]);
  assert.ok(body.params.FieldNames.includes("AdId"));
});
test("async reports return a retry delay, not empty success", async () => {
  const c = new DirectClient({
    accessToken: "test",
    fetcher: async (url, opt) => {
      assert.equal(new URL(url).hostname, "api.direct.yandex.com");
      assert.equal(new URL(url).pathname, "/json/v501/reports");
      assert.equal(opt.headers.Authorization, "Bearer test");
      return new Response("", { status: 202, headers: { retryIn: "45" } });
    },
  });
  assert.deepEqual(await c.report("2026-10-01", "2026-10-23"), {
    pending: true,
    retryAfter: 45,
  });
});
test("retired Direct sandbox is rejected before network", () => {
  let called = false;
  assert.throws(
    () =>
      new DirectClient({
        accessToken: "test",
        sandbox: true,
        fetcher: async () => {
          called = true;
          return Response.json({});
        },
      }),
    (error) => {
      assert.match(error.message, /недоступна с 15 июля 2026/);
      assert.equal(error.providerStatus, 410);
      return true;
    },
  );
  assert.equal(called, false);
});
test("partial API failure is not reported as success or retried", async () => {
  let calls = 0;
  const c = new DirectClient({
    accessToken: "test",
    fetcher: async () => {
      calls++;
      return Response.json({
        result: { AddResults: [{ Id: 1 }, { Errors: [{ Code: 1 }] }] },
      });
    },
  });
  await assert.rejects(
    () => c.call("campaigns", "add", {}),
    (error) => {
      assert.match(error.message, /частично/);
      assert.deepEqual(error.itemErrors, [
        {
          index: 1,
          code: 1,
          message: undefined,
          details: undefined,
        },
      ]);
      return true;
    },
  );
  assert.equal(calls, 1);
});
test("Direct IDs above Number.MAX_SAFE_INTEGER round-trip without precision loss", async () => {
  const id = "1925476440579438319";
  const bodies = [];
  const client = new DirectClient({
    accessToken: "test",
    fetcher: async (_url, options) => {
      bodies.push(options.body);
      return new Response(`{"result":{"Ads":[{"Id":${id},"AdGroupId":2}]}}`);
    },
  });
  const first = await client.adsByAdGroupId(2);
  assert.equal(first.Ads[0].Id, id);
  const second = await client.adsByIds([id]);
  assert.equal(second.Ads[0].Id, id);
  assert.match(bodies[1], new RegExp(`"Ids":\\[${id}\\]`));
});
test("logical API errors remain failures on HTTP 200", async () => {
  const c = new DirectClient({
    accessToken: "test",
    fetcher: async () => Response.json({ error: { error_code: 1002 } }),
  });
  await assert.rejects(
    () => c.clients(),
    (error) => {
      assert.match(error.message, /1002/);
      assert.equal(error.providerCode, 1002);
      return true;
    },
  );
});

test("Direct access blockers are translated into a recoverable user step", () => {
  assert.deepEqual(
    describeDirectValidationFailure({ providerCode: 58, retryable: false }),
    {
      validation: "blocked",
      validationCode: "application_access_pending",
      validationMessage:
        "Код принят. Заявка приложения Ритма на доступ к API Директа ещё не одобрена Яндексом. Повторно подключать кабинет не нужно — после одобрения нажмите «Проверить доступ».",
    },
  );
  assert.equal(
    describeDirectValidationFailure({ providerCode: 513 }).validationCode,
    "direct_account_missing",
  );
  assert.equal(
    describeDirectValidationFailure({ retryable: true }).validation,
    "pending",
  );
});

test("report download rejects oversized data and invalid UTF-8", async () => {
  for (const body of [
    "x".repeat(2 * 1024 * 1024 + 1),
    new Uint8Array([0xff, 0xfe]),
  ]) {
    const c = new DirectClient({
      accessToken: "test",
      fetcher: async () => new Response(body),
    });
    await assert.rejects(() => c.report("2026-10-01", "2026-10-24"));
  }
});

test("Direct write adapter maps each object to the documented service", async () => {
  const calls = [],
    client = new DirectClient({
      accessToken: "test",
      login: "client",
      sandbox: false,
      fetcher: async (url, options) => {
        calls.push({
          url,
          body: JSON.parse(options.body),
          headers: options.headers,
        });
        return Response.json({ result: { AddResults: [{ Id: 7 }] } });
      },
    });
  await client.createCampaigns([{ Name: "Campaign" }]);
  await client.createAdGroups([{ Name: "Group" }]);
  await client.createAds([{ TextAd: {} }]);
  await client.createKeywords([{ Keyword: "phrase" }]);
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      "/json/v501/campaigns",
      "/json/v501/adgroups",
      "/json/v501/ads",
      "/json/v501/keywords",
    ],
  );
  assert.ok(calls.every((call) => call.body.method === "add"));
  assert.ok(calls.every((call) => call.headers["Client-Login"] === "client"));
});

test("Direct lifecycle and reconciliation methods use production v501 contracts", async () => {
  const calls = [],
    client = new DirectClient({
      accessToken: "test",
      login: "client",
      sandbox: false,
      fetcher: async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ path: new URL(url).pathname, ...body });
        const service = new URL(url).pathname.split("/").at(-1);
        if (body.method === "suspend")
          return Response.json({ result: { SuspendResults: [{ Id: 1 }] } });
        if (body.method === "delete")
          return Response.json({ result: { DeleteResults: [{ Id: 4 }] } });
        if (body.method === "archive")
          return Response.json({ result: { ArchiveResults: [{ Id: 1 }] } });
        if (body.method === "resume")
          return Response.json({ result: { ResumeResults: [{ Id: 1 }] } });
        const result =
          service === "campaigns"
            ? { Campaigns: [{ Id: 1, State: "OFF" }] }
            : service === "adgroups"
              ? { AdGroups: [{ Id: 2, CampaignId: 1 }] }
              : service === "keywords"
                ? { Keywords: [{ Id: 3, CampaignId: 1, AdGroupId: 2 }] }
                : { Ads: [{ Id: 4, CampaignId: 1, AdGroupId: 2 }] };
        return Response.json({ result });
      },
    });
  await client.adGroupsByIds([2]);
  await client.keywordsByIds([3]);
  await client.adsByIds([4]);
  await client.deleteAds([4]);
  await client.suspendAds([4]);
  await client.suspendCampaigns([1]);
  await client.archiveCampaigns([1]);
  await client.resumeCampaigns([1]);
  assert.ok(calls.every((call) => call.path.startsWith("/json/v501/")));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["get", "get", "get", "delete", "suspend", "suspend", "archive", "resume"],
  );
  assert.deepEqual(calls[0].params.SelectionCriteria, { Ids: [2] });
  assert.deepEqual(calls.at(-1).params.SelectionCriteria, { Ids: [1] });
});

test("Direct budget read requests the TextCampaign bidding strategy", async () => {
  let request;
  const client = new DirectClient({
    accessToken: "test-token",
    login: "test-login",
    fetcher: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return Response.json({ result: { Campaigns: [{ Id: 123 }] } });
    },
  });
  await client.campaignBudgetById(123);
  assert.equal(new URL(request.url).pathname, "/json/v501/campaigns");
  assert.equal(request.body.method, "get");
  assert.deepEqual(request.body.params.SelectionCriteria.Ids, [123]);
  assert.deepEqual(request.body.params.TextCampaignFieldNames, [
    "BiddingStrategy",
  ]);
  assert.ok(request.body.params.FieldNames.includes("Currency"));
});

test("Direct budget update sends one exact custom-period limit", async () => {
  let request;
  const client = new DirectClient({
    accessToken: "test-token",
    login: "test-login",
    fetcher: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return Response.json({ result: { UpdateResults: [{ Id: 123 }] } });
    },
  });
  await client.updateTextCampaignPeriodBudget(123, {
    spendLimitKopecks: 250_000,
    startDate: "2026-11-01",
    endDate: "2026-11-14",
  });
  assert.equal(new URL(request.url).pathname, "/json/v501/campaigns");
  assert.equal(request.body.method, "update");
  assert.deepEqual(request.body.params.Campaigns, [
    {
      Id: 123,
      TextCampaign: {
        BiddingStrategy: {
          Search: {
            BiddingStrategyType: "WB_MAXIMUM_CLICKS",
            WbMaximumClicks: {
              CustomPeriodBudget: {
                SpendLimit: 2_500_000_000,
                StartDate: "2026-11-01",
                EndDate: "2026-11-14",
                AutoContinue: "NO",
              },
            },
          },
          Network: { BiddingStrategyType: "SERVING_OFF" },
        },
      },
    },
  ]);
});

test("Direct marking read requests tax and advertiser fields without a write", async () => {
  let request;
  const client = new DirectClient({
    accessToken: "test-token",
    login: "test-login",
    fetcher: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return Response.json({ result: { Clients: [{}] } });
    },
  });
  await client.advertiserMarkingDetails();
  assert.equal(new URL(request.url).pathname, "/json/v501/clients");
  assert.equal(request.body.method, "get");
  assert.deepEqual(request.body.params.TinInfoFieldNames, ["TinType", "Tin"]);
  assert.deepEqual(request.body.params.OrganizationFieldNames, ["Name"]);
});

test("Direct moderation adapter sends only the saved ad IDs", async () => {
  let request;
  const client = new DirectClient({
    accessToken: "test-token",
    login: "test-login",
    fetcher: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return Response.json({ result: { ModerateResults: [{ Id: 401 }] } });
    },
  });
  await client.moderateAds([401]);
  assert.equal(new URL(request.url).pathname, "/json/v501/ads");
  assert.equal(request.body.method, "moderate");
  assert.deepEqual(request.body.params.SelectionCriteria.Ids, [401]);
});

test("Metrica statistics encodes counter, goal and full accuracy", async () => {
  let captured;
  const client = new MetricaClient("token", async (url, options) => {
    captured = { url: new URL(url), options };
    return Response.json({ totals: [10, 2] });
  });
  await client.statistics("123", "456", "2026-10-01", "2026-10-25");
  assert.equal(captured.url.pathname, "/stat/v1/data");
  assert.equal(captured.url.searchParams.get("ids"), "123");
  assert.equal(
    captured.url.searchParams.get("metrics"),
    "ym:s:visits,ym:s:goal456reaches",
  );
  assert.equal(captured.url.searchParams.get("accuracy"), "full");
  assert.equal(captured.options.headers.Authorization, "OAuth token");
});

test("Metrica campaign statistics filters an exact Direct campaign", async () => {
  let captured;
  const client = new MetricaClient("token", async (url) => {
    captured = new URL(url);
    return Response.json({ totals: [8, 2], sampled: false });
  });
  await client.campaignStatistics(
    "123",
    "456",
    715574939,
    "2026-11-01",
    "2026-11-14",
  );
  assert.equal(captured.searchParams.get("attribution"), "lastsign");
  assert.equal(
    captured.searchParams.get("filters"),
    "ym:s:lastsignDirectClickOrder==715574939",
  );
  assert.equal(captured.searchParams.get("accuracy"), "full");
});

test("Yandex disconnect sends token only in form body and client credentials in Basic auth", async () => {
  let captured;
  const result = await revokeYandexToken(
    "access-secret",
    "client-id",
    "client-secret",
    async (url, options) => {
      captured = { url, options };
      return Response.json({ status: "ok" });
    },
  );
  assert.equal(result.status, "ok");
  assert.equal(captured.url, "https://oauth.yandex.ru/revoke_token");
  assert.equal(
    new URLSearchParams(captured.options.body).get("access_token"),
    "access-secret",
  );
  assert.equal(
    captured.options.headers.Authorization,
    "Basic " + Buffer.from("client-id:client-secret").toString("base64"),
  );
});

test("Yandex refresh rotates tokens through Basic auth without exposing credentials in URL", async () => {
  let captured;
  const result = await refreshYandexToken(
    "refresh-secret",
    "client-id",
    "client-secret",
    async (url, options) => {
      captured = { url, options };
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "bearer",
      });
    },
  );
  assert.equal(captured.url, "https://oauth.yandex.ru/token");
  assert.equal(captured.options.method, "POST");
  assert.equal(
    captured.options.headers.Authorization,
    `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
  );
  assert.equal(
    new URLSearchParams(captured.options.body).get("grant_type"),
    "refresh_token",
  );
  assert.equal(
    new URLSearchParams(captured.options.body).get("refresh_token"),
    "refresh-secret",
  );
  assert.equal(captured.url.includes("refresh-secret"), false);
  assert.equal(result.access_token, "new-access");
});
