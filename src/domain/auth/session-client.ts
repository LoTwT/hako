// 认证状态客户端（纯逻辑，可注入 fetch）：GET /api/auth/session 是登录状态的
// 事实来源。只读刷新与登录/退出命令分开排序：刷新不会取消在途命令（否则
// 命令的 busy 状态会永远不复位），命令也不会被更早的刷新响应覆盖；页面
// 可见性/上线触发的刷新只更新展示状态。没有轮询或保活。

export type AuthStatus = "checking" | "anonymous" | "authenticated" | "unavailable";

export interface AuthSnapshot {
  status: AuthStatus;
  message: string;
  /** 登录跳转请求正在进行（按钮与输入据此禁用）。 */
  loggingIn: boolean;
  loggingOut: boolean;
}

export interface LoginStartResult {
  ok: boolean;
  authorizationUrl: string;
  message: string;
}

export interface LogoutResult {
  ok: boolean;
  message: string;
}

export interface AuthSessionClientOptions {
  fetch?: typeof fetch;
  /** 离线判断，便于测试与未来扩展。 */
  isOnline?: () => boolean;
  onChange?: (snapshot: AuthSnapshot) => void;
}

const statusMessages: Record<AuthStatus, string> = {
  checking: "正在确认登录状态…",
  anonymous: "尚未登录，请登录后继续。本机记录与草稿已保留。",
  authenticated: "已登录。登录不会自动关联或上传现有本地验证数据。",
  unavailable: "暂时无法确认登录状态（离线或服务不可用）。本机记录与草稿已保留。",
};

export class AuthSessionClient {
  /** 命令序号：只由 login/logout 递增；刷新不参与，避免取消在途命令。 */
  private commandSequence = 0;
  /** 刷新序号：每次只读刷新递增，用于丢弃过期的刷新响应。 */
  private refreshSequence = 0;
  private snapshot: AuthSnapshot = {
    status: "checking",
    message: statusMessages.checking,
    loggingIn: false,
    loggingOut: false,
  };
  private refreshInFlight: Promise<void> | null = null;

  constructor(private readonly options: AuthSessionClientOptions = {}) {}

  get current(): AuthSnapshot {
    return this.snapshot;
  }

  private update(partial: Partial<AuthSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    this.options.onChange?.(this.snapshot);
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetch ?? ((input, init) => fetch(input, init));
  }

