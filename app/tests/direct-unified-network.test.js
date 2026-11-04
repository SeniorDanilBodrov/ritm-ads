import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  buildUnifiedNetworkCommands,
  reconcileUnifiedNetworkObjects,
  unifiedNetworkPlanSchema,
} from "../server/direct-unified-network.js";
import { executeDirectCommands } from "../server/direct.js";
import { evaluateDirectPreflight } from "../server/direct.js";

function plan() {
  return {
    channel: "network",
    login: "studio-owner",
    campaignName: "Форма · Рекламная сеть",
    website: "https://example.test/book",
    audience: "Женщины 25–40 лет",
    regionIds: [54],
    budget: 900_000,
    periodStart: "2026-11-10",
    periodEnd: "2026-11-30",
    counterId: "113772654",
    ads: [
      {
        titles: ["Маникюр с покрытием рядом", "Удобная запись онлайн"],
        texts: ["Бережный уход и аккуратное покрытие в студии «Форма»."],
        href: "https://example.test/book",
        adImageHashes: ["approved_image_hash-1"],
      },
    ],
  };
}

test("network builder creates a held UnifiedCampaign with its own cap", () => {
  const input = plan();
  const built = buildUnifiedNetworkCommands(input);
  assert.equal(built.schema, "direct/unified-network-plan@1");
  assert.deepEqual(
    built.commands.map(({ key, service, method }) => [key, service, method]),
    [
      ["campaign", "campaigns", "add"],
      ["suspend", "campaigns", "suspend"],
      ["adgroup", "adgroups", "add"],
      ["ads", "ads", "add"],
    ],
  );

  const campaign = built.commands[0].params.Campaigns[0];
  assert.equal(
    campaign.UnifiedCampaign.BiddingStrategy.Search.BiddingStrategyType,
    "SERVING_OFF",
  );
  assert.deepEqual(campaign.UnifiedCampaign.BiddingStrategy.Network, {
    BiddingStrategyType: "WB_MAXIMUM_CLICKS",
    PlacementTypes: { Network: "YES", Maps: "NO" },
    WbMaximumClicks: {
      CustomPeriodBudget: {
        SpendLimit: input.budget * 10_000,
        StartDate: input.periodStart,
        EndDate: input.periodEnd,
        AutoContinue: "NO",
      },
    },
  });
  assert.deepEqual(campaign.UnifiedCampaign.CounterIds.Items, [113772654]);
  assert.equal("TextCampaign" in campaign, false);
  assert.deepEqual(built.commands[1].params.SelectionCriteria.Ids, [
    { $ref: "campaign.Id" },
  ]);
  assert.equal(built.summary.externalCalls, 0);
  assert.ok(
    built.commands.every((command) =>
      /^[a-f0-9]{64}$/.test(command.fingerprint),
    ),
  );
});

test("network plan keeps multiple selected creative images", () => {
  const creativeAssetIds = [randomUUID(), randomUUID()];
  const built = buildUnifiedNetworkCommands({ ...plan(), creativeAssetIds });
  assert.deepEqual(built.plan.creativeAssetIds, creativeAssetIds);
});

test("network builder creates UnifiedAdGroup and ResponsiveAd only", () => {
  const input = plan();
  const built = buildUnifiedNetworkCommands(input);
  const group = built.commands[2].params.AdGroups[0];
  const ad = built.commands[3].params.Ads[0];

  assert.deepEqual(group.CampaignId, { $ref: "campaign.Id" });
  assert.deepEqual(group.UnifiedAdGroup, { OfferRetargeting: "NO" });
  assert.deepEqual(ad.AdGroupId, { $ref: "adgroup.Id" });
  assert.deepEqual(ad.ResponsiveAd, {
    Titles: input.ads[0].titles,
    Texts: input.ads[0].texts,
    Href: input.ads[0].href,
    AdImageHashes: input.ads[0].adImageHashes,
  });
  assert.equal("TextAd" in ad, false);
  assert.equal(
    built.commands.some((command) => command.key === "keywords"),
    false,
  );
});

test("network command fingerprints are deterministic and content-bound", () => {
  const first = buildUnifiedNetworkCommands(plan());
  const second = buildUnifiedNetworkCommands(plan());
  const changed = buildUnifiedNetworkCommands({ ...plan(), budget: 800_000 });

  assert.deepEqual(
    first.commands.map((command) => command.fingerprint),
    second.commands.map((command) => command.fingerprint),
  );
  assert.notEqual(
    first.commands[0].fingerprint,
    changed.commands[0].fingerprint,
  );
  assert.deepEqual(
    first.commands.slice(1).map((command) => command.fingerprint),
    changed.commands.slice(1).map((command) => command.fingerprint),
  );
});

