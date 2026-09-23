# Hako × eruoo/server 登录接入规格

日期：2026-09-16  
状态：交接评审稿；用户已要求编写本规格，尚未实施、联调或部署。文中工程参数是本轮建议，不表示 Hako 整体技术方案已经确认。

## 1. 目标与职责

让本人在 Hako 浏览器版和安装后的 PWA 中，通过 eruoo/server 已有的 GitHub / 通行密钥完成登录，再访问同一个人的 Hako 数据。

| 负责方 | 本次职责 |
| --- | --- |
| eruoo/server | 登记独立的 Hako OAuth 客户端；通过已有 OIDC 接口提供本人身份；维护客户端策略、协议校验、审计和恢复后的配置一致性。 |
| Hako | 发起授权、接收回调、验证身份，管理自己的会话；保护自己的同步、备份和恢复接口；处理 PWA 登录返回。 |
| owner | 在正式登记前提供 Hako 正式 HTTPS origin；按 eruoo/server 既有流程授权实际发布。 |

登录服务采用的产品决策见[重新设计记录](./redesign.md#已确认的产品需求)。本文是登录接入细节的唯一维护位置，[首版技术方案](./architecture-proposal.md#6-登录接入)只引用本文。

本次不包含 AI 代理、加油数据存储/同步、跨应用统一登出、原生 App 专用登录、动态客户端注册或通用应用管理平台。浏览器和各系统 PWA 使用同一个 Web 客户端登记，分别拥有自己的 Hako 会话。

推荐最小路径：沿用现有 Better Auth OAuth Provider，新增一个静态客户端和对应配置、校验及测试；不新增 eruoo 服务、API Key 或共享 client secret。初期沿用服务器当前的 `none + PKCE` 客户端策略，Hako 后端保管 verifier。若接收方要求改用机密客户端认证，应集中反馈原因与额外凭证维护成本，不静默改变本合同。

```text
浏览器 / PWA ── 发起登录 ──> Hako 后端（登录事务与本应用会话）
     │                            │
     └── 顶层授权跳转 ──> eruoo/server <── 后端兑换 code / UserInfo
     <── 回调 Hako ────────┘      │
                              既有 D1（身份、OAuth 配置）
```

## 2. 当前证据与需要改动的原因

核查基线为 eruoo-server 本地 `806250c1b1ea9c7a8bace499caa20839a691e9bd` 的相关实现。当前工作区另有 AI 服务文档改动，不属于本规格；本次未修改该仓库。线上只进行了公开 discovery 的 GET，没有真实登录，也没有读取生产数据库，因此以下源码事实不等于已核验线上所有运行配置。

| 已确认事实 | 接入影响 |
| --- | --- |
| `src/shared/oauth.ts` 只启用 `eruoo-desktop`；Web/Mobile ID 仅保留 | 必须新增 `hako-web`，不能借用桌面端或直接启用 `eruoo-web` 代替 Hako。 |
| `src/worker/oauth/protocol.ts` 同时检查静态客户端、精确回调、D1 登记、PKCE 和 `tokenEndpointAuthMethod=none` | 只加静态 client ID 或只插数据库均不能完成接入。 |
| `src/worker/oauth/userinfo.ts` 只接受桌面客户端；`handler.ts` 授权审计写死桌面 ID | 需要按已登记客户端策略放行并记录真实身份，保留 owner 与 token 校验。 |
| `auth.ts` 启用 `enforcePerClientResources`；授权和 code exchange 必须传 `resource` | Hako 必须登记既有 resource 关联，并在两次请求中使用同一值。 |
| `scripts/lib/restore-database.ts` 重建所有启用客户端，统一填入 refresh grant 与 end-session 能力 | 必须按客户端策略恢复，避免恢复后给 Hako 扩权。 |
| `oauth/authorizations.ts` 校验 D1 客户端集合与静态启用集合完全一致 | 新登记、恢复和回滚要同时保持两侧一致，否则会影响整个授权应用列表。 |

现有协议权威来源为 eruoo/server 的 `docs/specs/protocol-contract.md`。本文提出新增 Hako Web 客户端，因此实施时必须同步更新其中“仅启用 Desktop”的范围描述；其他已有协议边界继续生效。

## 3. 客户端登记合同

`HAKO_WEB_ORIGIN` 是本文表示部署输入的名称，不强制要求新增同名环境变量。它必须是 owner 指定的唯一正式 HTTPS origin，不含路径、query、fragment、用户信息或末尾 `/`。正式回调固定为该 origin 加 `/api/auth/callback`，运行时不得由请求的 Host、Origin 或跳转参数推导登记值。

当前正式域名尚未提供。接收方可先用测试专用 `https://hako.test/api/auth/callback` 完成本地协议测试；这个地址不得进入生产登记。正式登记和发布必须在收到实际 origin 后完成，缺失时保持 Hako 客户端未启用。该输入不影响下面的协议、代码职责与测试要求。

| 项目 | Hako 建议值 / 要求 |
| --- | --- |
| `client_id` / 展示名 | `hako-web` / `Hako` |
| `application_type` / platform | `web` / `web` |
| `token_endpoint_auth_method` | `none`；不发 client secret，不用 API Key 代替用户登录 |
| `redirect_uris` | 只有 `HAKO_WEB_ORIGIN + /api/auth/callback`，以完整字符串精确匹配 |
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

2026-09-16 实际读取的[公开 discovery](https://auth.eruoo.me/.well-known/openid-configuration)包含以下地址。Hako 从固定可信 issuer 读取 metadata 并核对 issuer，不接受浏览器指定任意发现地址。

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

## 5. eruoo/server 实施清单

以下是该仓库的相对路径。预计代码、迁移、测试和规格合计超过 8 个文件，仍在已有身份服务内完成，不新增服务。

| 位置 | 需要完成的变更 |
| --- | --- |
| `src/shared/oauth.ts` | 增加 `hako-web` 类型与静态声明。用同一客户端策略描述/派生 scope、grant、离线访问和 end-session 能力，供运行时与恢复使用。 |
| 新增向前数据迁移；现有基线为 `migrations/0001_foundation.sql` | 新增 `oauthClient` 与 `oauthClientResource` 登记，不修改已发布基线、不重建库。建议稳定 ID 为 `static-hako-web` 与 `static-hako-web-api`。现有 resource 复用；所有字段满足第 3 节。 |
| `src/worker/oauth/protocol.ts` | 支持新的 Web 客户端，保留精确 redirect、PKCE 与配置一致性校验；补上或通过真实插件测试证明 per-client scope/grant 上限在授权和兑换时均生效。 |
| `src/worker/oauth/userinfo.ts` | 将桌面专属判断改为已登记启用客户端的身份读取策略，并校验持久登记；保留其余 token 与 owner 条件。 |
| `src/worker/oauth/handler.ts` | 审计记录来自已验证的授权上下文或授权记录的 client ID。直接授权、登录续接和 consent 路径都覆盖；不能信任未经验证的前端 client ID，也不能用桌面 ID 兜底。 |
| `scripts/lib/restore-database.ts`、`scripts/restore-database.test.ts` | 恢复时为 Hako 重建准确回调、scope、`authorization_code` grant、PKCE、`enableEndSession=false` 和 resource 关联；扩充一致性验证，不能只比较客户端名字集合。 |
| `src/worker/oauth/authorizations.ts`、`src/shared/oauth-authorizations.ts`、授权列表界面 | 正确包含 Hako，`supportsOfflineAccess=false`。现有列表是 OAuth 授权信息，不是 Hako 当前会话列表；不得把“没有 refresh token / consent 记录”解释成 Hako 一定未登录。必要时调整说明，不新增会话管理 API。 |
| `tests/worker/fixtures/oauth.ts` 与 OAuth 测试 | 增加可显式指定 client/redirect/scope 的测试调用方，保留桌面用例；加入第 7 节的 Hako 专项测试。 |
| `docs/specs/protocol-contract.md`、`docs/specs/operations.md`、相关验收文档及 OpenAPI | 更新启用客户端范围、登记与恢复流程、会话边界和验收证据。共享 schema 增加 client ID 后检查 OpenAPI 漂移。 |

`src/worker/auth.ts` 的现有 provider、动态注册禁用、owner 限制与受信客户端集合继续复用。`oauth/families.ts` 里的桌面 refresh/revoke 专属分支不因本次接入机械放开：Hako 不使用 refresh grant，必须通过测试确认无法获得或使用该能力。

迁移、静态声明和恢复生成结果必须一致；登记缺失或漂移要明确失败。保持未知/未启用客户端不接受授权，不提供通过请求自动补登记的路径。

## 6. Hako 配合要求

本节界定调用方需要完成的工作，不要求 eruoo/server 为 PWA 增加专用授权协议。

### 6.1 本应用会话与 owner 配置

- 建议 Hako 后端使用 `oauth4webapi` 完成标准协议验证；对外建立自己的随机会话，Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`，不设置跨域 Domain。后端保存会话凭据哈希、固定身份和到期时间。
- 登录保持遵循[已确认的产品需求](./redesign.md#已确认的产品需求)：自己的设备尽量长期保持登录。撤下原先登录起 30 天绝对到期的建议；本轮给出下表中的续期参数，仍是待审阅建议，尚未实测。
- 使用中延长 Hako 自己的有效会话，同时保留退出、撤销和过期校验；不申请 `offline_access`、不保存上游 refresh token。Hako 服务端续期不等于重新执行 OIDC 登录，失效会话不得靠续期恢复。
- 本人 `sub` 由 eruoo 侧在受控环境核对现有 owner 用户后提供，并由 Hako 部署配置固定。不能让第一次公开访问或第一次成功回调自动认领 owner；缺少配置时不能启用云端身份访问。
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

实施方在现有 Node 24 / pnpm 11 工具链下完成测试。以下命令来自该仓库现有 scripts；本次编写规格没有运行这些应用检查：

```sh
pnpm run test tests/worker/oauth-flow.test.ts tests/worker/auth-regressions.test.ts tests/worker/oauth-races.test.ts
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

本接入可作为 eruoo/server 一个完整功能变更合入：使用合成 Hako 调用方完成协议验收，不依赖 Hako 全部业务页面完成。Hako 侧会话/PWA 联调是 Hako 发布条件，不能把服务端测试通过表述为五端已可用。

正式接线需要两个已明确负责人的输入：owner 提供实际 `HAKO_WEB_ORIGIN`；eruoo 实施方核对并向 Hako 提供本人稳定 `sub`。它们都不是新的第三方密钥。Cloudflare 发布权限继续由各仓库现有发布环境持有；Hako 前端不接收部署凭据，eruoo 现有 GitHub / Passkey 配置继续复用。

发布按 eruoo 当前“检查构建 → 选择精确 SHA 与环境 → 向前迁移 → 发布 → 冒烟验证”流程，授权以 owner 对该次操作的明确指令为准。本规格不触发另一任务、不授权远端迁移或部署。

特别注意客户端集合的过渡期：当前旧代码要求 D1 只包含原启用客户端，新代码要求包含 Hako。先执行新增登记迁移而代码尚未切换时，旧授权列表可能暂时失败。本稿推荐在声明的发布窗口内串行完成登记迁移与同一版本部署，并实测授权列表恢复及桌面登录不受影响；发布记录说明这一短暂影响。部署失败则立即进入既定回退流程，不留下迁移与代码长期不匹配的状态。若 owner 要求该列表也零中断，再单独采用兼容登记过渡方案，不将其作为当前默认复杂度。

回退必须同时考虑客户端登记与代码：普通代码回退不撤销 D1 写入。回退到尚不认识 Hako 的版本前，按受控方案撤回仅属于 `hako-web` 的登记及其依赖授权记录，并保证静态/持久集合再次一致；不得清空身份库、桌面授权或 Hako 业务数据。不通过“只将 D1 disabled 改为 1”假定旧列表校验会通过。若当前故障可通过向前修复解决，优先保留已有登记与数据。Hako 独立会话的停用仍由 Hako 处理。

接收方完成后回传：实现 commit、实际客户端参数与回调、测试结果、登记/恢复/回退验证、已发布或未发布状态，以及是否存在与本稿不同的协议选择。若未进行真实登录或 iPhone 测试，明确列为未验证。

## 9. 本次交付证据

- 已读取 Hako 当前决策、eruoo 协议规格、相关实现、数据库基线、恢复生成器、测试调用方与发布脚本入口；已对公开 discovery 做只读连通性核查。
- 已核查 Better Auth 与 oauth4webapi 官方文档/示例，以及 OIDC / OAuth Security BCP 的身份与发起环境验证要求。
- 本次只交付规格及其索引和引用更新；没有修改应用代码、eruoo-server 仓库、数据库、账户权限或线上配置，没有进行真实登录、构建或协议测试。