  private online(): boolean {
    if (this.options.isOnline !== undefined) return this.options.isOnline();
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  /** 读取会话状态；并发调用合并为一次请求。 */
  refresh(): Promise<void> {
    this.refreshInFlight ??= this.runRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async runRefresh(): Promise<void> {
    const refresh = ++this.refreshSequence;
    const commandAtStart = this.commandSequence;
    // 命令执行期间启动的观察读到的是命令生效前的状态，永远不能覆盖命令结果
    const commandInFlightAtStart = this.snapshot.loggingIn || this.snapshot.loggingOut;
    // 只在“仍是最新刷新、期间没有命令启动、也没有在命令执行期间启动、当前
    // 没有命令在途”时应用结果；命令自己的响应才是最终事实。
    const applies = () =>
      refresh === this.refreshSequence &&
      commandAtStart === this.commandSequence &&
      !commandInFlightAtStart &&
      !this.snapshot.loggingIn &&
      !this.snapshot.loggingOut;
    if (!this.online()) {
      if (applies()) {
        this.update({ status: "unavailable", message: statusMessages.unavailable });
      }
      return;
    }
    try {
      const response = await this.fetchImpl()("/api/auth/session", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!applies()) return;
      if (!response.ok) {
        this.update({
          status: "unavailable",
          message: "服务端暂时无法确认登录状态。本机记录与草稿已保留。",
        });
        return;
      }
      const body = (await response.json()) as { authenticated?: unknown };
      if (!applies()) return;
      const authenticated = body.authenticated === true;
      this.update({
        status: authenticated ? "authenticated" : "anonymous",
        message: authenticated ? statusMessages.authenticated : statusMessages.anonymous,
      });
    } catch {
      if (!applies()) return;
      this.update({ status: "unavailable", message: statusMessages.unavailable });
    }
  }

  /** 发起登录并返回授权地址；调用方在草稿落盘后做顶层跳转。 */
  async login(): Promise<LoginStartResult> {
    const sequence = ++this.commandSequence;
    if (!this.online()) {
      this.update({ loggingIn: false, status: "unavailable", message: statusMessages.unavailable });
      return { ok: false, authorizationUrl: "", message: "当前离线，无法发起登录。" };
    }
    this.update({ loggingIn: true, message: "正在准备登录…" });
    try {
      const response = await this.fetchImpl()("/api/auth/login", {
        method: "POST",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (sequence !== this.commandSequence) return { ok: false, authorizationUrl: "", message: "" };
      const body = (await response.json().catch(() => ({}))) as { authorizationUrl?: unknown };
      // JSON 解析也是异步边界：期间可能有更新的命令，旧响应不得覆盖它
      if (sequence !== this.commandSequence) return { ok: false, authorizationUrl: "", message: "" };
      if (!response.ok) {
        this.update({ loggingIn: false, message: loginFailureMessage(response.status) });
        return { ok: false, authorizationUrl: "", message: this.snapshot.message };
      }
      const authorizationUrl = typeof body.authorizationUrl === "string" ? body.authorizationUrl : "";
      if (sequence !== this.commandSequence) return { ok: false, authorizationUrl: "", message: "" };
      if (!safeAuthorizationUrl(authorizationUrl)) {
        this.update({
          loggingIn: false,
          message: "登录地址无效，请稍后重试。",
        });
        return { ok: false, authorizationUrl: "", message: this.snapshot.message };
      }
      // 登录状态在返回后由 session 响应决定，这里不预先标记为已登录。
      this.update({ loggingIn: false, message: "即将跳转到 eruoo 完成登录…" });
      return { ok: true, authorizationUrl, message: "" };
    } catch {
      if (sequence !== this.commandSequence) return { ok: false, authorizationUrl: "", message: "" };
      this.update({
        loggingIn: false,
        status: "unavailable",
        message: "发起登录失败：网络或服务不可用。本机记录与草稿已保留。",
      });
      return { ok: false, authorizationUrl: "", message: this.snapshot.message };
    }
  }

  /** 退出登录；失败时不谎报服务端已退出。 */
  async logout(): Promise<LogoutResult> {
    const sequence = ++this.commandSequence;
    if (!this.online()) {
      this.update({
        loggingOut: false,
        message: "当前离线，未执行退出。服务端会话状态未改变。",
      });
      return { ok: false, message: this.snapshot.message };
    }
    this.update({ loggingOut: true, message: "正在退出…" });
    try {
      const response = await this.fetchImpl()("/api/auth/logout", {
        method: "POST",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (sequence !== this.commandSequence) return { ok: false, message: "" };
      if (!response.ok) {
        this.update({
          loggingOut: false,
          message: "退出未完成：服务端仍可能处于登录状态，请重试。",
        });
        return { ok: false, message: this.snapshot.message };
      }
      this.update({
        loggingOut: false,
        status: "anonymous",
        message: "已退出登录。本机记录与草稿保留。",
      });
      return { ok: true, message: this.snapshot.message };
    } catch {
      if (sequence !== this.commandSequence) return { ok: false, message: "" };
      this.update({
        loggingOut: false,
        status: "unavailable",
        message: "退出失败：网络或服务不可用，服务端会话状态未确认。",
      });
      return { ok: false, message: this.snapshot.message };
    }
  }
}

function loginFailureMessage(status: number): string {
  if (status === 403) return "登录被拒绝：请求来源不符合要求。";
  if (status === 503) return "登录服务暂时不可用（配置或身份服务问题），请稍后重试。";
  return "发起登录失败，请稍后重试。";
}

/** 只允许 http(s)；明文 http 仅限本机开发地址，避免被跳转到任意外部地址。 */
export function safeAuthorizationUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

export function authStatusMessages(): Record<AuthStatus, string> {
  return { ...statusMessages };
}
