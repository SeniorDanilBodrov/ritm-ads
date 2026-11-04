import { AppError } from "./db.js";

const normalize = (value) =>
  String(value || "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/\s+/gu, " ");

// A broad-reach draft must contain genuinely different messages. Duplicating
// one text under several remote IDs does not create useful coverage or an A/B
// baseline and is therefore rejected before any Direct write.
export function assertPostgresSearchReach(plan) {
  if (!plan || typeof plan !== "object")
    throw new AppError(400, "План охвата не найден.", "reach_plan_missing");
  const ads = Array.isArray(plan.ads) ? plan.ads : [];
  const keywords = Array.isArray(plan.keywords) ? plan.keywords : [];
  const regions = Array.isArray(plan.regionIds) ? plan.regionIds : [];
  const uniqueAds = new Set(
    ads.map((ad) => `${normalize(ad?.title)}\n${normalize(ad?.text)}`),
  );
  const uniqueKeywords = new Set(keywords.map(normalize));
  const uniqueRegions = new Set(regions.filter(Number.isSafeInteger));
  if (ads.length < 3 || uniqueAds.size < 3)
    throw new AppError(
      409,
      "Для широкого охвата согласуйте три разных объявления.",
      "reach_ads_missing",
    );
  if (keywords.length < 3 || uniqueKeywords.size < 3)
    throw new AppError(
      409,
      "Для запуска нужны минимум три разные поисковые фразы.",
      "reach_keywords_missing",
    );
  if (!uniqueRegions.size)
    throw new AppError(
      409,
      "Не выбран регион показа.",
      "reach_region_missing",
    );
  return {
    channel: "search",
    ads: uniqueAds.size,
    keywords: uniqueKeywords.size,
    regions: uniqueRegions.size,
    ready: true,
  };
}

// Network traffic has materially different inventory and must not silently
// share a search-only strategy. This explicit guard keeps the budget closed
// until a separate network campaign and its own read-back are implemented.
export function assertSupportedYandexChannel(channel) {
  if (channel !== "search")
    throw new AppError(
      409,
      "Показы в сетях требуют отдельной кампании и отдельного лимита. Этот канал пока не подготовлен к безопасному запуску.",
      "network_channel_not_ready",
    );
  return channel;
}
