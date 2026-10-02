import { onMounted, onUnmounted, readonly, shallowRef } from "vue";
import { AuthSessionClient, type AuthSnapshot } from "../domain/auth/session-client";

/**
 * 登录状态接线：启动、重新可见、返回应用（bfcache）和登录/退出后检查
 * GET /api/auth/session，不轮询、不做保活。认证请求始终走网络。
 */
export function useAuthSession() {
  const snapshot = shallowRef<AuthSnapshot>({
    status: "checking",
    message: "正在确认登录状态…",
    loggingIn: false,
    loggingOut: false,
  });
  const client = new AuthSessionClient({
    onChange: (next) => {
      snapshot.value = next;
    },
  });

  const onVisible = () => {
    if (document.visibilityState === "visible") void client.refresh();
  };
  const onPageShow = () => {
    void client.refresh();
  };
  const onOnline = () => {
    void client.refresh();
  };

  onMounted(() => {
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    void client.refresh();
  });
  onUnmounted(() => {
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", onOnline);
  });

  return {
    auth: readonly(snapshot),
    refresh: () => client.refresh(),
    login: () => client.login(),
    logout: () => client.logout(),
  };
}
