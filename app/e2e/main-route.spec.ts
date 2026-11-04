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
