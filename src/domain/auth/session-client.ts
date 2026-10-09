// 认证状态客户端（纯逻辑，可注入 fetch）：会话读取端点（默认 GET /api/auth/session）
// 是登录状态的事实来源。只读刷新与登录/退出命令分开排序：刷新不会取消在途命令
// （否则命令的 busy 状态会永远不复位），命令也不会被更早的刷新响应覆盖；页面
// 可见性/上线触发的刷新只更新展示状态。没有轮询或保活。
//
// 协议适配（AuthSessionAdapter）：默认是生产 OIDC 流程（顶层跳转授权地址）；
// 本地开发登录（pnpm dev:local）注入自己的端点、文案与「本请求已建立会话」的
// 完成方式，共用同一套排序与门禁语义。适配层模块只在 dev:local 构建载入。
import { isAccountId } from "../../shared/sync-protocol";

export type AuthStatus = "checking" | "anonymous" | "authenticated" | "unavailable";

export interface AuthSnapshot {
  accountId: string | null;
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
  /** 登录成功后是否需要顶层跳转到 authorizationUrl；本地开发登录为 false。 */
  redirect: boolean;
}

export interface LogoutResult {
  ok: boolean;
  message: string;
}

/** 认证客户端的用户可见文案；两种流程各自提供一套。 */
export interface AuthSessionMessages {
  readonly checking: string;
  readonly anonymous: string;
  readonly authenticated: string;
  readonly unavailable: string;
  readonly sessionUnconfirmed: string;
  readonly accountIdUnavailable: string;
  readonly preparingLogin: string;
  readonly loginOffline: string;
  readonly loginOriginRejected: string;
  readonly loginServiceUnavailable: string;
  readonly loginFailed: string;
  readonly loginAddressInvalid: string;
  readonly loginRedirecting: string;
  /** 完成方式为 in-place 时，服务端已在本次登录请求中建立会话。 */
  readonly loginCompletedInPlace: string;
  readonly loginNetworkFailure: string;
  readonly loggingOut: string;
  readonly logoutOffline: string;
  readonly logoutIncomplete: string;
  readonly logoutCompleted: string;
  readonly logoutNetworkFailure: string;
}

/** 认证协议适配：端点、登录完成方式、身份标签与文案。 */
export interface AuthSessionAdapter {
  /** 会话读取端点（GET JSON：{ authenticated, accountId? }）。 */
  readonly sessionPath: string;
  /** 发起登录端点（POST JSON）。 */
  readonly loginPath: string;
  /** 退出端点（POST JSON）。 */
  readonly logoutPath: string;
  /**
   * 登录成功后的交互：redirect 表示需要顶层跳转到 authorizationUrl；
   * in-place 表示本次登录请求已建立服务端会话，页面原地继续。
   */
  readonly loginCompletion: "redirect" | "in-place";
  /**
   * 已登录状态下的身份标签；本地开发登录用它标注本地测试账号，
   * 不把合成身份呈现为真实 eruoo 验证（标签随适配模块一起按构建载入）。
   */
  readonly authenticatedAccountLabel: string;
  readonly messages: AuthSessionMessages;
}

/** 客户端对外能力；生产与本地开发登录共用同一接口。 */
export interface AuthSessionController {
  readonly current: AuthSnapshot;
  /** 已登录状态下的身份标签（由协议适配提供）。 */
  readonly authenticatedAccountLabel: string;
  refresh(): Promise<void>;
  recheckRejectedSession(): Promise<void>;
  login(): Promise<LoginStartResult>;
  logout(): Promise<LogoutResult>;
}

export const PRODUCTION_AUTH_SESSION_MESSAGES: AuthSessionMessages = {
  checking: "正在确认登录状态…",
  anonymous: "尚未登录，请登录后继续。本机记录与草稿已保留。",
  authenticated: "已登录。登录不会自动关联或上传现有本地验证数据。",
  unavailable: "暂时无法确认登录状态（离线或服务不可用）。本机记录与草稿已保留。",
  sessionUnconfirmed: "服务端暂时无法确认登录状态。本机记录与草稿已保留。",
  accountIdUnavailable: "账号存储信息不可用，请更新页面后重新检查。",
  preparingLogin: "正在准备登录…",
  loginOffline: "当前离线，无法发起登录。",
  loginOriginRejected: "登录被拒绝：请求来源不符合要求。",
  loginServiceUnavailable: "登录服务暂时不可用（配置或身份服务问题），请稍后重试。",
  loginFailed: "发起登录失败，请稍后重试。",
  loginAddressInvalid: "登录地址无效，请稍后重试。",
  loginRedirecting: "即将跳转到 eruoo 完成登录…",
  loginCompletedInPlace: "登录已完成。",
  loginNetworkFailure: "发起登录失败：网络或服务不可用。本机记录与草稿已保留。",
  loggingOut: "正在退出…",
  logoutOffline: "当前离线，未执行退出。服务端会话状态未改变。",
  logoutIncomplete: "退出未完成：服务端仍可能处于登录状态，请重试。",
  logoutCompleted: "已退出登录。本机记录与草稿保留。",
  logoutNetworkFailure: "退出失败：网络或服务不可用，服务端会话状态未确认。",
};

