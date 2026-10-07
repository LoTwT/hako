// 模态层焦点管理单元测试（UI-R13 回归，含第二轮修复）：createModalFocus 的
// 触发点解析与焦点陷阱/还原契约。用最小的 document/HTMLElement 假实现驱动：
// 按钮内文字 span 经 closest 解析到真实可聚焦按钮；Esc 关闭并还原触发点；
// 触发点失效时回退；层重开时迟到还原不抢焦点；restoreOnClose=false 时不重复
// 还原；Tab/Shift+Tab 在层内循环（首尾换行、层外焦点拉回层内）。不冒充真实
// 浏览器（无布局与真实焦点链）。

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createModalFocus } from "../src/ui/modal-focus";

class FakeElement {
  focusCalls = 0;
  closestResult: FakeElement | null = null;
  /** 自身即可聚焦（真实 DOM 中 button.matches(FOCUSABLE_SELECTOR) 为真）。 */
  focusableSelf = false;
  connected = true;
  constructor(private readonly descendants: FakeElement[] = []) {}
  get isConnected(): boolean {
    return this.connected;
  }
  contains(element: unknown): boolean {
    return this.descendants.includes(element as FakeElement);
  }
  focus(_options?: unknown): void {
    this.focusCalls += 1;
    if (typeof document !== "undefined" && document !== null) {
      (document as { activeElement: unknown }).activeElement = this;
    }
  }
  closest(_selector: string): FakeElement | null {
    return this.closestResult ?? (this.focusableSelf ? this : null);
  }
  matches(_selector: string): boolean {
    return false;
  }
  querySelector(_selector: string): FakeElement | null {
    return this.descendants[0] ?? null;
  }
  querySelectorAll(_selector: string): FakeElement[] {
    return this.descendants;
  }
}

const savedGlobals = { document: globalThis.document, HTMLElement: globalThis.HTMLElement };

/** 安装假 document（querySelector 供默认回退，activeElement 由 focus 更新）。 */
function installDocument(queryResult: FakeElement | null = null): { document: { querySelector: () => FakeElement | null; activeElement: unknown } } {
  const document = { querySelector: () => queryResult, activeElement: null as unknown };
  (globalThis as { document?: unknown }).document = document;
  return { document };
}

