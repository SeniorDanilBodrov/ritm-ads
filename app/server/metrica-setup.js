import { AppError } from "./db.js";

function host(value) {
  if (!value) return "";
  try {
    const url = new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`,
    );
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function actionEvent(goal) {
  if (String(goal?.type || "").toLowerCase() !== "action") return null;
  const condition = (goal.conditions || []).find(
    (item) => item && typeof item.url === "string" && item.url.trim(),
  );
  return condition?.url.trim() || null;
}

function javascriptString(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function installCode(counterId) {
  return `<script type="text/javascript">
  (function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
  m[i].l=1*new Date();
  for (var j=0;j<document.scripts.length;j++){if(document.scripts[j].src===r){return;}}
  k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
  (window,document,"script","https://mc.yandex.ru/metrika/tag.js","ym");
  ym(${counterId},"init",{clickmap:true,trackLinks:true,accurateTrackBounce:true,webvisor:true});
</script>
<noscript><div><img src="https://mc.yandex.ru/watch/${counterId}" style="position:absolute;left:-9999px" alt="" /></div></noscript>`;
}

export function buildMetricaSetup({ counter, goal, website = "" }) {
  if (!counter || !goal)
    throw new AppError(404, "Счетчик или цель Метрики больше не доступны.");
  const counterId = String(counter.id || "");
  if (!/^\d+$/.test(counterId))
    throw new AppError(502, "Метрика вернула некорректный ID счетчика.");
  const eventName = actionEvent(goal);
  const configuredSites = [counter.site, ...(counter.mirrors || [])]
      .filter(Boolean)
      .map(String),
    expectedHost = host(website),
    configuredHosts = configuredSites.map(host).filter(Boolean),
    siteMatches =
      !expectedHost ||
      !configuredHosts.length ||
      configuredHosts.includes(expectedHost);
  const checks = [
    {
      code: "counter_access",
      status: "ok",
      message: `Счетчик ${counterId} доступен через подключенный аккаунт.`,
    },
    {
      code: "goal_access",
      status: "ok",
      message: `Цель «${goal.name || goal.id}» найдена в этом счетчике.`,
    },
    {
      code: "site_match",
      status: siteMatches ? "ok" : "warning",
      message: siteMatches
        ? expectedHost
          ? `Домен ${expectedHost} совпадает с настройками счетчика.`
          : "Адрес сайта в профиле не указан — домен нужно проверить вручную."
        : `В счетчике указан другой домен: ${configuredHosts.join(", ")}.`,
    },
    {
      code: "action_goal",
      status: eventName ? "ok" : "warning",
      message: eventName
        ? `Для цели используется JavaScript-событие «${eventName}».`
        : "Выбранная цель не является JavaScript-событием. Проверьте её условие в Метрике.",
    },
  ];
  return {
    counter: {
      id: counterId,
      name: counter.name || `Счетчик ${counterId}`,
      sites: configuredSites,
    },
    goal: {
      id: String(goal.id),
      name: goal.name || `Цель ${goal.id}`,
      type: goal.type || "unknown",
      eventName,
    },
    installation: {
      counterCode: installCode(counterId),
      goalCall: eventName
        ? `ym(${counterId}, "reachGoal", ${javascriptString(eventName)});`
        : null,
      placement:
        "Вставьте код счетчика в <head> на всех страницах сайта. Вызов цели добавьте только после успешной отправки формы или подтвержденного обращения.",
    },
    checks,
    ready: checks.every((item) => item.status === "ok"),
  };
}
