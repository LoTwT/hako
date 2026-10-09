// 本地开发登录的客户端适配（只有 dev:local 构建动态载入本模块；
// 生产构建不包含本文件，见 vite.config.ts 的 __HAKO_LOCAL_DEV__ 与 useAuthSession）。
//
// 与生产 OIDC 流程的唯一差异是端点、文案与登录完成方式：本地登录请求本身
// 就在本地 Worker 建立真实会话（in-place），不需要顶层跳转；排序、门禁与
// 只读刷新语义完全复用 session-client.ts 的同一实现。
//
// 端点路径由调用方注入（dev:local 构建来自 vite.config.ts 的构建标志，
// 权威定义在 src/shared/local-development.ts），本模块不直接导入共享常量模块。

import {
  AuthSessionClient,
  PRODUCTION_AUTH_SESSION_MESSAGES,
  type AuthSessionAdapter,
  type AuthSessionClientOptions,
  type AuthSessionController,
  type AuthSessionMessages,
} from "./session-client";

/** 本地开发登录端点；与 dev:local Worker 入口使用的路径一致。 */
export interface LocalDevelopmentAuthPaths {
  readonly login: string;
  readonly session: string;
  readonly logout: string;
}

export interface LocalDevelopmentSessionClientOptions extends AuthSessionClientOptions {
  readonly authPaths: LocalDevelopmentAuthPaths;
}

/** 本地开发文案：明确标注本地测试账号，不冒称真实 eruoo 身份验证。 */
export const LOCAL_DEVELOPMENT_AUTH_SESSION_MESSAGES: AuthSessionMessages = {
  ...PRODUCTION_AUTH_SESSION_MESSAGES,
  checking: "正在确认本地测试账号会话…",
  anonymous: "本地开发环境：尚未登录，点击“使用本地测试账号”建立本地会话。",
  authenticated: "已登录本地测试账号。这是隔离的本地开发会话，不是 eruoo 身份验证。",
  unavailable: "暂时无法确认本地测试账号会话（本地服务不可用）。",
  sessionUnconfirmed: "本地 Worker 暂时无法确认会话状态。",
  preparingLogin: "正在建立本地测试账号会话…",
  loginServiceUnavailable: "无法建立本地会话：本地 Worker 或认证存储不可用，请查看服务端日志。",
  loginFailed: "建立本地测试账号会话失败，请稍后重试。",
  loginAddressInvalid: "本地登录响应无效，请稍后重试。",
  loginCompletedInPlace: "本地测试账号已登录。",
  loginNetworkFailure: "建立本地会话失败：本地服务不可用。",
  logoutIncomplete: "退出未完成：本地 Worker 仍可能处于登录状态，请重试。",
  logoutCompleted: "已退出本地测试账号。本机记录与草稿保留。",
  logoutNetworkFailure: "退出失败：本地服务不可用，会话状态未确认。",
};

export function localDevelopmentAuthSessionAdapter(
  authPaths: LocalDevelopmentAuthPaths,
): AuthSessionAdapter {
  return {
    sessionPath: authPaths.session,
    loginPath: authPaths.login,
    logoutPath: authPaths.logout,
    loginCompletion: "in-place",
    authenticatedAccountLabel: "本地测试账号",
    messages: LOCAL_DEVELOPMENT_AUTH_SESSION_MESSAGES,
  };
}

/** 建立本地开发登录客户端；会话端点与语义由 dev:local 的本地适配层提供。 */
export function createLocalDevelopmentAuthSessionClient(
  options: LocalDevelopmentSessionClientOptions,
): AuthSessionController {
  const { authPaths, ...clientOptions } = options;
  return new AuthSessionClient({
    ...clientOptions,
    adapter: localDevelopmentAuthSessionAdapter(authPaths),
  });
}