beforeEach(() => {
  // node 环境没有 DOM：注入与模块判断兼容的最小全局（HTMLElement 存在即启用 instanceof 分支）。
  (globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement as unknown as typeof HTMLElement;
});
afterEach(() => {
  (globalThis as { document?: unknown }).document = savedGlobals.document;
  (globalThis as { HTMLElement?: unknown }).HTMLElement = savedGlobals.HTMLElement;
});

/** 微任务（nextTick 还原调度）+ 宏任务（隐藏重试）都冲刷。 */
async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

it("UI-R13 打开记录触发点，聚焦层内首个可聚焦元素；Esc 关闭还原触发点", async () => {
  const { document } = installDocument();
  const first = new FakeElement();
  const second = new FakeElement();
  const root = new FakeElement([first, second]);
  const close = vi.fn();
  const focus = createModalFocus({ close });
  focus.layerRoot.value = root as unknown as HTMLElement;
  focus.layerRoot.value = root as unknown as HTMLElement;

  const opener = new FakeElement();
  opener.focusableSelf = true;
  focus.focusOnOpen({ target: opener } as unknown as Event);
  await settle();
  expect(first.focusCalls).toBe(1);
  expect(close).not.toHaveBeenCalled();

  // 层卸载（真实浏览器由 v-if 将 layerRoot 置空）。
  focus.layerRoot.value = null;
  // Esc：阻止默认行为、执行关闭动作，并把焦点还给触发点。
  const preventDefault = vi.fn();
  focus.onLayerKeydown({ key: "Escape", preventDefault } as unknown as KeyboardEvent);
  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  await settle();
  expect(opener.focusCalls).toBe(1);
  expect(document.activeElement).toBe(opener);
});

it("UI-R13 二轮：点击按钮内文字（span）解析到真实可聚焦按钮作为触发点", async () => {
  installDocument();
  const button = new FakeElement();
  button.focusableSelf = true;
  const labelSpan = new FakeElement();
  // span.closest(FOCUSABLE_SELECTOR) 返回所在按钮（真实 DOM 语义）。
  labelSpan.closestResult = button;
  const close = vi.fn();
  const focus = createModalFocus({ close });
  focus.focusOnOpen({ target: labelSpan } as unknown as Event);
  focus.focusOnClose();
  await settle();
  // 还原到按钮而不是不可聚焦的 span。
  expect(button.focusCalls).toBe(1);
  expect(labelSpan.focusCalls).toBe(0);
});

it("UI-R13 二轮：触发点已不在文档时回退到当前页主标题（默认回退目标）", async () => {
  const heading = new FakeElement();
  installDocument(heading);
  const close = vi.fn();
  const focus = createModalFocus({ close });
  const opener = new FakeElement();
  opener.focusableSelf = true;
  focus.focusOnOpen({ target: opener } as unknown as Event);
  // 打开期间触发点被移除（例如背景页重渲染）。
  opener.connected = false;
  focus.focusOnClose();
  expect(close).toHaveBeenCalledTimes(1);
  await settle();
  expect(heading.focusCalls).toBeGreaterThanOrEqual(1);
});

it("UI-R13 二轮：restoreFocus 供上层统一还原（浏览器返回关闭），层重开时迟到还原不抢焦点", async () => {
  installDocument();
  const opener = new FakeElement();
  opener.focusableSelf = true;
  const focus = createModalFocus({ close: () => undefined });
  focus.focusOnOpen({ target: opener } as unknown as Event);
  // 上层在层确实关闭后调用 restoreFocus（Esc/按钮/遮罩/浏览器返回统一入口）。
  focus.layerRoot.value = null;
  focus.restoreFocus();
  await settle();
  expect(opener.focusCalls).toBe(1);

  // 层被重新打开后迟到的还原调度不触碰焦点。
  const reopened = new FakeElement();
  const reopenedRoot = new FakeElement([reopened]);
  focus.layerRoot.value = reopenedRoot as unknown as HTMLElement;
  focus.restoreFocus();
  await settle();
  expect(reopened.focusCalls).toBe(0);
  expect(opener.focusCalls).toBe(1);
});

it("UI-R13 二轮：restoreOnClose=false 时 focusOnClose 只执行关闭动作，不重复还原", async () => {
  installDocument();
  const opener = new FakeElement();
  opener.focusableSelf = true;
  const close = vi.fn();
  const focus = createModalFocus({ close, restoreOnClose: false });
  focus.focusOnOpen({ target: opener } as unknown as Event);
  focus.focusOnClose();
  await settle();
  expect(close).toHaveBeenCalledTimes(1);
  expect(opener.focusCalls).toBe(0);
});

it("UI-R13 Tab 陷阱：末位 Tab 回到首个、首位 Shift+Tab 回到末位、层外焦点被拉回层内", () => {
  const first = new FakeElement();
  const middle = new FakeElement();
  const last = new FakeElement();
  const root = new FakeElement([first, middle, last]);
  const { document } = installDocument();
  const focus = createModalFocus({ close: () => undefined });
  focus.layerRoot.value = root as unknown as HTMLElement;

  // 焦点在末位：Tab 换行到首个并阻止默认行为。
  document.activeElement = last;
  const fromLast = vi.fn();
  focus.onLayerKeydown({ key: "Tab", shiftKey: false, preventDefault: fromLast } as unknown as KeyboardEvent);
  expect(fromLast).toHaveBeenCalledTimes(1);
  expect(first.focusCalls).toBe(1);

  // 焦点在首位：Shift+Tab 换行到末位。
  document.activeElement = first;
  const fromFirst = vi.fn();
  focus.onLayerKeydown({ key: "Tab", shiftKey: true, preventDefault: fromFirst } as unknown as KeyboardEvent);
  expect(fromFirst).toHaveBeenCalledTimes(1);
  expect(last.focusCalls).toBe(1);

  // 焦点跑到层外（背景内容）：Tab 拉回层内首个。
  document.activeElement = new FakeElement();
  const fromOutside = vi.fn();
  focus.onLayerKeydown({ key: "Tab", shiftKey: false, preventDefault: fromOutside } as unknown as KeyboardEvent);
  expect(fromOutside).toHaveBeenCalledTimes(1);
  expect(first.focusCalls).toBe(2);

  // 焦点在层内中间元素：不干预默认 Tab 行为（浏览器自然移动）。
  document.activeElement = middle;
  const natural = vi.fn();
  focus.onLayerKeydown({ key: "Tab", shiftKey: false, preventDefault: natural } as unknown as KeyboardEvent);
  expect(natural).not.toHaveBeenCalled();
});
