import { describe, expect, it } from "vitest";
import { LOGIN_CALLBACK_PATH, readLoginConfig } from "../src/worker/login-config";

/** 与 cloudflare.config.ts 一致的正式部署固定值（公开值，见登录接入规格第 3 节）。 */
const formalDeploymentConfig = {
  origin: "https://hako.eruoo.me",
  issuer: "https://auth.eruoo.me",
  clientId: "hako-web",
  resource: "https://auth.eruoo.me/api",
};

const syntheticOwnerSubject = "local-synthetic-owner-subject";

function environmentWith(overrides: { HAKO_LOGIN?: unknown; HAKO_OWNER_SUBJECT?: string | undefined } = {}) {
  return {
    HAKO_LOGIN: formalDeploymentConfig,
    HAKO_OWNER_SUBJECT: syntheticOwnerSubject,
    ...overrides,
  };
}

describe("readLoginConfig 有效配置", () => {
  it("通过校验并按固定配置组装回调", () => {
    const result = readLoginConfig(environmentWith({}));
    expect(result).toEqual({
      ok: true,
      config: {
        ...formalDeploymentConfig,
        ownerSubject: syntheticOwnerSubject,
        redirectUri: `https://hako.eruoo.me${LOGIN_CALLBACK_PATH}`,
      },
    });
  });

  it("回调路径固定为 /api/auth/callback", () => {
    expect(LOGIN_CALLBACK_PATH).toBe("/api/auth/callback");
  });

  it("对同一环境输入是纯函数，重复读取结果一致", () => {
    const env = environmentWith({});
    expect(readLoginConfig(env)).toEqual(readLoginConfig(env));
  });
});