/** 生产登录：OIDC 顶层跳转、固定 /api/auth 端点、真实 eruoo 身份标签。 */
export const PRODUCTION_AUTH_SESSION_ADAPTER: AuthSessionAdapter = {
  sessionPath: "/api/auth/session",
  loginPath: "/api/auth/login",
  logoutPath: "/api/auth/logout",
  loginCompletion: "redirect",
  authenticatedAccountLabel: "已登录 · eruoo",
  messages: PRODUCTION_AUTH_SESSION_MESSAGES,
};

export interface AuthSessionClientOptions {
  fetch?: typeof fetch;
  /** 离线判断，便于测试与未来扩展。 */
  isOnline?: () => boolean;
  onChange?: (snapshot: AuthSnapshot) => void;
  /** 协议适配；默认生产 OIDC 流程。 */
  adapter?: AuthSessionAdapter;
}

export class AuthSessionClient implements AuthSessionController {
  /** 命令序号：只由 login/logout 递增；刷新不参与，避免取消在途命令。 */
  private commandSequence = 0;
  /** 刷新序号：每次只读刷新递增，用于丢弃过期的刷新响应。 */
  private refreshSequence = 0;
  private snapshot: AuthSnapshot = {
    accountId: null,
    status: "checking",
    message: PRODUCTION_AUTH_SESSION_MESSAGES.checking,
    loggingIn: false,
    loggingOut: false,
  };
  private refreshInFlight: Promise<void> | null = null;
  private readonly adapter: AuthSessionAdapter;

  constructor(private readonly options: AuthSessionClientOptions = {}) {
    this.adapter = options.adapter ?? PRODUCTION_AUTH_SESSION_ADAPTER;
    this.snapshot = { ...this.snapshot, message: this.adapter.messages.checking };
  }

  get current(): AuthSnapshot {
    return this.snapshot;
  }

  get authenticatedAccountLabel(): string {
    return this.adapter.authenticatedAccountLabel;
  }

