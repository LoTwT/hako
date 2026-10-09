import { onMounted, onUnmounted, readonly, shallowRef } from "vue";
import {
  AuthSessionClient,
  PRODUCTION_AUTH_SESSION_ADAPTER,
  PRODUCTION_AUTH_SESSION_MESSAGES,
  type AuthSessionClientOptions,
  type AuthSessionController,
  type AuthSnapshot,
  type LoginStartResult,
  type LogoutResult,
} from "../domain/auth/session-client";

/**
 * 登录状态接线：启动、重新可见、返回应用（bfcache）和登录/退出后检查会话
 * 端点，不轮询、不做保活。认证请求始终走网络。
 *
 * dev:local 构建额外动态载入本地开发登录客户端（生产构建不包含该模块，
 * 见 vite.config.ts 的 __HAKO_LOCAL_DEV__）；客户端就绪前的调用先等待载入，
 * 载入失败时如实呈现不可用，且不回退到生产登录流程。
 */
export function useAuthSession() {
  const localDevelopment = __HAKO_LOCAL_DEV__;
  const snapshot = shallowRef<AuthSnapshot>({
    accountId: null,
    status: "checking",
    message: PRODUCTION_AUTH_SESSION_MESSAGES.checking,
    loggingIn: false,
    loggingOut: false,
  });
  /** 已登录身份标签：生产为 eruoo 登录，dev:local 为本地测试账号（随适配模块载入）。 */
  const authenticatedAccountLabel = shallowRef(PRODUCTION_AUTH_SESSION_ADAPTER.authenticatedAccountLabel);
  const clientOptions: AuthSessionClientOptions = {
    onChange: (next) => {
      snapshot.value = next;
    },
  };

  async function createClient(): Promise<AuthSessionController> {
    if (!localDevelopment) return new AuthSessionClient(clientOptions);
    const localDevelopmentClient = await import("../domain/auth/local-development-session-client");
    return localDevelopmentClient.createLocalDevelopmentAuthSessionClient({
      ...clientOptions,
      authPaths: __HAKO_LOCAL_DEV_AUTH_PATHS__,
    });
  }

  /** 客户端就绪句柄；载入失败为 null（只可能发生在本地开发构建）。 */
  const ready: Promise<AuthSessionController | null> = createClient().then((client) => {
    authenticatedAccountLabel.value = client.authenticatedAccountLabel;
    return client;
  }).catch(() => {
    snapshot.value = {
      accountId: null,
      status: "unavailable",
      message: "本地开发登录适配层未能载入，请重新启动 pnpm dev:local。",
      loggingIn: false,
      loggingOut: false,
    };
    return null;
  });

  async function withClient<T>(action: (client: AuthSessionController) => Promise<T>, unavailable: T): Promise<T> {
    const client = await ready;
    if (client === null) return unavailable;
    return await action(client);
  }

  const refresh = (): Promise<void> => withClient((client) => client.refresh(), undefined);
  const login = (): Promise<LoginStartResult> =>
    withClient((client) => client.login(), {
      ok: false,
      authorizationUrl: "",
      message: "本地开发登录适配层不可用，请重新启动 pnpm dev:local。",
      redirect: false,
    });
  const logout = (): Promise<LogoutResult> =>
    withClient((client) => client.logout(), { ok: false, message: "本地开发登录适配层不可用。" });
  const recheckRejectedSession = (): Promise<void> =>
    withClient((client) => client.recheckRejectedSession(), undefined);

  const onVisible = () => {
    if (document.visibilityState === "visible") void refresh();
  };
  const onPageShow = () => {
    void refresh();
  };
  const onOnline = () => {
    void refresh();
  };

  onMounted(() => {
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    void refresh();
  });
  onUnmounted(() => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", onOnline);
  });

  return {
    auth: readonly(snapshot),
    /** 已登录身份标签；由当前构建载入的协议适配提供。 */
    authenticatedAccountLabel: readonly(authenticatedAccountLabel),
    /** 当前构建是否为隔离的本地开发登录环境（dev:local）。 */
    localDevelopment,
    refresh,
    login,
    logout,
    recheckRejectedSession,
  };
}