describe("readLoginConfig 缺少 owner", () => {
  it("缺少 HAKO_OWNER_SUBJECT 绑定无法取得有效登录配置", () => {
    const result = readLoginConfig({
      HAKO_LOGIN: formalDeploymentConfig,
      HAKO_OWNER_SUBJECT: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("HAKO_OWNER_SUBJECT");
      expect(result.error.code).toBe("missing_binding");
    }
  });

  it("空白 owner 主体被拒绝", () => {
    const result = readLoginConfig(environmentWith({ HAKO_OWNER_SUBJECT: "   " }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("ownerSubject");
      expect(result.error.code).toBe("empty_value");
    }
  });
});

describe("readLoginConfig 缺少或损坏的固定值", () => {
  it("缺少 HAKO_LOGIN 绑定", () => {
    const result = readLoginConfig({ HAKO_LOGIN: undefined, HAKO_OWNER_SUBJECT: syntheticOwnerSubject });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("HAKO_LOGIN");
      expect(result.error.code).toBe("missing_binding");
    }
  });

  it("HAKO_LOGIN 不是对象", () => {
    const result = readLoginConfig(environmentWith({ HAKO_LOGIN: "https://hako.eruoo.me" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_shape");
    }
  });

  it("HAKO_LOGIN 字段缺失或类型错误", () => {
    for (const bad of [
      { ...formalDeploymentConfig, origin: 123 },
      { ...formalDeploymentConfig, issuer: undefined },
      { issuer: "https://auth.eruoo.me", clientId: "hako-web", resource: "https://auth.eruoo.me/api" },
    ]) {
      const result = readLoginConfig(environmentWith({ HAKO_LOGIN: bad }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_shape");
      }
    }
  });

  it("clientId 为空被拒绝", () => {
    const result = readLoginConfig(
      environmentWith({ HAKO_LOGIN: { ...formalDeploymentConfig, clientId: "  " } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("clientId");
      expect(result.error.code).toBe("empty_value");
    }
  });
});

describe("readLoginConfig 非法 origin / issuer", () => {
  it.each([
    ["含路径", "https://hako.eruoo.me/app"],
    ["含 query", "https://hako.eruoo.me?x=1"],
    ["含 fragment", "https://hako.eruoo.me#top"],
    ["非 https", "http://hako.eruoo.me"],
    ["含显式端口", "https://hako.eruoo.me:8443"],
    ["含用户信息", "https://user:pass@hako.eruoo.me"],
    ["不可解析", "hako.eruoo.me"],
    ["空字符串", ""],
  ])("%s 的 origin 被拒绝", (_label, origin) => {
    const result = readLoginConfig(environmentWith({ HAKO_LOGIN: { ...formalDeploymentConfig, origin } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("origin");
      expect(result.error.code).toBe("invalid_https_origin");
    }
  });

  it("issuer 同样按 origin 规则校验", () => {
    const result = readLoginConfig(environmentWith({ HAKO_LOGIN: { ...formalDeploymentConfig, issuer: "https://auth.eruoo.me/login" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("issuer");
      expect(result.error.code).toBe("invalid_https_origin");
    }
  });
});

describe("readLoginConfig 生产配置混入本地地址", () => {
  it.each([
    ["localhost", "https://localhost"],
    ["子域 localhost", "https://app.localhost"],
    ["IPv4 环回", "https://127.0.0.1"],
    ["内网 10/8", "https://10.1.2.3"],
    ["内网 172.16/12", "https://172.16.0.9"],
    ["内网 192.168/16", "https://192.168.1.10"],
    ["链路本地", "https://169.254.1.1"],
    ["IPv6 环回", "https://[::1]"],
    ["IPv4 映射 IPv6 环回", "https://[::ffff:127.0.0.1]"],
    ["IPv4 映射 IPv6 内网", "https://[::ffff:10.1.2.3]"],
  ])("%s 的 origin 被拒绝", (_label, origin) => {
    const result = readLoginConfig(environmentWith({ HAKO_LOGIN: { ...formalDeploymentConfig, origin } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("origin");
      expect(result.error.code).toBe("local_address_not_allowed");
    }
  });

  it("issuer 与 resource 混入本地地址同样被拒绝", () => {
    const localIssuer = readLoginConfig(
      environmentWith({ HAKO_LOGIN: { ...formalDeploymentConfig, issuer: "https://auth.localhost" } }),
    );
    expect(localIssuer.ok).toBe(false);
    if (!localIssuer.ok) {
      expect(localIssuer.error.code).toBe("local_address_not_allowed");
    }

    const localResource = readLoginConfig(
      environmentWith({ HAKO_LOGIN: { ...formalDeploymentConfig, resource: "http://127.0.0.1:8787/api" } }),
    );
    expect(localResource.ok).toBe(false);
  });
});

describe("readLoginConfig resource 校验", () => {
  it.each([
    ["相对地址", "/api"],
    ["非 https", "http://auth.eruoo.me/api"],
    ["含用户信息", "https://user@author.example/api"],
    ["不可解析", "auth.eruoo.me/api"],
  ])("%s 的 resource 被拒绝", (_label, resource) => {
    const result = readLoginConfig(environmentWith({ HAKO_LOGIN: { ...formalDeploymentConfig, resource } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("resource");
      expect(result.error.code).not.toBe("empty_value");
    }
  });

  it("带路径的 HTTPS resource 是合法的（正式值即含 /api）", () => {
    const result = readLoginConfig(environmentWith({}));
    expect(result.ok).toBe(true);
  });
});

describe("readLoginConfig 不从请求推导", () => {
  it("环境输入不含任何请求字段，回调只由固定 origin 组装", () => {
    // 构造一个被“污染”了请求头形状的环境：多余字段不参与配置读取。
    const env = environmentWith({});
    const polluted = {
      ...env,
      Host: "attacker.example",
      Origin: "https://attacker.example",
      Referer: "https://attacker.example/",
    };
    const result = readLoginConfig(polluted);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.redirectUri).toBe("https://hako.eruoo.me/api/auth/callback");
      expect(result.config.redirectUri).not.toContain("attacker");
    }
  });
});
