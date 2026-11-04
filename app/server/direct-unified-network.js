import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "./db.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const httpUrl = z
  .string()
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const imageHash = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const unifiedNetworkPlanSchema = z
  .object({
    channel: z.literal("network"),
    login: z.string().trim().min(1).max(160),
    campaignName: z.string().trim().min(2).max(255),
    website: httpUrl,
    audience: z.string().trim().min(2).max(500),
    regionIds: z.array(z.number().int()).min(1).max(100),
    budget: z.number().int().positive().max(100_000_000),
    periodStart: isoDate,
    periodEnd: isoDate,
    counterId: z.string().regex(/^\d+$/).optional(),
    goalId: z.string().regex(/^\d+$/).optional(),
    creativeAssetId: z.string().uuid().optional(),
    ads: z
      .array(
        z
          .object({
            titles: z.array(z.string().trim().min(2).max(56)).min(1).max(7),
            texts: z.array(z.string().trim().min(2).max(81)).min(1).max(3),
            href: httpUrl,
            adImageHashes: z.array(imageHash).min(1).max(5),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .refine((value) => value.periodEnd >= value.periodStart, {
    path: ["periodEnd"],
    message: "Дата окончания раньше начала",
  });

const micros = (kopecks) => kopecks * 10_000;
const ref = (command, field) => ({ $ref: `${command}.${field}` });
const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function buildUnifiedNetworkCommands(input) {
  const plan = unifiedNetworkPlanSchema.parse(input);
  const commands = [
    {
      key: "campaign",
      service: "campaigns",
      method: "add",
      params: {
        Campaigns: [
          {
            Name: plan.campaignName,
            StartDate: plan.periodStart,
            EndDate: plan.periodEnd,
            UnifiedCampaign: {
              BiddingStrategy: {
                Search: { BiddingStrategyType: "SERVING_OFF" },
                Network: {
                  BiddingStrategyType: "WB_MAXIMUM_CLICKS",
                  PlacementTypes: { Network: "YES", Maps: "NO" },
                  WbMaximumClicks: {
                    CustomPeriodBudget: {
                      SpendLimit: micros(plan.budget),
                      StartDate: plan.periodStart,
                      EndDate: plan.periodEnd,
                      AutoContinue: "NO",
                    },
                  },
                },
              },
              Settings: [
                { Option: "ADD_METRICA_TAG", Value: "YES" },
                { Option: "ENABLE_SITE_MONITORING", Value: "YES" },
              ],
              ...(plan.counterId
                ? { CounterIds: { Items: [Number(plan.counterId)] } }
                : {}),
            },
          },
        ],
      },
    },
    {
      key: "suspend",
      service: "campaigns",
      method: "suspend",
      dependsOn: ["campaign"],
      params: { SelectionCriteria: { Ids: [ref("campaign", "Id")] } },
    },
    {
      key: "adgroup",
      service: "adgroups",
      method: "add",
      dependsOn: ["suspend"],
      params: {
        AdGroups: [
          {
            Name: `${plan.campaignName} · ${plan.audience}`.slice(0, 255),
            CampaignId: ref("campaign", "Id"),
            RegionIds: plan.regionIds,
            UnifiedAdGroup: { OfferRetargeting: "NO" },
          },
        ],
      },
    },
    {
      key: "ads",
      service: "ads",
      method: "add",
      dependsOn: ["adgroup"],
      params: {
        Ads: plan.ads.map((ad) => ({
          AdGroupId: ref("adgroup", "Id"),
          ResponsiveAd: {
            Titles: ad.titles,
            Texts: ad.texts,
            Href: ad.href,
            AdImageHashes: ad.adImageHashes,
          },
        })),
      },
    },
  ];

  return {
    schema: "direct/unified-network-plan@1",
    plan,
    commands: commands.map((command) => ({
      ...command,
      fingerprint: fingerprint(command),
    })),
    summary: {
      channel: "network",
      campaigns: 1,
      adGroups: 1,
      ads: plan.ads.length,
      externalCalls: 0,
    },
  };
}

const heldCampaign = (campaign) =>
  campaign?.State === "SUSPENDED" ||
  (campaign?.State === "OFF" && campaign?.Status === "DRAFT");

const responsiveImageHashes = (responsiveAd) => {
  const source = responsiveAd?.AdImages || responsiveAd?.AdImageHashes || [];
  const values = Array.isArray(source)
    ? source
    : Array.isArray(source?.Items)
      ? source.Items
      : [];
  return values
    .map((item) =>
      typeof item === "string"
        ? item
        : item?.ImageHash || item?.AdImageHash || item?.Hash,
    )
    .filter(Boolean);
};

export async function reconcileUnifiedNetworkObjects(
  client,
  calls,
  expectedPlan = null,
) {
  const ids = Object.fromEntries(calls.map((item) => [item.key, item.ids]));
  const campaignIds = ids.campaign || [];
  const adGroupIds = ids.adgroup || [];
  const adIds = ids.ads || [];
  if (!campaignIds.length || !adGroupIds.length || !adIds.length)
    throw new AppError(
      409,
      "Недостаточно внешних ID для полной сверки кампании в РСЯ.",
      "direct_reconciliation",
    );
  const [campaigns, adGroups, ads] = await Promise.all([
    client.campaignsByIds(campaignIds),
    client.adGroupsByIds(adGroupIds),
    client.adsByIds(adIds),
  ]);
  const campaignId = campaignIds[0];
  const adGroupId = adGroupIds[0];
  const remoteCampaigns = Array.isArray(campaigns?.Campaigns)
    ? campaigns.Campaigns
    : [];
  const remoteAdGroups = Array.isArray(adGroups?.AdGroups)
    ? adGroups.AdGroups
    : [];
  const remoteAds = Array.isArray(ads?.Ads) ? ads.Ads : [];
  const campaignMatched = remoteCampaigns.some(
    (item) =>
      String(item.Id) === String(campaignId) &&
      heldCampaign(item) &&
      (!item.Type || item.Type === "UNIFIED_CAMPAIGN"),
  );
  const groupMatched = remoteAdGroups.some(
    (item) =>
      String(item.Id) === String(adGroupId) &&
      String(item.CampaignId) === String(campaignId),
  );
  const adsMatched = adIds.every((id, index) => {
    const item = remoteAds.find(
      (candidate) =>
        String(candidate.Id) === String(id) &&
        String(candidate.AdGroupId) === String(adGroupId),
    );
    if (!item?.ResponsiveAd) return false;
    const expectedHashes = expectedPlan?.ads?.[index]?.adImageHashes || [];
    const remoteHashes = responsiveImageHashes(item.ResponsiveAd);
    return expectedHashes.every((hash) => remoteHashes.includes(hash));
  });
  const matched = !!campaignMatched && !!groupMatched && adsMatched;
  return {
    status: matched ? "matched" : "mismatch",
    matched,
    externalCalls: 3,
    objects: {
      campaign: remoteCampaigns,
      adGroups: remoteAdGroups,
      ads: remoteAds,
    },
  };
}
