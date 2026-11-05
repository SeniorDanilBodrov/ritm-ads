import { expect, test, type Page } from "@playwright/test";

async function openDemo(page: Page) {
  await page.addInitScript(() => localStorage.setItem("ritm-theme", "dark"));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Ваш бизнес —/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Посмотреть демо/ }).click();
  const onboarding = page.getByRole("dialog", {
    name: "Познакомьтесь с Ритой",
  });
  await expect(onboarding).toBeVisible();
  await onboarding.getByRole("button", { name: "Закрыть окно" }).click();
  await expect(
    page.getByRole("region", { name: "Реклама привела 56 обращений" }),
  ).toBeVisible();
}

function shortRevision(value: string) {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619);
  }
  return (result >>> 0).toString(36);
}

function currentSearchCampaignName(
  businessName: string,
  imageIds: string[],
  creatives: Array<{ id: string; title: string; text: string }>,
) {
  const revision = shortRevision(
    JSON.stringify({
      images: [...imageIds].sort(),
      texts: creatives.map(({ id, title, text }) => ({ id, title, text })),
    }),
  );
  return `${businessName} · Поиск · версия ${revision} · 3`;
}

async function mockApprovedAdPreview(
  page: Page,
  {
    inDirect = true,
    duplicateBlocked = false,
    withoutImages = false,
  }: {
    inDirect?: boolean;
    duplicateBlocked?: boolean;
    withoutImages?: boolean;
  } = {},
) {
  const approvedAt = "2026-11-04T10:00:00.000Z";
  const image = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">
      <rect width="800" height="500" fill="#dce9df"/>
      <circle cx="610" cy="125" r="92" fill="#99b7a0"/>
      <path d="M0 420C190 315 332 480 520 345S720 260 800 300V500H0Z" fill="#4f755d"/>
    </svg>
  `);

  await page.route("**/api/workspace?*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.capabilities.postgresPilot = true;
    data.capabilities.directImageUploadPilot = true;
    data.state.website = "https://forma.example";
    data.state.postgresPilot = { planConfirmedAt: approvedAt };
    data.connections = [
      ...data.connections.filter(
        (connection: { provider: string }) => connection.provider !== "yandex",
      ),
      {
        provider: "yandex",
        connectedAt: approvedAt,
        sandbox: false,
        validation: "verified",
        clients: [{ Login: "e2e-direct", ClientId: 101, Currency: "RUB" }],
      },
    ];
    data.state.aiPlan = {
      provider: "fallback",
      model: "e2e-plan",
      promptVersion: "e2e-v1",
      inputHash: "approved-materials-e2e",
      validation: { status: "passed", schema: "e2e" },
      corrections: [],
      createdAt: approvedAt,
      version: "1",
      plan: {
        summary:
          "Покажем рекламу людям в Екатеринбурге, которым нужен маникюр с покрытием.",
        audiences: [
          { name: "Ищут маникюр рядом", need: "Записаться на удобное время" },
        ],
        channels: withoutImages ? ["search", "network"] : ["search"],
        keywords: ["маникюр с покрытием екатеринбург"],
        negativeKeywords: [],
        ads: [],
        budgetAllocation: withoutImages
          ? [
              { channel: "search", percent: 65 },
              { channel: "network", percent: 35 },
            ]
          : [{ channel: "search", percent: 100 }],
        abHypotheses: [],
        assumptions: [],
        warnings: [],
      },
    };
    data.state.creatives = [
      {
        id: "creative-1",
        angle: "Близость",
        title: "Маникюр с покрытием рядом с домом",
        text: "Бережный уход и удобная запись на подходящее время.",
        status: "approved",
        kind: "text",
        color: "sage",
      },
      {
        id: "creative-2",
        angle: "Забота",
        title: "Время для себя в студии «Форма»",
        text: "Спокойный маникюр с покрытием в Екатеринбурге.",
        status: "approved",
        kind: "text",
        color: "sand",
      },
      {
        id: "creative-3",
        angle: "Запись",
        title: "Выберите удобное время для маникюра",
        text: "Онлайн-запись и бережный уход без лишней спешки.",
        status: "approved",
        kind: "text",
        color: "mist",
      },
    ];
    data.creativeImages = [
      {
        id: "image-1",
        status: "succeeded",
        attempts: 1,
        prompt: "Спокойная студия маникюра",
        style: "local",
        goal: "leads",
        hook: "human",
        format: "wide",
        audience: "Жители Екатеринбурга",
        companyName: "Форма",
        brandPlacement: "bottom-right",
        seed: 42,
        provider: "kie",
        model: "gpt-image-1",
        mimeType: "image/png",
        byteSize: 2048,
        sha256: "e2e-approved-image",
        approvedAt,
        error: null,
        createdAt: approvedAt,
        updatedAt: approvedAt,
        imageUrl: `data:image/svg+xml,${image}`,
        width: 1080,
        height: 1080,
        ratio: "1:1",
        directUploads: inDirect
          ? [
              {
                login:
                  data.connections.find(
                    (connection: { provider: string }) =>
                      connection.provider === "yandex",
                  )?.clients?.[0]?.Login || "demo-direct",
                imageType: "REGULAR",
                verifiedAt: approvedAt,
              },
            ]
          : [],
      },
    ];
    data.directChanges = [
      {
        id: "direct-change-1",
        mode: "dry_run",
        status: "completed",
        attempts: 1,
        availableAt: 0,
        plan: {
          channel: "search",
          login: data.connections.find(
            (connection: { provider: string }) =>
              connection.provider === "yandex",
          )?.clients?.[0]?.Login,
          campaignName: duplicateBlocked
            ? "Форма · Поиск"
            : currentSearchCampaignName(
                data.state.name,
                ["image-1"],
                data.state.creatives,
              ),
          website: data.state.website,
          audience: "Ищут маникюр рядом",
          regionIds: [54],
          budget: data.state.budget,
          targetCpa: data.state.targetCpa,
          periodStart: data.state.periodStart,
          periodEnd: data.state.periodEnd,
          creativeAssetId: "image-1",
          ads: data.state.creatives.map(
            (creative: { title: string; text: string }) => ({
              title: creative.title.slice(0, 56),
              text: creative.text.slice(0, 81),
              href: data.state.website,
            }),
          ),
          keywords: ["маникюр с покрытием екатеринбург"],
          negativeKeywords: [],
        },
        commands: [],
        summary: {
          campaigns: 1,
          adGroups: 1,
          ads: 3,
          keywords: 1,
          externalCalls: 5,
        },
        reconciliation: null,
        error: null,
        createdAt: approvedAt,
        updatedAt: approvedAt,
        execution: {
          status: "succeeded",
          inflightKey: null,
          suspendVerified: true,
          calls: [],
          errorCode: null,
          updatedAt: approvedAt,
          reconciliation: {
            status: "matched",
            checkedAt: approvedAt,
            unresolvedStep: null,
          },
        },
      },
    ];
    if (withoutImages) {
      data.creativeImages = [];
      data.directChanges = [];
    }
    if (duplicateBlocked) {
      data.directChanges[0].execution = null;
      data.directChanges[0].preflight = {
        ready: false,
        findings: [
          {
            severity: "blocker",
            code: "duplicate_campaign",
            message:
              "В рекламном кабинете уже есть кампания с таким названием.",
          },
        ],
      };
    }
    await route.fulfill({ response, json: data });
  });

  await page.route("**/api/businesses/*/launch-readiness", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ready: true,
        status: "ready_for_review",
        title: "План готов к проверке",
        detail: "Материалы согласованы.",
        blockers: [],
      }),
    });
  });
}

test("главный демо-маршрут открывает итоги, график и дерево рекламы", async ({
  page,
}) => {
  await openDemo(page);

  await expect(
    page.getByRole("heading", { name: "Обращения по дням" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Дерево рекламы" }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "Вид графика" })).toBeVisible();

  await page.getByRole("button", { name: /Столбцы/ }).click();
  await expect(page.getByRole("button", { name: /Столбцы/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const layout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(layout.document).toBeLessThanOrEqual(layout.viewport + 1);
});

test("мобильная навигация не перекрывает контент и сохраняет спокойный фон", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-android", "Мобильная регрессия");
  await openDemo(page);

  const navigation = page.getByRole("navigation", {
    name: "Мобильная навигация",
  });
  await expect(navigation).toBeVisible();
  await expect(
    navigation.getByRole("button", { name: "Итоги" }),
  ).toHaveAttribute("aria-current", "page");

  const navStyle = await navigation.evaluate((element) => {
    const selected = element.querySelector<HTMLElement>(
      'button[aria-current="page"]',
    );
    const navigationStyle = getComputedStyle(element);
    const selectedStyle = selected ? getComputedStyle(selected) : null;
    return {
      navBackground: navigationStyle.backgroundColor,
      selectedBackground: selectedStyle?.backgroundColor || "",
      selectedColor: selectedStyle?.color || "",
    };
  });
  expect(navStyle.navBackground).not.toBe("rgb(255, 255, 255)");
  expect(navStyle.selectedBackground).not.toBe("rgb(255, 255, 255)");
  expect(navStyle.selectedColor).not.toBe("rgb(255, 255, 255)");

  const trend = page.locator(".dispatcher-trend");
  await trend.scrollIntoViewIfNeeded();
  await expect(trend).toBeInViewport();
  await expect(trend).toHaveScreenshot("mobile-trend-dark.png", {
    animations: "disabled",
  });

  const tree = page.locator(".dispatcher-actions");
  await tree.scrollIntoViewIfNeeded();
  await expect(tree).toBeInViewport();
  await expect(tree).toHaveScreenshot("mobile-tree-dark.png", {
    animations: "disabled",
  });

  const bottomPadding = await page
    .locator("main.page")
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingBottom),
    );
  const navigationHeight = await navigation.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(bottomPadding).toBeGreaterThanOrEqual(navigationHeight);
});

test("мобильное меню ведёт к бизнесу, странице и плану", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-android", "Мобильный маршрут");
  await openDemo(page);
  const navigation = page.getByRole("navigation", {
    name: "Мобильная навигация",
  });

  await navigation.getByRole("button", { name: "О бизнесе" }).click();
  await expect(page.getByRole("heading", { name: "О бизнесе" })).toBeVisible();

  await navigation.getByRole("button", { name: "Страница" }).click();
  await expect(
    page.getByRole("heading", { name: /Страница и Директ/ }),
  ).toBeVisible();

  await navigation.getByRole("button", { name: "План и запуск" }).click();
  await expect(
    page.getByRole("heading", { name: "План и запуск" }),
  ).toBeVisible();
});

test("страница Яндекса показывает источник обращений без Метрики", async ({
  page,
}) => {
  await openDemo(page);
  await page.route("**/api/workspace?*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.state.mode = "live";
    data.state.landingMode = "yandex_landing";
    data.state.website = "https://forma.clients.site/";
    delete data.state.counterId;
    delete data.state.goalId;
    data.connections = [
      {
        provider: "yandex",
        connectedAt: "2026-11-05T09:00:00.000Z",
        sandbox: false,
        validation: "verified",
        clients: [{ Login: "e2e-direct", ClientId: 101, Currency: "RUB" }],
      },
    ];
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await page
    .getByRole("button", { name: /^Страница(?: и Директ)?$/ })
    .first()
    .click();

  await expect(
    page.getByText("Обращения подключены без Метрики", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Источник — показатель «Конверсии» в отчёте Директа/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Найти сайт в Метрике" }),
  ).toHaveCount(0);
});

test("согласованные текст и изображение заменяют пустую рамку готовым объявлением", async ({
  page,
}) => {
  await openDemo(page);
  await mockApprovedAdPreview(page);
  await page.reload();

  await page
    .getByRole("button", { name: "План и запуск", exact: true })
    .first()
    .click();

  const preview = page.getByRole("region", {
    name: /Готовое объявление перед модерацией|Так будет выглядеть ваша реклама/,
  });
  await expect(preview).toBeVisible();
  await expect(
    preview.getByRole("img", { name: /Согласованное изображение/ }),
  ).toBeVisible();
  await expect(
    preview.getByRole("heading", {
      name: "Маникюр с покрытием рядом с домом",
    }),
  ).toBeVisible();
  await expect(preview).toContainText(
    "Бережный уход и удобная запись на подходящее время.",
  );
  await expect(preview).toContainText("https://forma.example");
  await expect(preview).toContainText("Объявление добавлено в Яндекс Директ");
  await expect(preview).toContainText("Показы не идут");
  await expect(
    page.getByText("Выберите изображение для рекламы", { exact: true }),
  ).toHaveCount(0);
  await expect(preview).toContainText("Фото загружено");

  const layout = await preview.evaluate((element) => ({
    right: element.getBoundingClientRect().right,
    viewport: document.documentElement.clientWidth,
  }));
  expect(layout.right).toBeLessThanOrEqual(layout.viewport + 1);
});

test("поисковое объявление можно подготовить без генерации изображения", async ({
  page,
}) => {
  await openDemo(page);
  await mockApprovedAdPreview(page, { withoutImages: true });

  const preparedPlans: Record<string, unknown>[] = [];
  await page.route("**/api/businesses/*/direct/dry-run", async (route) => {
    preparedPlans.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ status: "queued" }),
    });
  });
  await page.reload();

  await page
    .getByRole("button", { name: "План и запуск", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: /Продолжить без изображения/ })
    .click();

  await expect(
    page.getByText("Текстовые объявления без изображения", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Подготовить именно эти материалы" })
    .click();

  await expect.poll(() => preparedPlans.length).toBe(1);
  expect(preparedPlans[0]).not.toHaveProperty("creativeAssetId");
  expect(preparedPlans[0]).not.toHaveProperty("creativeAssetIds");
  expect(preparedPlans[0]).not.toHaveProperty("channel", "network");
});

test("кнопка в готовом объявлении добавляет изображение в Директ без возврата к генерации", async ({
  page,
}) => {
  await openDemo(page);
  await mockApprovedAdPreview(page, { inDirect: false });

  let uploadPayload: Record<string, unknown> | null = null;
  await page.route(
    "**/api/businesses/*/creative-images/*/direct-upload",
    async (route) => {
      uploadPayload = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "succeeded" }),
      });
    },
  );
  await page.reload();

  await page
    .getByRole("button", { name: "План и запуск", exact: true })
    .first()
    .click();

  const preview = page.getByRole("region", {
    name: /Готовое объявление перед модерацией|Так будет выглядеть ваша реклама/,
  });
  await preview.getByRole("button", { name: /Добавить в Директ/ }).click();

  const confirmation = page.getByRole("dialog", {
    name: "Добавить изображение в Директ?",
  });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "Добавить в Директ", exact: true })
    .click();

  await expect.poll(() => uploadPayload).not.toBeNull();
  expect(uploadPayload).toMatchObject({
    login: "e2e-direct",
    uploadConfirmed: true,
  });
  await expect(preview).toBeVisible();
  await expect(
    page.getByText("Изображение добавлено в Директ. Показы не запущены."),
  ).toBeVisible();
});

test("обновлённый план с фотографией не повторяет имя старого черновика", async ({
  page,
}) => {
  await openDemo(page);
  await mockApprovedAdPreview(page, { duplicateBlocked: true });

  let preparedPlan: Record<string, unknown> | null = null;
  await page.route("**/api/businesses/*/direct/dry-run", async (route) => {
    preparedPlan = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "succeeded" }),
    });
  });
  await page.reload();

  await page
    .getByRole("button", { name: "План и запуск", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("В рекламном кабинете уже есть кампания с таким названием."),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Подготовить именно эти материалы" })
    .click();

  await expect.poll(() => preparedPlan).not.toBeNull();
  const campaignName = String(preparedPlan?.campaignName || "");
  expect(campaignName).toMatch(
    /^Студия «Форма» · Поиск · версия [a-z0-9]+ · 3$/,
  );
  expect(campaignName).not.toBe("Студия «Форма» · Поиск");
});
