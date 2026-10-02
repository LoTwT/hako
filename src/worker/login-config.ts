// 登录配置合同。协议权威来源是 docs/specs/eruoo-login-integration.md 第 3、6 节：
// 固定 origin、issuer、client 与 resource 在 cloudflare.config.ts 的 HAKO_LOGIN JSON
// 绑定中声明；owner 主体由 HAKO_OWNER_SUBJECT 后端 Secret（或本地 .dev.vars）输入。
// 校验在读取时执行：缺少 owner 无法取得有效登录配置，但类型生成、构建、健康检查
// 与静态页面不依赖真实 owner。回调由固定配置组装，不从请求 Host/Origin 推导。

/** OAuth 回调固定挂在 API 命名空间下。 */
export const LOGIN_CALLBACK_PATH = "/api/auth/callback";

/** cloudflare.config.ts 中 HAKO_LOGIN 声明的部署固定值。 */
export interface HakoLoginDeploymentConfig {
  origin: string;
  issuer: string;
  clientId: string;
  resource: string;
}

/** 校验通过的完整登录配置。 */
export interface HakoLoginConfig {
  origin: string;
  issuer: string;
  clientId: string;
  resource: string;
  ownerSubject: string;
  /** 固定 origin + LOGIN_CALLBACK_PATH 组装，不由请求推导。 */
  redirectUri: string;
}

/** 读取登录配置的 Worker 环境输入。真实 Env 由 .cloudflare/types 生成并结构兼容。 */
export interface LoginConfigEnvironment {
  readonly HAKO_LOGIN: unknown;
  readonly HAKO_OWNER_SUBJECT: string | undefined;
}

export type LoginConfigField =
  | "HAKO_LOGIN"
  | "HAKO_OWNER_SUBJECT"
  | "origin"
  | "issuer"
  | "clientId"
  | "resource"
  | "ownerSubject";

export type LoginConfigErrorCode =
  | "missing_binding"
  | "invalid_shape"
  | "invalid_https_origin"
  | "invalid_https_url"
  | "local_address_not_allowed"
  | "empty_value";

/** 可读错误。message 不回显任何配置值，owner 主体更不会出现在错误或日志里。 */
export interface LoginConfigError {
  field: LoginConfigField;
  code: LoginConfigErrorCode;
  message: string;
}

export type LoginConfigResult =
  | { ok: true; config: HakoLoginConfig }
  | { ok: false; error: LoginConfigError };

function invalidHttpsOrigin(field: LoginConfigField, message: string): LoginConfigError {
  return { field, code: "invalid_https_origin", message };
}

/** 正式登记不允许 localhost、环回或内网地址混入生产配置。 */
function isLocalNetworkHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4) {
    const [first, second] = [Number(ipv4[1]), Number(ipv4[2])];
    return (
      first === 0 ||
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  const ipv6 = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : null;
  if (ipv6 !== null) {
    return (
      ipv6 === "::1" ||
      ipv6 === "::" ||
      // IPv4 映射段整体拒绝：URL 会把 [::ffff:127.0.0.1] 规范化为 [::ffff:7f00:1]，
      // 点分形式到不了这里；映射段也不是合法的正式 origin。
      ipv6.startsWith("::ffff:") ||
      ipv6.startsWith("fc") ||
      ipv6.startsWith("fd") ||
      ipv6.startsWith("fe80")
    );
  }
  return false;
}

/**
 * 校验正式 HTTPS origin：必须 https、无用户信息、无显式端口、无路径、
 * 无 query、无 fragment，且不是本地或内网地址。
 */
function validateHttpsOrigin(field: LoginConfigField, value: string): LoginConfigError | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidHttpsOrigin(field, `${field} 必须是可解析的 HTTPS origin`);
  }
  if (url.protocol !== "https:") {
    return invalidHttpsOrigin(field, `${field} 必须使用 https 协议`);
  }
  if (url.username !== "" || url.password !== "") {
    return invalidHttpsOrigin(field, `${field} 不得包含用户信息`);
  }
  if (url.hostname === "") {
    return invalidHttpsOrigin(field, `${field} 缺少主机名`);
  }
  if (url.port !== "") {
    return invalidHttpsOrigin(field, `${field} 不得包含显式端口`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return invalidHttpsOrigin(field, `${field} 只能是 origin，不得包含路径、query 或 fragment`);
  }
  if (isLocalNetworkHostname(url.hostname)) {
    return { field, code: "local_address_not_allowed", message: `${field} 不得使用本地或内网地址` };
  }
  return null;
}

