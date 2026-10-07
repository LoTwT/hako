import { readonly, shallowRef } from "vue";

/**
 * 外观偏好（Paper / Ink）：跟随系统 / 浅色 / 深色，仅记住本机选择。
 * 主题包 @ayingott/theme 以 `.dark` 类切换 Ink；跟随系统是一种选择方式，
 * 不是第三种主题。首帧防闪烁由 index.html 的引导脚本完成，这里接管
 * 后续变更与系统偏好监听。
 */
export type Appearance = "system" | "light" | "dark";

const appearanceStorageKey = "hako:appearance";

function readStoredAppearance(): Appearance {
  try {
    const value = window.localStorage.getItem(appearanceStorageKey);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 将当前偏好落到 <html> 的 .dark 类与 theme-color 元信息。 */
export function applyAppearanceToDocument(appearance: Appearance): void {
  const dark = appearance === "dark" || (appearance === "system" && systemPrefersDark());
  const root = document.documentElement as (HTMLElement & { classList?: { toggle(name: string, value: boolean): void } }) | undefined | null;
  root?.classList?.toggle?.("dark", dark);
  if (typeof document.querySelectorAll !== "function") return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const paper = meta.dataset.hakoPaper;
    const ink = meta.dataset.hakoInk;
    if (paper && ink) meta.content = dark ? ink : paper;
  }
}

export function useAppearance() {
  const appearance = shallowRef<Appearance>(readStoredAppearance());
  const systemDark = shallowRef(systemPrefersDark());
  applyAppearanceToDocument(appearance.value);

  function setAppearance(next: Appearance): void {
    appearance.value = next;
    try {
      window.localStorage.setItem(appearanceStorageKey, next);
    } catch {
      // 存储不可用时仍应用本次选择；刷新后回到跟随系统。
    }
    applyAppearanceToDocument(next);
  }

  const media = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  const onSystemChange = () => {
    systemDark.value = systemPrefersDark();
    if (appearance.value === "system") applyAppearanceToDocument("system");
  };
  media?.addEventListener?.("change", onSystemChange);

  return {
    appearance: readonly(appearance),
    systemDark: readonly(systemDark),
    setAppearance,
    dispose: () => media?.removeEventListener?.("change", onSystemChange),
  };
}
