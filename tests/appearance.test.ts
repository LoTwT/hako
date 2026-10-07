// 外观偏好（Paper / Ink）单测：本机记住选择，跟随系统不是第三种主题；
// 应用层只切换 <html> 的 .dark 类。window/document 以桩替换，不冒充浏览器。

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyAppearanceToDocument, useAppearance } from "../src/ui/appearance";

const storage = new Map<string, string>();
const darkClassState = { dark: false };
const matchMediaResults = { dark: false };

function installStubs() {
  storage.clear();
  darkClassState.dark = false;
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
    },
    matchMedia: (query: string) => ({ matches: query.includes("dark") && matchMediaResults.dark }),
  });
  vi.stubGlobal("document", {
    documentElement: { classList: { toggle: (_: string, value: boolean) => { darkClassState.dark = value; } } },
    querySelectorAll: () => [],
  });
}

beforeEach(installStubs);
afterEach(() => {
  vi.unstubAllGlobals();
});

it("默认跟随系统：系统浅色不加 .dark；系统深色加 .dark", () => {
  matchMediaResults.dark = false;
  useAppearance();
  expect(darkClassState.dark).toBe(false);
  matchMediaResults.dark = true;
  useAppearance();
  expect(darkClassState.dark).toBe(true);
});

it("手动选择浅色/深色：覆盖系统并写入本机存储", () => {
  matchMediaResults.dark = true;
  const appearance = useAppearance();
  appearance.setAppearance("light");
  expect(darkClassState.dark).toBe(false);
  expect(storage.get("hako:appearance")).toBe("light");
  appearance.setAppearance("dark");
  expect(darkClassState.dark).toBe(true);
  expect(storage.get("hako:appearance")).toBe("dark");
});

it("重开时读取本机选择：上次的手动选择优先于系统偏好", () => {
  matchMediaResults.dark = false;
  storage.set("hako:appearance", "dark");
  useAppearance();
  expect(darkClassState.dark).toBe(true);
});

it("非法存储值回退跟随系统；存储不可用时不抛错", () => {
  storage.set("hako:appearance", "brutal");
  matchMediaResults.dark = true;
  useAppearance();
  expect(darkClassState.dark).toBe(true);
  applyAppearanceToDocument("system");
  expect(darkClassState.dark).toBe(true);
});
