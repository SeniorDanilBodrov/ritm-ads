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
    throw new AppError(409, "Не выбран регион показа.", "reach_region_missing");
  return {
    channel: "search",
    ads: uniqueAds.size,
    keywords: uniqueKeywords.size,
    regions: uniqueRegions.size,
    ready: true,
  };
}

export function assertPostgresNetworkReach(plan) {
  if (!plan || typeof plan !== "object")
    throw new AppError(400, "План охвата не найден.", "reach_plan_missing");
  const ads = Array.isArray(plan.ads) ? plan.ads : [];
  const regions = Array.isArray(plan.regionIds) ? plan.regionIds : [];
  const titles = new Set(
    ads.flatMap((ad) => (ad?.titles || []).map(normalize)).filter(Boolean),
  );
  const texts = new Set(
    ads.flatMap((ad) => (ad?.texts || []).map(normalize)).filter(Boolean),
  );
  const images = new Set(
    ads.flatMap((ad) => ad?.adImageHashes || []).filter(Boolean),
  );
  const uniqueRegions = new Set(regions.filter(Number.isSafeInteger));
  if (titles.size < 3 || texts.size < 3)
    throw new AppError(
      409,
      "Для Рекламной сети согласуйте минимум три заголовка и три текста.",
      "reach_ads_missing",
    );
  if (!images.size)
    throw new AppError(
      409,
      "Для Рекламной сети выберите согласованное изображение.",
      "reach_images_missing",
    );
  if (!uniqueRegions.size)
    throw new AppError(409, "Не выбран регион показа.", "reach_region_missing");
  return {
    channel: "network",
    titles: titles.size,
    texts: texts.size,
    images: images.size,
    regions: uniqueRegions.size,
    ready: true,
  };
}

export function assertSupportedYandexChannel(channel) {
  if (!["search", "network"].includes(channel))
    throw new AppError(
      400,
      "Неизвестный рекламный канал.",
      "channel_unsupported",
    );
  return channel;
}