  private update(partial: Partial<AuthSnapshot>): void {
    if (partial.status && partial.status !== "authenticated") partial.accountId = null;
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
    const messages = this.adapter.messages;
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
        this.update({ status: "unavailable", message: messages.unavailable });
      }
      return;
    }
    try {
      const response = await this.fetchImpl()(this.adapter.sessionPath, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!applies()) return;
      if (!response.ok) {
        this.update({ status: "unavailable", message: messages.sessionUnconfirmed });
        return;
      }
      const body = (await response.json()) as { authenticated?: unknown; accountId?: unknown };
      if (!applies()) return;
      if (body.authenticated === true && !isAccountId(body.accountId)) {
        this.update({ status: "unavailable", message: messages.accountIdUnavailable });
        return;
      }
      const authenticated = body.authenticated === true;
      this.update({
        status: authenticated ? "authenticated" : "anonymous",
        accountId: authenticated && isAccountId(body.accountId) ? body.accountId : null,
        message: authenticated ? messages.authenticated : messages.anonymous,
      });
    } catch {
      if (!applies()) return;
      this.update({ status: "unavailable", message: messages.unavailable });
    }
  }

  /** 同步端点拒绝会话时立即关闭门禁，旧状态读取不得重新放行。 */
  async recheckRejectedSession(): Promise<void> {
    this.refreshSequence += 1;
    this.update({ status: "checking", message: this.adapter.messages.checking });
    await this.refreshInFlight;
    await this.refresh();
  }

  /** 发起登录并返回授权地址；调用方在草稿落盘后做顶层跳转。 */
  async login(): Promise<LoginStartResult> {
    const messages = this.adapter.messages;
    const sequence = ++this.commandSequence;
    if (!this.online()) {
      this.update({ loggingIn: false, status: "unavailable", message: messages.unavailable });
      return { ok: false, authorizationUrl: "", message: messages.loginOffline, redirect: false };
    }
    this.update({ loggingIn: true, message: messages.preparingLogin });
    try {
      const response = await this.fetchImpl()(this.adapter.loginPath, {
        method: "POST",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (sequence !== this.commandSequence) return { ok: false, authorizationUrl: "", message: "", redirect: false };
      const body = (await response.json().catch(() => ({}))) as { authorizationUrl?: unknown; accountId?: unknown };
      // JSON 解析也是异步边界：期间可能有更新的命令，旧响应不得覆盖它
      if (sequence !== this.commandSequence) return { ok: false, authorizationUrl: "", message: "", redirect: false };
      if (!response.ok) {
        this.update({ loggingIn: false, message: loginFailureMessage(response.status, messages) });
        return { ok: false, authorizationUrl: "", message: this.snapshot.message, redirect: false };
      }
      if (this.adapter.loginCompletion === "in-place") {
        // 本请求就是会话建立请求：先采用服务端返回的会话结果，再以同一会话端点
        // 的只读读取校正；不预先标记为已登录。
        const accountId = isAccountId(body.accountId) ? body.accountId : null;
        if (accountId === null) {
          this.update({ loggingIn: false, status: "unavailable", message: messages.accountIdUnavailable });
          return { ok: false, authorizationUrl: "", message: this.snapshot.message, redirect: false };
        }
        this.update({
          loggingIn: false,
          status: "authenticated",
          accountId,
          message: messages.loginCompletedInPlace,
        });
        await this.refresh();
        return { ok: true, authorizationUrl: "", message: this.snapshot.message, redirect: false };
      }
      const authorizationUrl = typeof body.authorizationUrl === "string" ? body.authorizationUrl : "";
      if (sequence !== this.commandSequence) return { ok: false, authorizationUrl: "", message: "", redirect: false };
      if (!safeAuthorizationUrl(authorizationUrl)) {
        this.update({ loggingIn: false, message: messages.loginAddressInvalid });
        return { ok: false, authorizationUrl: "", message: this.snapshot.message, redirect: false };
      }
      // 登录状态在返回后由 session 响应决定，这里不预先标记为已登录。
      this.update({ loggingIn: false, message: messages.loginRedirecting });
      return { ok: true, authorizationUrl, message: "", redirect: true };
    } catch {
      if (sequence !== this.commandSequence) return { ok: false, authorizationUrl: "", message: "", redirect: false };
      this.update({
        loggingIn: false,
        status: "unavailable",
        message: messages.loginNetworkFailure,
      });
      return { ok: false, authorizationUrl: "", message: this.snapshot.message, redirect: false };
    }
  }

  /** 退出登录；失败时不谎报服务端已退出。 */
  async logout(): Promise<LogoutResult> {
    const messages = this.adapter.messages;
    const sequence = ++this.commandSequence;
    if (!this.online()) {
      this.update({ loggingOut: false, message: messages.logoutOffline });
      return { ok: false, message: this.snapshot.message };
    }
    this.update({ loggingOut: true, message: messages.loggingOut });
    try {
      const response = await this.fetchImpl()(this.adapter.logoutPath, {
        method: "POST",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (sequence !== this.commandSequence) return { ok: false, message: "" };
      if (!response.ok) {
        this.update({ loggingOut: false, message: messages.logoutIncomplete });
        return { ok: false, message: this.snapshot.message };
      }
      this.update({
        loggingOut: false,
        status: "anonymous",
        message: messages.logoutCompleted,
      });
      return { ok: true, message: this.snapshot.message };
    } catch {
      if (sequence !== this.commandSequence) return { ok: false, message: "" };
      this.update({
        loggingOut: false,
        status: "unavailable",
        message: messages.logoutNetworkFailure,
      });
      return { ok: false, message: this.snapshot.message };
    }
  }
}

function loginFailureMessage(status: number, messages: AuthSessionMessages): string {
  if (status === 403) return messages.loginOriginRejected;
  if (status === 503) return messages.loginServiceUnavailable;
  return messages.loginFailed;
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
  return {
    checking: PRODUCTION_AUTH_SESSION_MESSAGES.checking,
    anonymous: PRODUCTION_AUTH_SESSION_MESSAGES.anonymous,
    authenticated: PRODUCTION_AUTH_SESSION_MESSAGES.authenticated,
    unavailable: PRODUCTION_AUTH_SESSION_MESSAGES.unavailable,
  };
}