test("network schema rejects unsafe or incomplete plans", () => {
  assert.throws(() =>
    unifiedNetworkPlanSchema.parse({ ...plan(), channel: "search" }),
  );
  assert.throws(() =>
    unifiedNetworkPlanSchema.parse({
      ...plan(),
      website: "javascript:alert(1)",
    }),
  );
  assert.throws(() =>
    unifiedNetworkPlanSchema.parse({
      ...plan(),
      periodStart: "2026-12-01",
      periodEnd: "2026-11-30",
    }),
  );
  assert.throws(() =>
    unifiedNetworkPlanSchema.parse({
      ...plan(),
      ads: [{ ...plan().ads[0], adImageHashes: [] }],
    }),
  );
  assert.throws(() =>
    unifiedNetworkPlanSchema.parse({
      ...plan(),
      ads: [{ ...plan().ads[0], titles: Array(8).fill("Заголовок") }],
    }),
  );
});

test("network command chain creates only a held unified campaign and responsive ad", async () => {
  const built = buildUnifiedNetworkCommands(plan());
  const writes = [];
  const client = {
    createCampaigns: async (items) => {
      writes.push(["campaign", items]);
      return { AddResults: [{ Id: 101 }] };
    },
    suspendCampaigns: async () => {
      throw new Error("OFF/DRAFT campaign must not be suspended again");
    },
    createAdGroups: async (items) => {
      writes.push(["adgroup", items]);
      return { AddResults: [{ Id: 202 }] };
    },
    createAds: async (items) => {
      writes.push(["ads", items]);
      return { AddResults: [{ Id: 303 }] };
    },
    campaignsByIds: async () => ({
      Campaigns: [
        {
          Id: 101,
          Type: "UNIFIED_CAMPAIGN",
          State: "OFF",
          Status: "DRAFT",
        },
      ],
    }),
  };
  const result = await executeDirectCommands(client, built.commands);
  assert.deepEqual(
    writes.map(([kind]) => kind),
    ["campaign", "adgroup", "ads"],
  );
  assert.deepEqual(
    writes[2][1][0].ResponsiveAd,
    built.commands[3].params.Ads[0].ResponsiveAd,
  );
  assert.deepEqual(
    result.calls.map((item) => item.key),
    ["campaign", "suspend", "adgroup", "ads"],
  );
  assert.equal(result.reconciliation.matched, true);
});

test("network read-back verifies the responsive image hashes", async () => {
  const input = plan();
  const calls = [
    { key: "campaign", ids: [101] },
    { key: "suspend", ids: [101], holdState: "OFF_DRAFT" },
    { key: "adgroup", ids: [202] },
    { key: "ads", ids: ["1926092011397773491"] },
  ];
  const client = {
    campaignsByIds: async () => ({
      Campaigns: [
        {
          Id: 101,
          Type: "UNIFIED_CAMPAIGN",
          State: "OFF",
          Status: "DRAFT",
        },
      ],
    }),
    adGroupsByIds: async () => ({
      AdGroups: [{ Id: 202, CampaignId: 101 }],
    }),
    adsByIds: async () => ({
      Ads: [
        {
          Id: "1926092011397773491",
          AdGroupId: 202,
          ResponsiveAd: {
            AdImages: {
              Items: [
                {
                  ImageHash: input.ads[0].adImageHashes[0],
                  Status: "UNKNOWN",
                  StatusClarification: null,
                },
              ],
            },
          },
        },
      ],
    }),
  };
  const result = await reconcileUnifiedNetworkObjects(client, calls, input);
  assert.equal(result.status, "matched");
  assert.equal(result.matched, true);
});

test("network preflight verifies its independent cap and disabled search", () => {
  const input = { ...plan(), goalId: "991" };
  const built = buildUnifiedNetworkCommands(input);
  const report = evaluateDirectPreflight(
    {
      state: {
        mode: "live",
        landingMode: "website",
        website: input.website,
        counterId: input.counterId,
        goalId: input.goalId,
      },
    },
    {
      id: "network-change",
      mode: "dry_run",
      status: "succeeded",
      plan: built.plan,
      commands: built.commands,
      reconciliation: { status: "prepared" },
    },
    {
      clients: [{ Login: input.login, Currency: "RUB", ClientId: 12 }],
      campaigns: [],
      connectionId: "connection",
      now: Date.parse("2026-11-05T00:00:00Z"),
    },
  );
  assert.equal(report.ready, true);
  assert.equal(report.plan.channel, "network");
  assert.equal(report.plan.keywords, 0);
  assert.deepEqual(report.findings, []);
});
