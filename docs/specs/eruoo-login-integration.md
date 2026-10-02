# Hako × eruoo/server 登录接入规格

日期：2026-09-16；更新：2026-10-01

状态：正式域名已确认；eruoo/server 的客户端支持已在 staging 和 production 上线；Hako 登录后端已在本地实现（登录事务、OIDC code flow、本应用会话与退出），真实登录与线上联调待完成。服务端交付状态与合同见第 2、5 节；Hako 会话参数和 PWA 后备交互仍按第 6 节的建议与验证边界处理。

## 1. 目标与职责

让本人在 Hako 浏览器版和安装后的 PWA 中，通过 eruoo/server 已有的 GitHub / 通行密钥完成登录，再访问同一个人的 Hako 数据。

| 负责方 | 本次职责 |
| --- | --- |
| eruoo/server | 登记独立的 Hako OAuth 客户端；通过已有 OIDC 接口提供本人身份；维护客户端策略、协议校验、审计和恢复后的配置一致性。 |
| Hako | 发起授权、接收回调、验证身份，管理自己的会话；保护自己的同步、备份和恢复接口；处理 PWA 登录返回。 |
| owner | 已确认第 3 节的正式 HTTPS origin；按 eruoo/server 既有流程授权实际发布。 |

登录服务采用的产品决策见[重新设计记录](./redesign.md#已确认的产品需求)。本文是登录接入细节的唯一维护位置，[首版技术方案](./architecture-proposal.md#6-登录接入)只引用本文。

本次不包含 AI 代理、加油数据存储/同步、跨应用统一登出、原生 App 专用登录、动态客户端注册或通用应用管理平台。浏览器和各系统 PWA 使用同一个 Web 客户端登记，分别拥有自己的 Hako 会话。

接入沿用现有 Better Auth OAuth Provider；独立静态客户端及对应配置、校验和测试已在 eruoo/server 合入。采用 `none + PKCE`，Hako 后端保管 verifier，无需新增 eruoo 服务、API Key 或共享 client secret。

```text
浏览器 / PWA ── 发起登录 ──> Hako 后端（登录事务与本应用会话）
     │                            │
     └── 顶层授权跳转 ──> eruoo/server <── 后端兑换 code / UserInfo
     <── 回调 Hako ────────┘      │
                              既有 D1（身份、OAuth 配置）
```

## 2. 当前实现与接入状态

2026-09-26，eruoo/server [PR #55](https://github.com/eruoo/server/pull/55) 已合入 `main`，实现提交为 [`8b08a16e4e56925b32e1ad14beb15a2f2f8c7336`](https://github.com/eruoo/server/commit/8b08a16e4e56925b32e1ad14beb15a2f2f8c7336)。Hako 侧已核对合并提交与审查工作区的 Git tree 相同，且该提交的 [Check run 36227299104](https://github.com/eruoo/server/actions/runs/36227299104) 成功。第 3 节的核心客户端合同已有服务端实现，当前部署及接入状态见下表。

此前基于 `806250c1` 与 `d1609f55` 得出的“仅 Desktop 可用、尚无 Hako 登记”结论是实施前状态，已由本次交付取代。当前服务端协议以对应提交的 [protocol-contract.md](https://github.com/eruoo/server/blob/8b08a16e4e56925b32e1ad14beb15a2f2f8c7336/docs/specs/protocol-contract.md#4-oauthoidc-客户端契约)为准；实现对应关系见第 5 节。

| 范围 | 当前状态 |
| --- | --- |
| eruoo 客户端、身份读取与配套策略 | 已合入，核心协议满足本规格；服务端测试通过不等于 Hako 已接入。 |
| eruoo 远端迁移与部署 | 2026-09-27 两个环境均已发布上述精确提交并通过服务端验收；每环境仅应用 `0005`，五份迁移的 ledger/receipt/hash 与发布源码匹配，Hako 登记策略一致。发布证据及来源见下表。 |
| Hako Worker、OIDC 接入及本应用会话 | 本地已实现：同源 Worker（PR1）提供 `/api/auth/login`、`/api/auth/callback`、`/api/auth/session`、`/api/auth/logout`，使用 SQLite Durable Object 保存登录事务与会话，出站走普通公开 HTTPS；合成协议、失败路径与本地 workerd/DO 重启恢复已验证，见[本地验证进展](../local-validation.md#2026-10-02-pr2-oidc-登录事务do-会话与-eruoo-出站接线验证)。真实身份匹配与线上可达性待联调。 |
| 固定 owner、域名及 Worker 间接线 | 正式域名已确认；eruoo 任务已分别核实 production/staging 的持久 owner 身份，身份对存于本地接线记录。实际绑定、ID token 对照及端点可达性仍待联调；Service Binding 目标未核实，暂不采用。 |
| 真实浏览器/PWA 登录 | 尚未联调，iPhone 返回环境和会话保持不能由服务端合成测试代替。 |

2026-09-27，eruoo 任务回传以下发布结果。两个环境均为新版本 100% 活动流量；每环境 5 项发布冒烟和 8 项现场 OIDC 边界检查通过，覆盖 discovery/JWKS、匿名管理拒绝、合法 Hako 授权进入登录、精确回调、拒绝 offline scope、要求 S256 和拒绝 refresh。已有 AI 数据量保持不变。

| 环境 | 成功的发布流水线 | 活动 Worker version |
| --- | --- | --- |
| staging | [run 36299264063](https://github.com/eruoo/server/actions/runs/36299264063) | `9e41d49b-5db6-4067-ba5f-1e3a73e8fb57` |
| production | [run 36299580353](https://github.com/eruoo/server/actions/runs/36299580353) | `86e18043-5b7c-43ef-8355-abf94690f483` |

eruoo 任务使用浏览器已有 owner 会话确认两个环境的授权应用页可打开，并展示 Hako“仅用于登录，登录状态由应用管理”。本轮未重新执行真实 GitHub / Passkey 登录，也未完成 Hako 后端、ID token 全链路或 iPhone 联调。上述远端证据由 eruoo 任务提供，Hako 侧复用其结果，没有重复操作发布资源。正式 issuer、owner 身份和回调保持不变；后续 Hako 登录接入已无 eruoo 发布阻塞。

2026-09-26 较早从本机 GET 公开 discovery 返回 HTTP 403；随后 eruoo 任务核对两环境的 health/discovery 均返回 200，health 与实际活动版本一致，历史 403 未复现但原因未确认。Hako Worker 的实际调用仍待联调，不把该历史现象作为继续本地开发的阻塞。本轮复用 eruoo 的实现与检查记录，没有重新运行其完整测试或执行真实登录。

2026-10-01 接收的[服务端只读复核](#2026-10-01-服务端只读复核)确认上述发布状态未变；该核查仍不包含 Hako 真实登录与设备验收。

## 3. 客户端登记合同

`HAKO_WEB_ORIGIN` 是本文表示部署输入的名称，不强制要求新增同名环境变量。它必须是 owner 指定的唯一正式 HTTPS origin，不含路径、query、fragment、用户信息或末尾 `/`。正式回调固定为该 origin 加 `/api/auth/callback`，运行时不得由请求的 Host、Origin 或跳转参数推导登记值。

owner 已于 2026-09-26 确认正式域名，唯一正式 origin 与回调见下表。接收方可使用测试专用 `https://hako.test/api/auth/callback` 完成本地协议测试；这个地址不得进入生产登记。域名确认完成了登记输入的选择，DNS、Cloudflare 域名绑定及正式部署仍待实施。

| 项目 | Hako 配置值 / 要求 |
| --- | --- |
| `HAKO_WEB_ORIGIN` | `https://hako.eruoo.me`（用户已确认） |
| `client_id` / 展示名 | `hako-web` / `Hako` |
| `application_type` / platform | `web` / `web` |
| `token_endpoint_auth_method` | `none`；不发 client secret，不用 API Key 代替用户登录 |
| `redirect_uris` | 只有 `https://hako.eruoo.me/api/auth/callback`，以完整字符串精确匹配 |
| `grant_types` / `response_types` | 只有 `authorization_code` / `code` |
| `requirePKCE` | `true`，只接受 `S256` |
| `scope` 上限 | `openid profile`；拒绝 `api:read`、`api:write`、`offline_access` |
| `supportsOfflineAccess` | `false`；不签发 refresh token |
| `subjectType` | `public`，身份键为固定 issuer 与稳定 `sub` 的组合 |
| `resource` | `https://auth.eruoo.me/api`；使用现有 OIDC scope 映射 |
| `skipConsent` | `true`，与现有本人自用静态客户端政策一致；不跳过 owner 身份与授权请求校验 |
| `enableEndSession` | `false`；不登记 post-logout redirect 或 backchannel logout |
| DPoP | 本轮不启用，token type 为 `Bearer` |

`resource` 是现有协议必需参数，不表示 Hako 获得 eruoo 业务 API 读写权限。UserInfo URL 不作为第二个 `resource` 传入。首版不用 Hako origin 新建一个 OAuth resource，也不让 Hako API 直接接受上游 access token。

生产客户端禁止通配回调、任意端口、临时预览地址、localhost 或 loopback 地址；桌面端现有 loopback 端口规则仅继续作用于 native 客户端。测试使用合成配置与本地 D1；若另做 staging 联调，回调和 issuer 必须按该环境成对登记，不能加入生产白名单。

## 4. 请求、响应与身份合同

2026-09-16 实际读取的[公开 discovery](https://auth.eruoo.me/.well-known/openid-configuration)包含以下地址；2026-09-27 服务端发布验收及 Hako 待联调边界见第 2 节。Hako 从固定可信 issuer 读取 metadata 并核对 issuer，不接受浏览器指定任意发现地址。

| 用途 | 现有端点 |
| --- | --- |
| issuer | `https://auth.eruoo.me` |
| 授权 | `GET https://auth.eruoo.me/api/auth/oauth2/authorize` |
| 换取令牌 | `POST https://auth.eruoo.me/api/auth/oauth2/token` |
| 读取身份 | `GET https://auth.eruoo.me/api/auth/oauth2/userinfo` |
| 验签公钥 | `GET https://auth.eruoo.me/api/auth/jwks` |

### 4.1 授权与换取令牌

Hako Worker 对 discovery、JWKS、token 和 UserInfo 的请求也需要验证 Cloudflare Worker 间接线，不能只验证 AI 路径。[同 zone 的普通 Route 限制](https://developers.cloudflare.com/workers/configuration/routing/routes/)同样适用。若实际环境选择同账号 HTTP Service Binding，`oauth4webapi` 提供的 [customFetch](https://github.com/panva/oauth4webapi/blob/main/docs/variables/customFetch.md) 可作为适配入口，但仅允许固定 eruoo origin 和明确的协议端点，保持原始 URL、请求参数、AbortSignal 与响应语义；具体适配仍需联调。浏览器授权地址始终使用公开 HTTPS origin，不能改写成内部绑定名称。

1. Hako 后端建立短期登录事务，保存固定 issuer、client ID、精确回调、`state`、`nonce`、PKCE verifier 及发起环境凭据的哈希。上述随机值按每次登录重新生成，不与账号 ID、设备时间或长期会话复用。
2. 浏览器使用顶层 GET 跳转授权地址，参数为 `client_id=hako-web`、`response_type=code`、`response_mode=query`、精确 `redirect_uri`、`scope=openid profile`、既定 `resource`、`state`、`nonce`、`code_challenge` 与 `code_challenge_method=S256`。
3. eruoo 使用既有 GitHub / Passkey 登录与签名 continuation。授权 code 继续遵循现有 600 秒、单次使用及 client/redirect/resource/owner/PKCE 绑定规则，不为 Hako 放宽。
4. Hako 回调校验事务、过期/取消状态、`state` 及授权响应 `iss`。当前 discovery 声明支持授权响应 issuer，缺失或不匹配按失败处理。发起环境绑定按第 6 节处理。
5. Hako 后端以 `application/x-www-form-urlencoded` POST token，参数为 `grant_type=authorization_code`、`client_id=hako-web`、相同 `redirect_uri`、`resource`、回调 `code` 和原 verifier。无 client secret、Basic 凭证或 API Key。

Token 和 UserInfo 请求由 Hako 后端发出，不能转发浏览器 Cookie 或 Origin。现有 eruoo POST 入口会拒绝不匹配的 Origin；本方案不需要放宽该策略，也不需要开放浏览器跨域 token fetch。

### 4.2 成功响应与验证

- Token 响应保持原生 OAuth JSON，无自有业务包装：提供有效 `access_token`、`token_type=Bearer`、`expires_in`、`id_token`，不包含 `refresh_token`。如返回 `scope`，不得超出登记上限。access token 继续沿用现有 1 小时策略，Hako 不把该时长当作本应用会话期限。
- Hako 使用成熟 OIDC 库验证 ID token 的签名、可信算法与 JWKS、精确 `iss`、包含 `hako-web` 的 `aud`、适用的 `azp`、`exp` / `iat` / `nbf`、原 `nonce` 和适用的 `at_hash`。不能仅 decode JWT 就建立登录状态。
- 以 `(iss, sub)` 作为身份键，`sub` 必须为非空稳定标识且匹配预先配置的本人身份。`name`、`picture` 等只作可选展示，不以邮箱、昵称、GitHub 登录名或浏览器提交的 ID 绑定数据。
- Hako 后端使用刚取得的 access token，通过 `Authorization: Bearer` 读取 UserInfo；返回 `sub` 必须与已验证 ID token 相同。缺少姓名或头像不阻塞登录，身份不一致或依赖失败不能创建会话。
- eruoo 的 UserInfo 保留当前 owner 账号关联、签名、issuer、audience、到期、scope 与 Bearer 传输检查；客户端必须处于静态启用且持久登记有效的状态。不能把桌面 ID 判断替换为无条件接受任意有效 JWT。
- OAuth token、verifier、登录凭据和完整 code/state 不写日志，不返回给 Hako 前端，不进入 localStorage、IndexedDB 或加油备份。完成身份验证后不长期保留上游 token。

协议处理参考 [Better Auth OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider)、[OIDC Core 的 code flow 验证](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)与 [oauth4webapi OIDC 示例](https://github.com/panva/oauth4webapi/blob/main/examples/oidc.ts)。具体部署仍以仓库锁定版本和协议测试为准，不把最新文档能力直接当成当前配置已开放。

### 4.3 失败处理

继续使用原生 OAuth 错误和现有传输约定；不为 Hako 另造一套包装。未知/未启用客户端不得授权；无效回调不得向该地址附加 code/state/error；超范围 scope、resource 不匹配、重复 singleton 参数、无效 PKCE、过期或重复使用 code 均须失败。

Hako 将取消、过期、配置错误与服务暂时不可用分别转成可读提示。不能无限自动重定向；token 兑换遇到结果不明时，不盲目重复消费 code，可重新发起一次登录。所有失败保留本机记录和未同步修改。

## 5. eruoo/server 已合入的实现

以下是第 2 节实现提交中的仓库相对路径。它们已提供并上线 Hako 接入所需的核心能力，后续完成 Hako 实现和联调，不重新建立客户端管理系统。

| 位置 | 已实现的职责 |
| --- | --- |
| `src/shared/oauth.ts`、`src/shared/oauth-registration.ts` | 定义 `hako-web` 策略、安全字段和注册快照；离线访问能力由 scope 与 grant 推导，供运行时、恢复和发布共用。 |
| `migrations/0005_hako_oidc_client.sql` | 登记 `static-hako-web` 与 `static-hako-web-api`，复用现有 resource；upsert 支持旧快照恢复时已补种 Hako 的情况，保留既有迁移内容。 |
| `src/worker/oauth/client-policy.ts`、`protocol.ts` | 校验当前客户端的静态启用状态、完整 D1 登记、resource 关联、精确回调及 scope/grant/PKCE 等条件。 |
| `src/worker/oauth/authorization-code.ts`、`src/worker/auth.ts` | 在授权码持久化前复核客户端策略及有效 owner Session，覆盖直接授权与登录续接；成功审计使用实际 client 与 subject。 |
| `src/worker/oauth/userinfo.ts` | 验签后读取对应客户端策略并验证 owner，保留 issuer、audience、期限、scope 与 Bearer 载体检查。 |
| `scripts/lib/restore-database.ts`、`scripts/build-release.ts`、`scripts/deploy-release.ts` | 按同一策略恢复客户端；产物保存注册快照，迁移后、Worker 切换前验证完整注册集合。 |
| `src/worker/oauth/authorizations.ts`、`src/shared/oauth-authorizations.ts`、授权列表界面 | 只聚合静态启用的客户端；明确 Hako 自己管理登录状态，不以没有 consent/refresh 记录判断其是否登录。 |
| `tests/worker/oauth-client-policy.test.ts`、`oauth-guard-regressions.test.ts` 及相关恢复/浏览器测试 | 覆盖 Hako code flow、ID token/UserInfo、无 refresh、权限和登记漂移、持久 owner/Session、审计及登录续接；已有检查结果见第 9 节。 |

现有 provider、动态注册禁用和 owner 限制继续保留。Hako 不使用 refresh grant；不能为 Web 接入扩大其离线授权或 end-session 能力。

迁移、静态声明和恢复生成结果必须一致；登记缺失或漂移要明确失败。保持未知/未启用客户端不接受授权，不提供通过请求自动补登记的路径。

## 6. Hako 配合要求

本节界定调用方需要完成的工作，不要求 eruoo/server 为 PWA 增加专用授权协议。

### 6.1 本应用会话与 owner 配置

- 建议 Hako 后端使用 `oauth4webapi` 完成标准协议验证；对外建立自己的随机会话，Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`，不设置跨域 Domain。后端保存会话凭据哈希、固定身份和到期时间。
- 登录保持遵循[已确认的产品需求](./redesign.md#已确认的产品需求)：自己的设备尽量长期保持登录。撤下原先登录起 30 天绝对到期的建议；本轮给出下表中的续期参数，仍是待审阅建议，尚未实测。
- 使用中延长 Hako 自己的有效会话，同时保留退出、撤销和过期校验；不申请 `offline_access`、不保存上游 refresh token。Hako 服务端续期不等于重新执行 OIDC 登录，失效会话不得靠续期恢复。
- 本人 `sub` 由 eruoo 侧在受控环境核对现有 owner 用户后提供，并由 Hako 部署配置固定。2026-09-26 两环境的 `(issuer, sub)` 已分别只读核实，保存于 Git 忽略的 `hako-oidc.local` 接线记录；该文件目前不是应用自动加载的配置，也不会随 Git 克隆或 worktree 创建转移。接线前按环境取得对应身份对并配置后端，实际 subject 不写入公开文档、前端或日志；真实 ID token 的匹配仍待联调。不能让第一次公开访问或第一次成功回调自动认领 owner；缺少配置时不能启用云端身份访问。
- Hako 的状态变更 API 校验本应用会话与精确 Origin。首次登录需要联网；已有关联身份的本机数据在会话过期或断网时仍可使用，云端同步等待重新登录。
- Hako 退出使自己的当前会话及当前环境未完成的登录事务失效，不自动删除本机记录。eruoo 管理会话退出、撤销授权或停用客户端，不被表述为已经即时撤销 Hako 的独立会话；需要停用已建立的 Hako 会话时由 Hako 执行。

2026-09-23 补充核查：[Better Auth 会话文档](https://better-auth.com/docs/concepts/session-management)提供使用达到更新间隔后延长有效期的现有机制，作为续期行为的参考，不表示 Hako 已新增 Better Auth 或采用它的默认时长。[WebKit 跟踪防护](https://webkit.org/tracking-prevention/#intelligent-tracking-prevention-itp)说明主屏幕 Web App 的第一方域名豁免脚本可写存储的 7 天清理规则；[存储策略](https://webkit.org/blog/14403/updates-to-storage-policy/)另明确其配额与持久存储讨论不覆盖 Cookie。不能把存储持久化获准等同于登录永久有效；用户提供的 iPhone 环境仍需实测登录返回、重开与会话保持。

| 会话项 | 本稿建议 |
| --- | --- |
| 初次与续期有效期 | 180 天；正常使用可延长，长期不用时自然过期 |
| 续期频率 | 距上次成功续期至少 24 小时；随既有前台同源同步请求处理，包括无业务变更的版本检查，不增加后台保活任务 |
| 绝对有效期 | 自这次 OIDC 登录创建会话起最多 365 天；续期不能越过，达到后重新登录 |
| Cookie 有效期 | 后端通过 Set-Cookie 设置持久 Cookie，Max-Age 按服务端剩余有效期计算；续期先持久保存，再返回新有效期，不由前端修改 Cookie |
| 已失效会话 | 已过期、退出或撤销的会话不能续期；重新登录生成新的随机凭据 |

服务端以自己的时钟判断有效性，在同一原子操作中检查当前会话并更新到期时间，取“当前时间加 180 天”和“创建时间加 365 天”中较早者；并发续期不得缩短已保存的有效期，撤销后不得被在途续期重新创建。续期仅发生在身份、精确 Origin 和请求格式均校验通过的同步请求中，GET 状态读取及失败请求不续期。会话变化不写入加油 CRDT 或触发业务版本备份。

这些天数是针对本人低频使用提出的产品取舍，不是浏览器保证，也不是安全标准推荐值。[OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#session-expiration)支持按应用特点设置并在服务端执行不活动与绝对到期边界，其示例远短于本稿。选择长期保持会增加凭据泄露后的可利用时间，保留服务端撤销与每年重新认证的边界；本机离线记录不因云端会话过期而删除。

### 6.2 浏览器 / PWA 发起环境绑定

常规路径优先让登录在发起它的浏览环境完成。Hako 用短期 HttpOnly 事务凭据绑定该环境；`state` 只用于定位和校验 OAuth 事务，不能单独作为领取 Hako 会话的凭据。建议事务有效期 10 分钟，单次使用；重新发起使同一环境旧事务失效，取消或过期后迟到回调不能恢复登录。

若回调携带匹配的原事务 Cookie，验证身份后可直接完成登录。若 iPhone 将授权打开到与原 PWA Cookie 隔离的浏览器，不能仅凭外部回调成功就将原 PWA 自动置为已登录：他人可先发起事务再转发授权链接，纯后台轮询会让发起者领取 owner 会话。

本稿建议隔离场景使用显式完成码作为后备流程：

1. 外部回调完成 OAuth 身份验证后，生成新的 8 位数字一次性完成码，只在该回调结果页显示。该码与原 `state`、code、verifier 无关，不出现在 URL、日志或原 PWA 的状态轮询响应中。
2. 用户回到发起登录的 Hako PWA 输入完成码；后端同时验证原事务 Cookie、完成码、本人身份与事务有效期，原子消费事务并建立 Hako 会话。
3. 完成码最长有效 5 分钟，且不得超过事务剩余期限；服务端只保存哈希。每个事务最多 5 次错误尝试，超限结束事务；完成请求继续受正常入口限流保护。
4. 重复回调不得重新兑换 code 或泄露已生成的完成码，其他环境不能领取该事务。完成响应丢失时允许重新发起登录，不通过重复消费旧事务补发任意会话。

这补强了早期方案“外部授权后原 PWA 自动完成”的发起环境绑定条件。完成码属于 Hako 的建议交互，尚未由用户确认或通过真机验证；若同环境返回实测可行，正常登录不出现该步骤。无论最终采用何种交互，“只转发授权链接便能让原发起者自动领取 owner 会话”的测试必须失败。安全依据参考 [OAuth Security BCP 的 CSRF 防护](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.7)。

建议 Hako 内部路由固定为 `POST /api/auth/login`（创建事务）、`GET /api/auth/callback`（唯一 OAuth 回调）、`POST /api/auth/complete`（隔离场景完成）、`GET /api/auth/session` 和 `POST /api/auth/logout`。除注册回调外，这些是 Hako 内部接口，不增加 eruoo 的调用面。回调结果页与会话接口使用 `Cache-Control: no-store`，回调页设置 `Referrer-Policy: no-referrer`，不加载第三方资源；PWA Service Worker 不缓存认证响应。

### 6.3 下一步 Hako 最小实现范围

eruoo 发布已完成；Hako 先完成同源 Worker 的登录闭环，再接正式服务联调，不将同步、R2 备份、统计或 AI 识图作为登录前置。

2026-10-02：本地已按第 4 节与本节完成认证入口、OIDC 登录事务与回调、本应用会话与退出（PR2），证据见[本地验证进展](../local-validation.md#2026-10-02-pr2-oidc-登录事务do-会话与-eruoo-出站接线验证)。页面衔接、草稿保护与本机数据（PR3）、真实登录和真机验证仍待完成。

| 本地工作 | 完成条件 |
| --- | --- |
| Worker 与固定配置 | 提供第 6.2 节的认证入口；固定 origin、issuer、client 与 owner。缺少 owner 配置时不建立会话，不从首次访问认领账号。 |
| OIDC 登录事务与回调 | 使用第 4 节的合同及成熟库，验证发起环境、state/nonce/PKCE、ID token 和 UserInfo；事务只能完成一次。 |
| 本应用会话与退出 | 实现第 6.1 节的服务端持久会话、Cookie 与原子撤销；用测试时钟验证期限。续期随后续已授权前台同步处理，不添加独立后台保活任务。 |
| 页面衔接与本机数据 | 能显示登录状态、退出及可读错误；认证失败或会话过期保留本机记录和未保存输入，现有验证数据库不自动认领为正式账号数据。 |
| 本地验证 | 用合成身份与受控协议响应覆盖正常往返、错误身份/事务、重放、过期及退出；实际 Worker 接线和 iPhone 行为在对应环境补验。 |

当前草稿仅在页面内存中，登录跳转前的保护与返回后的恢复方式仍待确定。实施时须覆盖正常返回、取消和失败后的草稿保留，不能把离页提示当作已实现恢复。

本地合成调用方不向生产登记临时回调。隔离环境完成码仍是第 6.2 节的后备交互建议；先验证普通浏览器路径，iPhone 确实发生隔离时再确认和验证后备交互，发起环境绑定不能省略。

## 7. 验收要求

### 7.1 eruoo/server 自动化验收

| 场景 | 必须证明的结果 |
| --- | --- |
| 标准 Hako code flow | 真实插件完成 PKCE 授权、兑换；ID token 的 aud/nonce 与请求一致；UserInfo sub 相同；响应无 refresh token。 |
| GitHub / Passkey continuation | 现有签名授权上下文在两种登录后保留正确 Hako client、redirect、state、nonce；过期上下文不会循环重试。 |
| client 与回调 | 未知、停用、静态/持久配置缺失或漂移均失败；回调的路径、query、fragment、端口、编码变体不能扩大匹配。 |
| 权限边界 | Hako 请求任一业务 scope、offline scope 或 refresh grant 均被拒绝；原桌面授权与 refresh/revoke 行为继续通过。 |
| resource | 缺失、未知、兑换时不匹配均失败；有且只有正确关联时 openid/profile 流程成功。 |
| 授权凭据 | 错误 verifier、非 S256、重复/过期 code、错误 client、重复 singleton 参数失败，不能产生更大权限。 |
| UserInfo | 非 owner、非登记 client、过期/错误 audience token 失败；query/body token 继续被拒绝。 |
| 审计 | 直接授权与 continuation 都记录 `hako-web`；桌面仍记录桌面 ID；失败不记成功，不泄露凭据。 |
| 授权列表 | 新客户端不会触发全表一致性错误；界面准确说明 Hako 无离线续期能力，不声称可以从 eruoo 注销其独立会话。 |
| 数据迁移与恢复 | 空库与现有库向前迁移均得到同一策略；恢复后 Hako 不获得 refresh/end-session 能力；其他身份与桌面配置不受影响。 |

实施方在现有 Node 24 / pnpm 11 工具链下完成测试。以下保留为后续相关变更的验证入口；本次 Hako 文档对齐复用第 9 节已有结果，不重复执行整套检查：

```sh
pnpm run test tests/worker/oauth-client-policy.test.ts tests/worker/oauth-guard-regressions.test.ts tests/worker/oauth-flow.test.ts
pnpm run test:scripts scripts/restore-database.test.ts
pnpm run check
pnpm run build:release staging
pnpm run build:release production
```

新增 Hako 专项用例必须纳入现有 `test` / `test:scripts` / `test:client` 套件，`check` 会完整覆盖；不以只跑现有桌面测试代替 Hako 验收。构建、目标环境检查及发布产物按 eruoo 的 `operations.md` 执行，正式 origin 输入不得在构建后被临时替换。

### 7.2 Hako 联调与实机验收

1. 桌面 Chrome、Android Chrome、iPhone Chrome 与安装后的 PWA 分别完成登录、退出和过期后重新登录；记录实际测试系统及浏览器版本。
2. iPhone 真机验证回调是否保留发起环境；隔离时按第 6.2 节建议完成。桌面 WebKit 模拟不能替代此项。
3. 错误 state/nonce/iss/aud/sub、未知签名、错误完成码、过期/取消事务、并发或重复完成请求都不能建立错误会话。
4. 环境 A 发起登录、环境 B 打开转发链接并授权：A 仅轮询状态不能登录；没有 A 的事务 Cookie 或没有正确完成码都不能完成隔离流程。
5. 身份服务或 UserInfo 不可用时有明确提示，不新建会话、不循环跳转；本机记录与未同步修改保留，已有有效 Hako 会话按自身规则工作。
6. 浏览器 JavaScript、缓存、URL、日志和业务备份中不存在上游 token、verifier 或 Hako 会话凭据；UserInfo 可选展示字段缺失仍可登录。
7. 用可控服务端时钟验证 24 小时续期间隔、180 天有效期、365 天绝对上限、过期后拒绝续期，以及续期与退出并发时不会恢复失效会话；这不能代替 iPhone 真机对 Cookie 保存的验证。

## 8. 接线、发布与回退

eruoo/server 已作为一个完整功能变更合入，使用合成 Hako 调用方完成协议验证，并于 2026-09-27 完成 staging 与 production 发布验收，结果见第 2 节。Hako 侧会话/PWA 联调仍是 Hako 登录开放条件，不需要等待全部加油业务页面完成。

正式 origin 已由 owner 确认，登记值统一使用第 3 节；本人稳定身份对已按第 6.1 节核实，待写入对应 Hako 后端部署配置。它们都不是新的第三方密钥。Cloudflare 发布权限继续由各仓库现有发布环境持有；Hako 前端不接收部署凭据，eruoo 现有 GitHub / Passkey 配置继续复用。

发布按 eruoo 当前“检查构建 → 选择精确 SHA 与环境 → 向前迁移 → 发布 → 冒烟验证”流程，授权以 owner 对该次操作的明确指令为准。先核对目标环境实际活动版本与迁移记录，完整说明待执行迁移的数据影响；不能把本版本发布一概描述为只应用 `0005`。本地准备不触发远端迁移或部署。

2026-09-26 的发布前只读核查确认：staging 与 production 各自的库身份、活动版本及四份迁移哈希均与对应记录一致，当时仅待 `0005`，不会重跑 `0004` 的 AI 数据重置。已有 AI 数据保留；版本差异还包含 PR #54 的 AI 请求边界修复，不能将整个发布描述为只改 Hako。Wrangler 配置、lockfile、旧迁移及备份 Workflow 未变。这是发布前快照，已执行结果见第 2 节；后续发布仍以当次核验结果为准。

当前静态策略及 `0005` 在各环境登记的都是第 3 节的正式回调；staging 的 issuer 与 production 不同。因此 staging 默认先验证服务端部署及协议，不能将其与正式 Hako 的 issuer/owner 配置混用。如确需独立 Hako staging 端到端联调，再成对配置测试 origin、issuer、owner 和隔离存储，并同步服务端策略、登记及构建快照；不只手改 D1 回调，也不把测试地址加入生产白名单。

2026-09-26 用户要求适当简化准备，以完成 Hako 需求为主。eruoo 任务用精确旧 SHA `d1609f55` 完成隔离 workerd/D1 对照：`0001–0004` 基线 64/64 通过，加入原始 `0005` 后 63/64 通过，唯一差异是已授权应用列表由 200 变为 503。覆盖到的 GitHub owner/非 owner、Session、API Key（含 AI Key）及 Desktop code/refresh/UserInfo/撤销用例仍通过，旧授权入口继续拒绝 Hako。这是本地对照结果，不是线上回退演练。

据此采用短发布窗口作为最小方案，不再把登记/开放拆分或额外中间版本作为默认前置。迁移至 Worker 切换之间可能出现上述列表降级；实际执行前向 owner 说明影响，并按同一版本串行完成迁移、部署和冒烟。若失败需要应急代码回退，保留全部 D1 数据及 `0005` ledger/receipt，使用各环境发布前记录的精确旧 Worker version，明确授权列表仍会降级，不能称为全功能恢复。旧 token 路径也不能承担新客户端策略的完整约束，代码回退不等于撤销已签发的 Hako 凭据或 Hako 本应用会话。

正常恢复优先向前重新发布 `8b08a16` 或包含完整 `0001–0005` 的修复版本，不用旧 SHA 的常规发布流程删除迁移历史，也不为回退删除 Hako 登记或其他业务数据。精确平台 version、执行记录和恢复步骤由 eruoo 运维/实施记录维护，实际恢复须依据当次状态及授权。

本次已按 eruoo staging 的迁移、部署及针对性验收 → 同一候选的 production 发布与冒烟完成服务端发布，剩余为 Hako 实现与正式登录联调。Hako 本地登录实现可与服务端发布并行；服务端发布不要求 Hako 全部业务完成，Hako 开放登录则需要回调、固定身份、会话和实际接线均就绪。本次发布授权限于确定的 SHA、环境及 `0005` 范围，不由文档更新触发新的发布。

接收方完成后回传：实现 commit、实际客户端参数与回调、测试结果、登记/恢复/回退验证、已发布或未发布状态，以及是否存在与本稿不同的协议选择。若未进行真实登录或 iPhone 测试，明确列为未验证。

## 9. 核查与交付记录

### 2026-09-16 规格编制

- 已读取 Hako 当前决策、eruoo 协议规格、相关实现、数据库基线、恢复生成器、测试调用方与发布脚本入口；已对公开 discovery 做只读连通性核查。
- 已核查 Better Auth 与 oauth4webapi 官方文档/示例，以及 OIDC / OAuth Security BCP 的身份与发起环境验证要求。
- 本次只交付规格及其索引和引用更新；没有修改应用代码、eruoo-server 仓库、数据库、账户权限或线上配置，没有进行真实登录、构建或协议测试。

### 2026-09-26 接入复核与域名确认

- 固定提交复核结果及线上连通性限制见第 2 节；域名确认值见第 3 节。
- 域名确认时，Hako 仍是本地表单验证应用，eruoo 的 Hako 支持尚未合入；该服务端状态已由下节更新。
- 本轮只更新文档并检查差异及引用；未执行 DNS 配置、客户端登记、远端迁移或部署，未重新运行应用测试。

### 2026-09-26 服务端交付核对与最小准备

- 已核对 PR #55 的合并状态、合并提交与审查源码的 tree 一致性，以及该提交 CI 成功。服务端完整检查 656 项、针对性消融验证及本地构建结果复用 eruoo 的实施记录，本任务没有重新执行或将它们称为线上验收。
- 已将 Hako 本地工作收敛为第 6.3 节的登录切片，并与 eruoo 任务分工：Hako 维护接入规格和本地开发范围；eruoo 核对实际活动版本、迁移影响及最小发布/恢复步骤。
- 本地逐项比较了第 3 节与已合入源码的 17 个客户端策略字段，结果一致；4 份改动文档的 39 个本地链接/锚点及空白检查通过。
- eruoo 任务回传了两个环境的只读活动版本、迁移账本/receipt 与 owner 身份核查结果。已保存 Git 忽略的本地身份交接记录；实际身份值不写入公开规格或前端。
- eruoo 任务完成旧版本加 `0005` 的隔离回退对照，双方据此采用第 8 节的短窗口和保留数据的应急代码回退方案，未要求额外中间版本。相关真实状态和对照结果由该任务提供，Hako 侧未重复访问 D1 或执行回退。
- 本次准备更新文档与本地身份交接记录，并核对合同和引用；Hako 登录运行代码仍待实现，没有执行远端配置、迁移、部署或真实登录。

### 2026-09-27 服务端上线结果接收

- 已接收 eruoo 任务的双环境发布与现场验收结果，第 2 节维护精确提交、发布流水线、活动版本和未验证边界；第 8 节的发布前状态已标为历史快照。
- 本次仅同步 Hako 接入文档及进度引用，未修改应用代码或操作 eruoo 发布资源；Hako 自身部署、完整登录和 iPhone 联调仍待完成。

### 2026-10-01 服务端只读复核

以下记录接收自 eruoo/server 于 2026-10-01 18:07（Asia/Shanghai）提供的只读核查。来源是服务端的本地交接记录 `docs/handoff-2026-10-01.md`，原始快照保存在该工作区的 `.output/handoff-20261001/`，不随 Hako 仓库分发；精确提交、发布流水线和 Worker version 仍见第 2 节。

- 服务端 `main` 与两环境活动版本仍对应第 2 节的发布，两次发布流水线均为 success；活动版本均承载 100% 流量，`RELEASE_SHA=8b08a16`。
- D1 的 `0001` 至 `0005` 迁移账本、receipt 和文件哈希仍匹配；health 与 OIDC discovery 均返回 200，version 和 issuer 对应各自环境。
- 现场 OIDC 验收继续复用 2026-09-27 每环境 5 项发布冒烟和 8 项边界检查的结果；本次没有重新执行真实登录或 Hako 端到端验收。

Hako 侧只接收并归档上述证据，没有重复访问远端资源。应用代码、测试、依赖及构建输入相对本地验证版无改动，继续复用[2026-09-26 的验证结果](../local-validation.md#2026-09-26-操作流程复测)；本次整理未重新运行应用检查或执行部署。

### 2026-10-02 Hako 本地登录后端与公开发现只读核对

- Hako 本地实现登录事务、OIDC code flow、SQLite Durable Object 会话与退出，并使用合成 owner 与受控 OIDC 响应完成协议、失败路径与本地 workerd/DO 重启恢复验证；实现范围、证据与未验证边界见[本地验证进展](../local-validation.md#2026-10-02-pr2-oidc-登录事务do-会话与-eruoo-出站接线验证)。本节只更新进度表述，不改动第 3、4、6 节的合同。
- 只读核对 `GET https://auth.eruoo.me/.well-known/openid-configuration`（2026-10-02，返回 200）：`userinfo_endpoint` 存在、`code_challenge_methods_supported: [S256]`、`authorization_response_iss_parameter_supported: true`、`id_token_signing_alg_values_supported: [EdDSA, RS256]`、`subject_types_supported: [public]`，与本规格一致；未访问任何受保护资源或执行真实登录。
- 出站采用普通公开 HTTPS 路径；同账号 Service Binding 的绑定目标未经核实，Hako 侧不猜测也不配置。
