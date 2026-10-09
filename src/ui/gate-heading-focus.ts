// 门禁页标题聚焦：会话/路由 watcher 通过 focusNow() 聚焦当前门禁页标题；dev:local 的
// 本地登录页是动态导入组件（defineAsyncComponent），首次渲染时组件尚未挂载，当次
// watcher 拿到的 ref 仍是 null，之后组件真正挂载不会再触发该 watcher——因此这里在
// 门禁页实例就绪时补一次聚焦，并保持三条规则：
// - 只在门禁页仍属于当前呈现时补偿（离开登录呈现后的迟到加载不抢焦点）；
// - 同一个门禁页实例只补偿一次，避免与 watcher 的聚焦重复调用；
// - 组件卸载时 ref 归 null 并清除记录，下次就绪重新补偿。
// 只调用门禁页自己的 focusHeading，不改变焦点装饰规则（PR1 的标题 outline 规则不变）。

import { watch, type Ref } from "vue";

/** 门禁页只需要暴露标题聚焦入口；与各门禁页组件的 defineExpose 一致。 */
export interface GateHeadingPage {
  focusHeading: () => void;
}

export interface GateHeadingFocus {
  /** 立即聚焦当前门禁页标题；页面未就绪（ref 为 null）时不做事。 */
  focusNow(): void;
}

/**
 * 建立门禁页标题聚焦：返回 watcher 与补偿共用的 focusNow；补偿使用 post flush，
 * 与页面级 watcher 同一时机，确保在组件挂载渲染之后执行。
 */
export function createGateHeadingFocus(
  gatePage: Ref<GateHeadingPage | null>,
  isCurrentPresentation: () => boolean,
): GateHeadingFocus {
  let focusedPage: GateHeadingPage | null = null;
  const focusNow = (): void => {
    const page = gatePage.value;
    if (page === null) return;
    focusedPage = page;
    page.focusHeading();
  };
  watch(gatePage, (page) => {
    if (page === null) {
      focusedPage = null;
      return;
    }
    if (page === focusedPage || !isCurrentPresentation()) return;
    focusNow();
  }, { flush: "post" });
  return { focusNow };
}