/** resource 是完整 HTTPS URL（允许路径，如 https://auth.eruoo.me/api）。 */
function validateHttpsUrl(field: LoginConfigField, value: string): LoginConfigError | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { field, code: "invalid_https_url", message: `${field} 必须是可解析的 HTTPS URL` };
  }
  if (url.protocol !== "https:") {
    return { field, code: "invalid_https_url", message: `${field} 必须使用 https 协议` };
  }
  if (url.username !== "" || url.password !== "") {
    return { field, code: "invalid_https_url", message: `${field} 不得包含用户信息` };
  }
  if (url.hostname === "") {
    return { field, code: "invalid_https_url", message: `${field} 缺少主机名` };
  }
  if (isLocalNetworkHostname(url.hostname)) {
    return { field, code: "local_address_not_allowed", message: `${field} 不得使用本地或内网地址` };
  }
  return null;
}

function readDeploymentConfig(env: LoginConfigEnvironment): HakoLoginDeploymentConfig | LoginConfigError {
  if (env.HAKO_LOGIN === undefined || env.HAKO_LOGIN === null) {
    return { field: "HAKO_LOGIN", code: "missing_binding", message: "缺少 HAKO_LOGIN 配置绑定" };
  }
  if (typeof env.HAKO_LOGIN !== "object") {
    return { field: "HAKO_LOGIN", code: "invalid_shape", message: "HAKO_LOGIN 必须是包含部署固定值的对象" };
  }
  const record = env.HAKO_LOGIN as Record<string, unknown>;
  const fields = ["origin", "issuer", "clientId", "resource"] as const;
  const deployment: Record<string, string> = {};
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "string") {
      return { field: "HAKO_LOGIN", code: "invalid_shape", message: `HAKO_LOGIN.${field} 必须是字符串` };
    }
    deployment[field] = value;
  }
  return deployment as unknown as HakoLoginDeploymentConfig;
}

/**
 * 从 Worker 环境读取并校验登录配置。缺少 owner 或任何固定值非法时返回
 * ok: false；调用方不得在缺少有效登录配置时建立云端身份能力。
 */
export function readLoginConfig(env: LoginConfigEnvironment): LoginConfigResult {
  const deployment = readDeploymentConfig(env);
  if ("code" in deployment) return { ok: false, error: deployment };

  const originError = validateHttpsOrigin("origin", deployment.origin);
  if (originError) return { ok: false, error: originError };
  const issuerError = validateHttpsOrigin("issuer", deployment.issuer);
  if (issuerError) return { ok: false, error: issuerError };
  if (deployment.clientId.trim() === "") {
    return { ok: false, error: { field: "clientId", code: "empty_value", message: "clientId 不得为空" } };
  }
  const resourceError = validateHttpsUrl("resource", deployment.resource);
  if (resourceError) return { ok: false, error: resourceError };

  if (env.HAKO_OWNER_SUBJECT === undefined) {
    return {
      ok: false,
      error: {
        field: "HAKO_OWNER_SUBJECT",
        code: "missing_binding",
        message: "缺少 owner 主体（HAKO_OWNER_SUBJECT Secret）配置",
      },
    };
  }
  const ownerSubject = env.HAKO_OWNER_SUBJECT.trim();
  if (ownerSubject === "") {
    return { ok: false, error: { field: "ownerSubject", code: "empty_value", message: "owner 主体不得为空" } };
  }

  return {
    ok: true,
    config: {
      origin: deployment.origin,
      issuer: deployment.issuer,
      clientId: deployment.clientId,
      resource: deployment.resource,
      ownerSubject,
      redirectUri: `${deployment.origin}${LOGIN_CALLBACK_PATH}`,
    },
  };
}
