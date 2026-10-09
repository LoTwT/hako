// 未登录门禁组件选择：生产构建使用静态登录页；dev:local 构建使用动态导入的本地
// 登录页（本地页面模块只在本地开发产物中载入，生产产物不包含）。
//
// 动态导入使该组件首次挂载晚于 App 的会话/路由 watcher：App 用
// focusGateHeadingWhenReady 在门禁页就绪且仍属当前登录呈现时补一次标题聚焦
// （见 src/ui/gate-heading-focus.ts）。把选择放在这里也让组件接线可被测试替换。

import { defineAsyncComponent, type Component } from "vue";
import LoginPage from "../components/auth/LoginPage.vue";

export const LoginGateComponent: Component = __HAKO_LOCAL_DEV__
  ? defineAsyncComponent(() => import("../components/auth/LocalDevelopmentLoginPage.vue"))
  : LoginPage;
