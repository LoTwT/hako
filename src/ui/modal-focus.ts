import { nextTick, shallowRef } from "vue";

/**
 * 模态层焦点管理（UI-R13）：打开时记录真实可聚焦的触发控件并聚焦层内首个
 * 目标；Tab/Shift+Tab 循环保持在层内（焦点陷阱）；关闭（Esc/按钮/遮罩/浏览器
 * 返回统一经上层还原）后把焦点还给触发点——触发点失效时才回退（默认当前页
 * 主标题）。重试以「层已关闭」为前提，避免迟到恢复抢走新层焦点。不依赖
 * aria-modal 本身；后台更新不应抢走焦点（初始聚焦只在打开时执行一次）。
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export function createModalFocus(options: {
  /** 关闭动作（导航/状态清理）；焦点还原因此延后到下一帧。 */
  close: () => void;
  /** 打开时的初始焦点目标；缺省聚焦层内第一个可聚焦元素。 */
  initialFocus?: () => HTMLElement | null;
  /** 触发点失效时的回退目标（默认当前页主标题）。 */
  fallbackFocus?: () => HTMLElement | null;
  /**
   * 关闭时是否由本模块还原焦点（默认 true）。置 false 时还原交由上层统一
   * 处理（例如关闭本身经路由/历史导航、需要以「层确实关闭」为前提的场景），
   * 上层在层关闭后调用 restoreFocus。
   */
  restoreOnClose?: boolean;
}) {
  const layerRoot = shallowRef<HTMLElement | null>(null);
  let opener: HTMLElement | null = null;

  function defaultFallback(): HTMLElement | null {
    if (typeof document === "undefined" || typeof document.querySelector !== "function") return null;
    return document.querySelector<HTMLElement>("h1[tabindex='-1']");
  }

  /**
   * 从事件目标解析真实可聚焦的触发控件（UI-R13）：点击按钮内的文字/图标时
   * event.target 是不可聚焦的 span/svg，向上取最近的可聚焦祖先；没有匹配
   * 祖先时退回当前 activeElement。
   */
  function resolveOpener(event: Event | undefined): HTMLElement | null {
    const elementGlobalsReady = typeof HTMLElement !== "undefined";
    if (!elementGlobalsReady || typeof document === "undefined") return null;
    const target = event?.target;
    if (target instanceof HTMLElement) {
      if (typeof target.closest === "function") {
        const focusable = target.closest<HTMLElement>(FOCUSABLE_SELECTOR);
        if (focusable !== null) return focusable;
      } else if (typeof target.matches !== "function" || target.matches(FOCUSABLE_SELECTOR)) {
        return target;
      }
    }
    return document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  /** 打开（或层挂载后）调用：记录触发点并聚焦初始目标。 */
  function focusOnOpen(event?: Event) {
    if (typeof document === "undefined") return;
    opener = resolveOpener(event);
    void nextTick(() => {
      const target = options.initialFocus?.() ?? firstFocusable();
      target?.focus?.({ preventScroll: true });
    });
  }

  function firstFocusable(): HTMLElement | null {
    if (layerRoot.value === null || typeof layerRoot.value.querySelectorAll !== "function") return null;
    return layerRoot.value.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
  }

  function lastFocusable(): HTMLElement | null {
    if (layerRoot.value === null || typeof layerRoot.value.querySelectorAll !== "function") return null;
    const items = [...layerRoot.value.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
    return items.at(-1) ?? null;
  }

  /**
   * 同一焦点停靠判定：单选组（同名 radio）在 Tab 序里是一个停靠点，组内任一
   * 成员聚焦时都视为该停靠（组内「最后一个成员」未必是 activeElement）。
   */
  function sameFocusStop(a: HTMLElement | null, b: HTMLElement | null): boolean {
    if (a === null || b === null) return false;
    if (a === b) return true;
    const radioGlobalsReady = typeof HTMLInputElement !== "undefined";
    const isRadio = (element: HTMLElement): element is HTMLInputElement =>
      radioGlobalsReady && element instanceof HTMLInputElement && element.type === "radio";
    return isRadio(a) && isRadio(b) && a.name === b.name;
  }

  /**
   * 聚焦并确认成功（隐藏元素 focus 会被浏览器忽略，activeElement 不变）。
   */
  function tryFocus(target: HTMLElement | null): boolean {
    if (target === null) return false;
    target.focus?.({ preventScroll: true });
    return typeof document !== "undefined" && document.activeElement === target;
  }

  /**
   * 焦点还原调度（UI-R13）：优先触发点；背景层经浏览器历史恢复可见是宏任务，
   * 微任务里触发点可能仍 display:none（focus 被忽略），下一宏任务重试一次；
   * 触发点已不在文档或重试仍失败时才回退到回退目标。每步以「层已关闭」
   * （layerRoot 为空）为前提，层被重新打开时不再触碰焦点。
   */
  function scheduleRestore(target: HTMLElement | null): void {
    void nextTick(() => {
      if (layerRoot.value !== null) return;
      if (target !== null && target.isConnected !== false && tryFocus(target)) return;
      const retry = (): void => {
        if (layerRoot.value !== null) return;
        if (target !== null && target.isConnected !== false && tryFocus(target)) return;
        const fallback = options.fallbackFocus?.() ?? defaultFallback();
        if (target === null || target.isConnected === false) tryFocus(fallback);
        else if (fallback !== null && fallback !== target) tryFocus(fallback);
      };
      if (typeof setTimeout === "function") setTimeout(retry, 0);
      else retry();
    });
  }

  /**
   * 还原焦点（不执行关闭动作）：供上层在层确实关闭后统一调用，覆盖 Esc、
   * 关闭按钮、遮罩与浏览器返回（历史导航）所有关闭路径。
   */
  function restoreFocus(): void {
    if (typeof document === "undefined") return;
    const target = opener;
    opener = null;
    scheduleRestore(target);
  }

  /**
   * 关闭：执行关闭动作（导航/状态清理）。默认按 restoreFocus 的同一策略还原
   * 焦点；restoreOnClose=false 时还原交由上层（如经历史导航关闭、需以层确实
   * 关闭为前提的场景），避免同一关闭被双重还原。
   */
  function focusOnClose() {
    if (options.restoreOnClose === false) {
      // 还原交由上层：触发点保留给其后的 restoreFocus（不在此时消费）。
      options.close();
      return;
    }
    const target = opener;
    opener = null;
    options.close();
    scheduleRestore(target);
  }

  /** 层内键盘处理：Esc 关闭；Tab 在层内循环，不允许落到背景内容。 */
  function onLayerKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      focusOnClose();
      return;
    }
    if (event.key !== "Tab" || layerRoot.value === null) return;
    const active = typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inside = active !== null && layerRoot.value.contains(active);
    if (event.shiftKey && (!inside || sameFocusStop(active, firstFocusable()))) {
      event.preventDefault();
      lastFocusable()?.focus();
    } else if (!inside || sameFocusStop(active, lastFocusable())) {
      event.preventDefault();
      firstFocusable()?.focus();
    }
  }

  return { layerRoot, focusOnOpen, focusOnClose, restoreFocus, onLayerKeydown };
}
