import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssUrl = new URL("../src/styles-v2.css", import.meta.url);

function themeTokens(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Не найден блок темы ${selector}`);
  return Object.fromEntries(
    [...match[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(
      ([, name, value]) => [name, value],
    ),
  );
}

function luminance(hex) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    .map((part) => Number.parseInt(part, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("semantic text colours meet WCAG AA on both theme surfaces", async () => {
  const css = await readFile(cssUrl, "utf8");
  const light = themeTokens(css, ":root");
  const dark = themeTokens(css, ':root[data-theme="dark"]');

  for (const [name, tokens] of [
    ["light", light],
    ["dark", dark],
  ]) {
    const surfaces =
      name === "dark"
        ? ["canvas", "surface", "surface-elevated", "surface-muted"]
        : ["surface"];
    const textRoles =
      name === "dark"
        ? [
            "ink",
            "ink-soft",
            "muted",
            "brand",
            "success",
            "warning",
            "danger",
            "info",
          ]
        : ["ink", "ink-soft", "muted", "brand"];

    for (const surfaceRole of surfaces) {
      for (const textRole of textRoles) {
        const ratio = contrast(tokens[textRole], tokens[surfaceRole]);
        assert.ok(
          ratio >= 4.5,
          `${name}: --${textRole} on --${surfaceRole} has insufficient contrast ${ratio.toFixed(2)}:1`,
        );
      }
    }
    const actionRatio = contrast(tokens["on-brand"], tokens["brand-action"]);
    assert.ok(
      actionRatio >= 4.5,
      `${name}: action text has insufficient contrast ${actionRatio.toFixed(2)}:1`,
    );
  }
});

test("dark theme keeps surfaces calm while preserving readable hierarchy", async () => {
  const css = await readFile(cssUrl, "utf8");
  const dark = themeTokens(css, ':root[data-theme="dark"]');

  assert.ok(
    contrast(dark.canvas, dark.surface) < 1.2,
    "Dark canvas and cards should not form a glaring checkerboard",
  );
  assert.ok(
    contrast(dark.surface, dark["surface-elevated"]) < 1.2,
    "Elevated dark surfaces should remain visually restrained",
  );
  assert.ok(
    contrast(dark.ink, dark.surface) > contrast(dark.muted, dark.surface),
    "Primary and secondary copy must keep a visible hierarchy",
  );
});

test("legacy activity and campaign text is remapped to semantic roles", async () => {
  const css = await readFile(cssUrl, "utf8");

  assert.match(css, /\.recent-event b\s*\{[^}]*color:\s*var\(--ink\)/s);
  assert.match(
    css,
    /\.campaign-name b,[^}]*\.onboarding-summary strong\s*\{[^}]*color:\s*var\(--ink\)/s,
  );
  assert.match(
    css,
    /\.chart-key,[^}]*\.empty p\s*\{[^}]*color:\s*var\(--muted\)/s,
  );
  assert.match(css, /\.experiment-intro > div\s*\{[^}]*color:\s*var\(--ink\)/s);
});

test("dark adapter covers legacy light-only surfaces across routes", async () => {
  const css = await readFile(cssUrl, "utf8");

  assert.match(
    css,
    /:root\[data-theme="dark"\] \.sidebar nav button\s*\{[^}]*color:\s*var\(--ink-soft\)/s,
  );
  assert.match(
    css,
    /:root\[data-theme="dark"\] \.chart-key\s*\{[^}]*background:\s*var\(--surface-muted\)/s,
  );
  assert.match(
    css,
    /:root\[data-theme="dark"\] \.creative-generator\s*\{[^}]*var\(--surface\)/s,
  );
  assert.match(
    css,
    /:root\[data-theme="dark"\] \.diff-grid pre,[^}]*\.provider-result pre,[^}]*\.empty\s*\{[^}]*background:\s*var\(--surface-soft\)/s,
  );
  assert.match(
    css,
    /:root\[data-theme="dark"\] input,[^}]*:root\[data-theme="dark"\] option\s*\{[^}]*background:\s*var\(--surface\)/s,
  );
});

test("workspace search remains one seamless control in dark theme", async () => {
  const css = await readFile(cssUrl, "utf8");

  assert.match(
    css,
    /:root\[data-theme="dark"\] \.global-search input,[^}]*\.global-search input:focus\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
  );
});
