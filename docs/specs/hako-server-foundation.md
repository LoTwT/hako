# 临时规格：Hako 服务端共享基建

> 状态：待确认
>
> 创建日期：2026-08-10
>
> 适用版本：Hako 首个自动同步版本
>
> 单一事实来源：本文定义 HTTP、账户认证、设备授权、通用同步协议、Cloudflare Worker、D1 边界和服务端运维；客户端行为由[客户端共享基建规格](./hako-client-foundation.md)定义，模块 payload 和业务约束由各模块规格定义。
>
> 临时性：属于同一临时规格组，统一清理门禁见[文档索引](../index.md#临时规格)。

## 1. 决策：需要服务端，但暂不拆仓

自动同步需要一个永远不信任客户端时间、能够验证设备、仲裁 revision、保存幂等回执和提供增量日志的权威节点，因此必须有服务端。客户端不得直接持有 D1 管理凭据或绕过业务校验访问数据库。

目标形态：

- Cloudflare Worker 就是 Hako 的独立服务端部署单元。
- Web SPA 和 `/api/v1` 由同一个 Worker、同一个 origin 提供。
- 服务端代码位于当前仓库的 `server/`，作为独立 pnpm workspace package，拥有自己的 `package.json`、TypeScript 配置、Wrangler 配置、构建验证和发布流程；整个仓库只维护根目录的一份 pnpm lockfile。
- 首版只有一个 Worker；Better Auth、Hako 账户/设备和模块同步通过内部代码边界隔离，不拆成多个 Worker 或独立仓库。
- 身份认证使用 `CORE_DB`；首个同步模块 Fuel 使用独立业务 D1。后续按事务与恢复边界决定是否新增 D1，不按模块名称机械分库；必须原子提交的跨模块数据必须位于同一业务 D1 或重新设计边界。第 7 至 9 节首版假定一个业务 D1 只承载一个同步恢复域；多个模块共享物理 D1 前，必须另写 D1 级 maintenance、全部受影响模块 epoch 轮换和联合 reconciliation 规格，在此之前禁止共享。
- `server/` 不得导入 `src/` 或 `src-tauri/`，只能依赖平台无关的 `shared/`；同步层只接收项目自有的 `AuthenticatedPrincipal`，不得传播 Better Auth 内部类型。

一个 Worker 已能绑定多个 D1，并能只让 `/api` 与 `/api/*` 先进入 Worker、其余请求直接走静态资源。拆分仓库不会形成运行时安全边界，反而会立即增加 shared contract 发布、跨仓版本矩阵、双 PR/CI 和本地联调成本。

GitHub OAuth 和 Passkey 本身不要求独立仓库；长期标识是 production canonical origin、GitHub OAuth callback、GitHub durable numeric user ID、第 6.1 节的稳定 Hako account ID 和 WebAuthn RP ID，而不是代码位置。只有出现第二个非 Hako 客户端并已进入实现，或服务端需要独立团队、发布权限、安全边界，或身份/同步能力将作为公开 API 或独立产品提供时，才启动独立服务项目。拆分前还必须具备稳定 v1 契约、可按 semver 发布的 `shared` package、跨仓 conformance CI 和兼容策略。公开注册、多账号或共享工作区会触发新的身份与租户规格，但本身不自动要求拆仓；是否拆仓仍只按本段条件判断。未来移动代码时，只要保持 origin、GitHub OAuth callback、GitHub numeric user ID、稳定 account ID、RP ID、D1 bindings 和 secrets 不变，就不需要迁移 Passkey 或云端数据。

## 2. 范围

### 2.1 包含

- Web SPA 静态托管、SPA fallback 和 `/api/v1` 路由。
- 单 owner 私有账户、GitHub OAuth App 登录、OAuth 登录后 Passkey 登记，以及 Web/原生会话与设备管理。
- Core D1 与首个业务 D1 的物理隔离、migrations、导出和 Time Travel 流程。
- 模块化 push/pull 协议、revision、cursor、epoch、幂等回执和错误信封。
- 编译期服务端模块注册表及模块 handler 最小权限。
- production、preview 和 local 环境隔离。
- 安全响应头、Origin/CSRF 校验、会话隔离、日志脱敏和故障降级。

### 2.2 不包含

- 公开注册、多账号、共享工作区、角色权限、密码、邮箱验证码或短信登录。
- 把 Hako 变成供其他应用使用的 OAuth/OIDC Provider、开放动态 client registration，或首版支持多个外部 provider 的自动账号合并。
- 客户端 SQLite/IndexedDB、outbox 调度、Stronghold 解锁和页面实现。
- WebSocket、实时订阅、CRDT、后台推送或服务端主动唤醒客户端。
- 端到端加密；Cloudflare 和服务维护者可以读取同步的业务数据。
- 每个模块一个 Worker、独立 Git 仓库、Durable Objects、Queues 或 R2 自动备份。
- 跨 D1 事务或“撤销完成后连已通过认证的在途请求也不能提交”的强撤销语义。
- D1 读副本和中国大陆 Cloudflare China Network 企业接入。

## 3. 总体架构

```text
Web SPA ── GitHub OAuth / Passkey ────────┐
五个 Tauri 原生端 ── 系统浏览器设备授权 ─┤
                                          ▼
                               Hako Worker（一个部署单元）
                               ├─ Static Assets：Web SPA
                               ├─ Better Auth `/api/auth/*` ──> CORE_DB
                               └─ Hono `/api/v1`
                                  ├─ AuthenticatedPrincipal / Device ──> CORE_DB
                                  └─ SyncRuntime
                                     ├─ cursor codec ─────────> HAKO_CURSOR_MAC_KEY
                                     └─ FuelSyncHandler ──────> FUEL_DB
```

约束：

- 入口层是完整 Worker `env` 和原始 D1 binding 的唯一持有者；它通过编译期 registry 把 `moduleKey` 解析为模块 descriptor 与对应 binding，再只向下游交付第 4 节的 request-scoped `DeadlineCheckedD1`，不允许请求值索引任意 `env` 属性。
- Better Auth 只负责证明用户和会话；Hako auth adapter 把 Web Cookie 或原生 Bearer 统一解析为不可变 `{ applicationId: "hako", accountId, authUserId, sessionId, deviceId, platform }` `AuthenticatedPrincipal`。`applicationId`、`accountId` 和当前会话的 `deviceId` 只能来自服务端的部署配置与权威会话上下文，客户端不得把它们作为认证或租户作用域字段选择或覆盖。设备管理 API 可以把服务端返回的 `DeviceSummary.id` 用作目标资源 ID，但该路径参数不参与当前 `AuthenticatedPrincipal` 的派生。
- `server/src/core/sync/` 的通用 `SyncRuntime` 接收 `AuthenticatedPrincipal`、目标业务 D1 的 `DeadlineCheckedD1` capability，以及入口层用 `HAKO_CURSOR_MAC_KEY` 构造的 cursor 签发与验证 capability。它唯一负责第 7、8 节的 transport、metadata、epoch、cursor、receipt、push 顺序和 pull 信封。
- 模块 handler 只提供版本化 codec、canonicalizer、业务 validator 和领域 DML 计划。它只能使用自己模块的 `DeadlineCheckedD1`，不接收完整 Worker `env`、原始 binding、MAC key、`CORE_DB`、Better Auth session/token 或其他 binding。
- `SyncRuntime` 组装每条 mutation 的最终 D1 batch，并检查通用与模块 DML 的 affected rows；模块 handler 不能自行提交 batch 或写 `mutation_receipts`。
- `originDeviceId` 取自 `AuthenticatedPrincipal.deviceId`，只作为模块数据库中的审计值，不建立跨 D1 外键。
- 模块加载阶段不得访问数据库、发网络请求或执行可能使整个 Worker 启动失败的初始化。

## 4. 服务端技术栈与部署边界

- TypeScript Cloudflare Module Worker。
- Hono 负责路由、中间件和类型化请求上下文。
- Better Auth 负责 GitHub OAuth、Web session、Passkey、RFC 8628 Device Authorization 和原生 Bearer session；Hono 通过项目自有、按路径过滤响应的 `AuthResponseBoundary` 把所需 handler 挂载到 `/api/auth/*`。
- Zod 与 `@hono/zod-validator` 负责请求边界校验；服务端不信任客户端生成的 TypeScript 类型。
- Wrangler 负责本地运行、bindings、migrations、类型生成、dry-run 和部署。
- `@cloudflare/vitest-pool-workers` 在 Workers runtime 中运行集成测试。
- 根 `pnpm-workspace.yaml` 管理客户端与 `server/` package，整个仓库只维护根 `pnpm-lock.yaml`。`server/` 独立声明依赖和 scripts，不创建第二份 lockfile、使用其他包管理器或拆成独立仓库。

Better Auth 使用其内置 D1/Kysely dialect；认证层不引入 Drizzle、Prisma 或项目自建数据库 adapter。原始 `CORE_DB` 和模块 D1 binding 只能由 Worker 入口持有，Better Auth、`SyncRuntime`、scheduled handler 与其他请求代码只接收 request-scoped `DeadlineCheckedD1` facade；该 facade 保留 `D1Database` 接口和框架既有 dialect，不改变 SQL 或事务所有权。Better Auth CLI 生成的 SQL 必须经人工 diff 审核后提交到 `server/migrations/core/`，production 只由 Wrangler migration 应用，运行时不得自动迁移。同步 runtime、Hako 设备表和模块业务表继续使用显式 prepared SQL 与 `D1Database.batch()`，不让认证框架或 ORM 接管其事务边界。

Bearer 插件只为 Device Authorization 取得的 access token 提供验证。`AuthResponseBoundary` 在读取或解析 body、调用 Better Auth 前执行 route-aware 字节上限：Passkey registration/authentication verification 最多 128 KiB，其余 `/api/auth/*` body 最多 16 KiB，GET/redirect callback 不接受 body；超限返回 413 并零 D1 写入。上限按原始 `Content-Length` 预拒绝，并对缺失/伪造长度的流式读取执行硬截断，不能只依赖 JSON 解析后的对象大小。

`AuthResponseBoundary` 必须从所有公开认证响应删除 `set-auth-token` 及对应 `Access-Control-Expose-Headers`，并按锁定版本的响应 schema 删除顶层 `token`、`session.token` 和其他 session secret；公开 Better Auth `get-session` 路由关闭，Web 只调用 Hako 的 `/api/v1/session`。唯一允许在响应 body 交付 session secret 的路径是无浏览器 `Origin`、client ID 与环境/平台登记完全匹配的 RFC 8628 `/device/token`，且只向持有秘密 `device_code` 的 Rust 轮询方返回标准 JSON。Web OAuth、Passkey、session 或批准页面在 header/body 暴露任一 bearer 都是测试失败；Web 端使用忽略原始 Better Auth 成功 body 的 Hako wrapper，成功后重新读取 Hako 会话摘要。Better Auth 与插件使用根 lockfile 精确锁定版本；升级必须重新生成并审核 schema diff，运行 auth/session/passkey/device-flow conformance 后才发布。

每个 API 或 scheduled invocation 在入口记录单调起点，并固定“入口后 20 秒”为最后一次 D1 调用的**发起截止时间**。`DeadlineCheckedD1` 必须覆盖 `run`、`all`、`first`、`raw`、`batch`、`exec` 以及 Better Auth adapter、`waitUntil` 任务和模块 handler 能到达的所有终端 D1 调用；每次发起前先执行一次 `scheduler.wait(1)` 或经锁定 Workers runtime conformance 证明等价的 runtime timer turn，使冻结的 Workers 时钟刷新，再检查 deadline。到期后不得开始新的 D1 调用；Hako API 返回脱敏、retryable 503 `request_deadline_exceeded` 与 `Retry-After: 1`，Better Auth/RFC 路径返回其边界允许的脱敏 503 且同样零认证写入。仅使用 `Promise.race`、`AbortSignal` 或事后日志不构成门禁。已在截止前发起的单条 D1 query 或整次 `batch()` 仍按平台最多运行 30 秒，因此第 9 节用“单一 maintenance version 已全量生效后等待至少 50 秒”作为可证明的排空屏障。任何锁定插件或自有代码能绕过 facade 直接访问原始 binding，都是阶段一上线失败。

共享传输信封放在根目录 `shared/sync/`，是客户端和服务端唯一的 TypeScript 契约实现。模块 wire schema 放在 `shared/modules/<moduleKey>/`，由对应模块规格拥有；客户端和服务端都不得复制常量或字段表。`shared/` 只能依赖与平台无关的 TypeScript 代码，不得导入浏览器、Vue、Tauri、Workers runtime、D1 或 Node.js 专用 API。

## 5. 环境与 Cloudflare 资源

### 5.1 固定资源

| 环境 | Worker | Core binding | 模块 binding |
| --- | --- | --- | --- |
| production | `hako` | `CORE_DB` → `hako-core` | `FUEL_DB` → `hako-fuel` |
| preview | `hako-preview` | `CORE_DB` → `hako-core-preview` | `FUEL_DB` → `hako-fuel-preview` |
| local | Wrangler local runtime | 本地模拟 `CORE_DB` | 本地模拟 `FUEL_DB` |

- production 和 preview 的 database ID、Better Auth secret、GitHub OAuth client credentials 与 cursor MAC key 必须完全不同；两套 release manifest 及其派生的 owner allowlist 也不得跨环境读取，但同一个人的 GitHub durable numeric user ID 可以相同。
- GitHub 配置名固定为 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` 和 `HAKO_OWNER_GITHUB_USER_ID`；client secret 只进入对应 Worker secret 或未提交的 local `.dev.vars`，不得进入 Web/native bundle、Tauri 配置或日志。
- 两个 binding 分别配置 `server/migrations/core` 和 `server/migrations/fuel`。
- 新数据库创建时使用 `apac` location hint；该 hint 不保证具体物理位置。
- `compatibility_date` 首次固定为 `2026-08-10`，以后按有验证的升级变更更新，不使用隐式最新行为。
- 首版不启用 D1 read replication，也不使用 `withSession("first-unconstrained")`；以后启用时必须先补充 session bookmark 和一致性规格。

远端资源按阶段创建：纯离线阶段为 0 个；认证纵向切片创建 production `hako-core`，形成 1 个；Fuel private sync beta 再创建 production `hako-fuel`，形成 2 个；进入远端发布 hardening 后再创建两个 preview D1，形成 4 个。D1 数量不是独立计费单位，费用取决于账号套餐和实际读写/存储用量。

### 5.2 静态资源路由

Wrangler 从 `dist/web` 部署静态资源：

- `assets.not_found_handling` 使用 `single-page-application`。
- `assets.run_worker_first` 固定为 `['/api', '/api/*']`，API 无论是否带浏览器导航 header 都必须进入 Worker；命中静态文件的其他请求直接读取资源，非 API miss 再由 Worker 交给 `ASSETS.fetch()` 和 SPA fallback。
- 静态 hashed assets 不经过应用代码；API、认证和同步响应全部 `Cache-Control: no-store`。
- Web 构建必须把 `public/_headers` 复制到 `dist/web/_headers`，由 Static Assets 为 HTML 和 SPA fallback 设置 CSP、HSTS、frame 防护、`nosniff` 和 Referrer Policy；这些请求不经过 Worker 代码，不能依赖 Hono middleware 补 header。
- Web SPA 与 API 同源，不开放宽泛 CORS。原生客户端只使用当前构建环境映射中的固定 canonical origin；production/preview 为 HTTPS，local 为精确的 `http://localhost:8787`。

canonical origin 与 WebAuthn RP ID 按环境固定：

| 环境 | canonical origin | RP ID |
| --- | --- | --- |
| production | 用户自有域名下的固定 HTTPS 专用 origin，例如 `https://hako.<domain>` | production origin 的精确 hostname |
| preview | 独立的固定 HTTPS origin，例如 `https://hako-preview.<domain>` | preview origin 的精确 hostname |
| local | `http://localhost:8787` | `localhost` |

每个 origin 同时是该环境的 Web/API origin、Better Auth base URL、GitHub OAuth callback 基址和 Passkey ceremony origin。不得使用过宽的 apex RP ID、related-origin 例外或跨环境 RP ID；preview 在阶段四创建前不属于前置依赖。三者的 Cookie、OAuth callback、RP ID、IndexedDB 和原生构建期地址不得交叉。production origin 或 RP ID 迁移必须另写迁移规格并要求重新登记受影响 Passkey，不能通过一次普通部署静默替换。

GitHub 端使用 OAuth App，而不是需要仓库安装与权限模型的 GitHub App。GitHub OAuth App 只接受一个 callback URL，因此 production、preview 和 local 分别注册独立应用，callback 精确固定为各环境 canonical origin 下的 `/api/auth/callback/github`；local 即 `http://localhost:8787/api/auth/callback/github`。三个 OAuth App 的 client ID/secret 不得复用，GitHub 控制台中的 Device Flow 保持关闭；五个原生端只使用第 6.2 节定义的 Hako Device Authorization。

### 5.3 粗粒度限流

进入首次公开认证部署前必须先配置一条 zone-level WAF rate limiting rule，按来源 IP 对 `/api` 与 `/api/*` 配置每 10 秒 10 次的阈值与 10 秒阻断，并返回 429。Cloudflare Free 的该规则表达式只支持 Path/Verified Bot，不能匹配 Host，因此 Free-first 明确把这两个 path 保留给 Hako：部署前必须通过 zone inventory 证明同一 zone 的其他 hostname 不使用它们；若不能满足，就必须在公开认证前升级到至少支持 Host 条件的套餐并把 production hostname 加入表达式。该规则在 Worker invocation 前生效，包含 `/api/v1/health`，用于降低单一来源耗尽 Workers Free 日额度的风险；其 rule ID、表达式、阈值和预期 action 写入 deployment manifest，部署前通过 Cloudflare API 与持续超阈值探针核验。Cloudflare 明确不保证精确第 N 次请求即被拦截，计数传播期间仍可能有超额请求进入 Worker，因此不能把配置阈值当作额度不变量。WAF 429 不保证 Hako JSON 信封，客户端把它视为 retryable，并在没有可信 `Retry-After` 时至少等待 10 秒。该规则仍是按 IP 的粗门禁，不能抵御分布式低速流量，也不能替代下面的应用内身份与容量约束。

Worker 内继续配置 Rate Limiting bindings，production 与 preview 使用不同 namespace，local 使用确定性 fake：

- `UNTRUSTED_API_RATE_LIMITER`：同一 `route class + source network key` 每 60 秒最多 60 次，用于 health 以外的全部 `/api/*` 路由，在认证或读取 D1 前执行，阻止随机无效 Bearer 绕过设备限流。
- `PUBLIC_AUTH_RATE_LIMITER`：同一 `route class + source network key` 每 60 秒最多 10 次，额外用于 OAuth callback、Passkey ceremony 和 Device Authorization code 端点，在读取 D1 前执行；`/device/token` 使用独立 route class、每 60 秒最多 20 次，使单个客户端按五秒 interval 轮询完整十分钟不会被边缘门禁误伤，同时仍由 Better Auth 的 RFC polling guard 对过快请求返回 `slow_down`。Better Auth 自带的 endpoint 限流保留启用，但不能替代边缘成本保护。
- `AUTHENTICATED_API_RATE_LIMITER`：同一 `accountId + (active deviceId 或已验证 Better Auth sessionId) + route class` 每 60 秒最多 120 次，用于设备管理和各模块 push/pull，在认证成功后执行。同步和已绑定设备管理只能使用服务端解析出的 `deviceId`；首次绑定、显式重新绑定、设备列表/撤销、会话状态和退出尚无 active device 时，才使用服务端验证后的 `sessionId`，绝不读取客户端自报的 device/session 值。

source network key 只从 Cloudflare 提供的可信客户端地址构造：IPv4 归一到 `/24`、IPv6 归一到 `/56`，再对固定 domain separator 与规范网络地址计算 SHA-256；摘要在不同 isolate 间稳定，但不写入应用日志。health 返回常量且不读取 D1，不占用应用限流 binding，但仍受前置 WAF rule 与 Cloudflare 边缘 DDoS 防护约束。

binding 拒绝时返回 429 `rate_limited` 与 `Retry-After: 60`；`/device/token` 在该结果下不得 consume code、改变 attempt 或创建 session。binding 自身不可用时 fail open，并记录不含 token 和原始网络标识的指标。Workers Rate Limiting 的计数按 Cloudflare location 隔离且是宽松计数，只用于控制滥用和成本；OAuth state、PKCE、Passkey challenge、Device Authorization polling interval/expiry 和 session 撤销仍由 Better Auth 与 Core D1 承载。

边缘限流不是 Core 存储容量不变量。阶段一的受审 Core migration 必须为锁定版本的 `deviceCode` 与 `verification` 表增加 `expiresAt` 索引和原子 `BEFORE INSERT` 容量 trigger：`deviceCode` 最多保留 2048 行且同时未过期不超过 256 行，`verification` 最多保留 2048 行且同时未过期不超过 512 行。trigger 与上游 INSERT 属于同一 D1 statement，不能用 middleware 的 `COUNT → INSERT` 代替；超过任一门禁由 `AuthResponseBoundary` 映射为 429 `auth_capacity_limited` 与 `Retry-After: 300`，不回显表名或 SQL。固定上限保护单个 D1 不被公开 client ID 的持续写入填满；hourly cleanup 和告警规则见第 6.4 节。

## 6. 身份认证、Passkey 与设备管理

Hako 远端服务首版是单租户、单 owner 账户；本地使用仍不需要登录。只有从部署前固定的 GitHub numeric subject、该 owner 已登记的 Passkey，或该 owner 明确批准且尚未撤销的设备会话出发，才能生成 `AuthenticatedPrincipal`。客户端不得提交或选择 `applicationId`、`accountId` 或当前会话的 `deviceId` 作为身份作用域；显式设备管理可以引用服务端列表返回的目标设备 ID。

### 6.1 owner 与账户边界

- 首版只启用 GitHub OAuth App；Better Auth `providerId` 固定为 `github`，`providerAccountId` 与数据库外 owner allowlist 都使用十进制字符串形式的 GitHub profile durable numeric `id`。GitHub `login` 可以更名，email 也可以变化，因此二者都不能作为 subject、所有权或 account linking 键。
- GitHub 授权请求固定使用锁定 Better Auth GitHub provider 的默认身份 scope `read:user` 与 `user:email`，不得再申请 `repo`、`workflow`、`read:org` 或其他与登录无关的权限；依赖升级改变实际 scope 集合时必须先审核并更新本规格。真实 GitHub email 只作为兼容 Better Auth 必填字段的瞬时上游输入；进入 Better Auth lookup 前仍由下段 wrapper 替换为 subject-derived `.invalid` 地址，不持久化、不记录日志，也不参与所有权或 linking。GitHub 主邮箱为 private 或 `/user` 返回 `email: null` 时，必须通过受测的 profile mapping 收敛到相同 numeric ID 和占位地址。
- production/preview 分别在 release manifest 中固定唯一允许的 `github` provider 与 GitHub numeric subject，Worker 的数据库外 owner allowlist 只能从当前已批准 manifest 派生，不能形成第二个配置事实源。不得使用 email、`login` 或第一次公开登录作为所有权事实来源。项目在锁定的 Better Auth stable 版本上实现 `OwnerIdentityGate`：每一次 OAuth callback 在创建或刷新 session 前校验 provider 与 subject，新 user/account 的前置 hook 再作持久化防线；Passkey authentication 在创建 session 前必须从已验证 credential 反查 user，并验证该 user 仍同时具有唯一、匹配 allowlist provider/subject 的 account 与 `hako_accounts` 映射；Passkey 登记/删除、Device Authorization 验证/批准/拒绝等敏感插件路由也必须验证当前 Better Auth user 仍映射到数据库外 allowlist。Device Authorization token poll 即使未认证，也必须在 consume code/签发 session 前用已批准 `deviceCode.userId` 反查同一唯一 allowlist provider/subject account 与 Hako mapping。任一校验失败都在 plugin/session 写入前返回 `identity_not_allowed`，且不得新增或修改 Better Auth user/account/session；公开部署前预置的 `hako_accounts` anchor 必须保持字节级不变，不能被拒绝流程删除或修改。锁定版本无法在写入前提供这个边界时，必须替换或包装 adapter 后才能上线。所有允许的 owner callback 都在 Better Auth lookup 前把 email 替换为由 `environmentId + providerId + subject` 哈希导出的确定性、非投递 `.invalid` 地址，真实 GitHub email 不持久化、不参与 linking 或所有权。不能依赖只在首次创建触发的 hook 或 beta API。
- 若计划通过 Apple App Store 分发，GitHub 属于第三方登录；实施前必须按当时的 App Review Guideline 4.8 明确是否需要 Sign in with Apple 或是否满足适用例外，不能假定已有 Passkey 会自动满足商店条款。该发布门禁不要求首版预先接入多个 provider。
- 每个环境在首次创建该环境的 Core database 前生成一次随机 UUID v4 `HAKO_OWNER_ACCOUNT_ID`。该值写入 `server/deploy/<environment>/release-manifest.json` 的不可变字段，由部署配置注入 Worker，并与 environment、`applicationId = "hako"`、Core D1 database ID、已接入业务 D1 database ID 及 owner provider/subject 一起校验。它不是 secret，但 manifest 必须做完整性校验和离线备份；production、preview 和 local 不得复用。每次接入新的业务 D1，必须先更新、核验并备份 manifest。该 ID 不能由 GitHub subject、email 或 Better Auth user ID 派生，也不能在 Core restore、owner subject 更换或 operator recovery 时重新生成。production Worker 首次对外提供任何认证路由前，该 manifest 与 owner GitHub numeric subject 必须已生成并通过校验；任一值缺失、为空或与绑定资源不一致时，Worker 启动 fail closed。
- Core migration 完成后、公开认证路由启用前，部署 bootstrap 命令必须以 manifest 中的 Core D1 database ID 为目标，在空表中条件插入唯一 `hako_accounts` row：`{ id: HAKO_OWNER_ACCOUNT_ID, application_id: "hako", provider_id: "github", provider_subject: <owner numeric id>, auth_user_id: null }`。已存在完全相同的 row 时幂等成功；表中有其他 account、字段不同或受影响行数不是预期值时部署失败。公开 OAuth 请求不得创建、选择或替换该 row，因此首个访问者无法成为 owner。
- 首次允许的 OAuth 登录只把已验证的 Better Auth `authUserId` 绑定到预置 account anchor；以后所有 OAuth session 和 Passkey 都必须映射回该 account。Better Auth callback 成功后，Hako session wrapper 以已验证的 provider/subject、Better Auth provider account 和 `authUserId` 执行 singleton mapping CAS：只有 `id`、`application_id`、`provider_id`、`provider_subject` 均等于 manifest 且 `auth_user_id IS NULL` 时，才绑定 `auth_user_id` 并写 owner identity bound 审计；已绑定到同一 user 则幂等读取。`owner_recovery` 下 account anchor 缺失时，wrapper 只能保留隔离 identity/session，不能自动插入，必须按第 9 节的受控恢复流程重建。出现其他 account ID、多行或现有 mapping 指向其他 user 时 fail closed 到 operator recovery；subject 更换时只能按下段流程原子更新 `provider_subject` 与 `auth_user_id`，不能替换 account ID、`application_id` 或 provider。Better Auth identity/account/session 已提交但该 CAS 失败时不得删除它们；同一 Cookie 或后续 OAuth 重试都必须重新执行 wrapper 直到 mapping 收敛。mapping 已提交而响应丢失时重试只读取原 row。首版关闭公开注册、多账号、自动 account linking 和通过相同 email 合并身份。
- owner 敏感动作统一使用项目自有 `owner_action_proofs`。服务端在确认动作前创建有效期最长十分钟的 pending context，并生成至少 128 bit 随机的 opaque nonce；context 固定当前 manifest 的 application/account/provider/subject、`method = github_oauth_identity | passkey_uv`、`purpose = passkey_registration | device_authorization_approval`、允许的固定 return route、创建/过期时间与一次性状态。method 由服务端按 purpose、当前阶段和用户选择的受支持流程确定，不能直接采用客户端字段。`github_oauth_identity` 只确认 callback 仍属于固定 GitHub numeric subject，不承诺密码、2FA 或 UV 在最近十分钟内重新执行；只有 `passkey_uv` 具有近期强认证语义。`purpose = device_authorization_approval` 时，服务端必须先把输入的 `user_code` 权威解析为 attempt，再把 attempt ID 固定为 target；同一未结束 attempt 最多有一条 live pending context，重复打开批准页只幂等复用，客户端提供的 target 或 return URL 一律不可信。全新或已退出的浏览器可以在没有 Hako session 时创建该 context，此时 initiating user/session 为空；已有 session 时必须先验证它属于同一 owner，再记录 initiating user/session。`purpose = passkey_registration` 则始终要求已有 owner session，且 method 固定为 `github_oauth_identity`。GitHub OAuth callback handler 与 Passkey UV verification handler 必须各自从受审路由派生常量 `actualVerifierMethod`，state 或 challenge 只携带/引用 opaque nonce；签发 proof 的条件更新要求 pending context 的 method 精确等于 `actualVerifierMethod`，否则零写入。callback 通过 `OwnerIdentityGate` 验证固定 owner 后，以同一条件更新首次绑定或复核 owner user/account，并把 proof 签发给 callback 产生或延续的当前 session；即使 OAuth 旋转 session，也不能改写 method、manifest tuple、purpose/target 或跳到任意 return URL。OAuth nonce 不能交给 Passkey handler 使用，Passkey challenge 也不能交给 OAuth callback 使用。`purpose = passkey_registration` 的 target 在 registration options 开始时再原子绑定为唯一 ceremony ID。pending context 和 issued proof 共用该表的显式状态，除 opaque nonce 外，不在 Cookie、URL 或客户端 store 中复制这些权威字段。
- Passkey 登记必须消费当前 owner session、`method = github_oauth_identity`、`purpose = passkey_registration` 且 target 绑定当前 ceremony 的未过期 proof，不能由既有 Passkey 为新增 Passkey 授权。原生设备批准必须消费当前 owner session、`purpose = device_authorization_approval` 且 target 绑定当前 attempt 的未过期 proof；阶段一只接受 `github_oauth_identity`，阶段二启用 Passkey 后接受 `github_oauth_identity | passkey_uv`。缺失、过期、已消费或 method/session/purpose/target 不匹配时均零认证状态变更，用户完成该 purpose 允许的 owner 动作确认后继续原流程。
- Passkey registration options 开始前必须以条件更新把 `owner_action_proofs` 的 proof 原子绑定到唯一 `ceremonyId`，重复 options 或其他 ceremony 一律拒绝；verification 在调用 Passkey plugin 前以 `proofId + ceremonyId + purpose + unconsumed` 条件更新取得唯一消费权，loser 不得调用 plugin。取得消费权后即使 plugin 失败也保持 proof consumed，用户必须重新完成 owner 动作确认；这样两个并发 ceremony 最多一个能写 credential。Passkey options 固定 `userVerification='required'`，但不能只信 options：锁定插件当前 verification 未强制 UV，Hako verification wrapper 必须在创建 credential 或 session 前验证 SimpleWebAuthn 的 registration/authentication info 明确 `userVerified === true`，否则零 credential、零 session 并拒绝。若锁定版本不能在写入前可靠取得该结果，则该 Passkey adapter 不满足上线门禁，必须替换或包装后才能进入阶段二。普通 Passkey session、原生 Bearer 或仅“session 新鲜”都不满足登记条件。首版不开放 passkey-first 注册；登记后 GitHub OAuth 与 Passkey 都可登录，但 GitHub 身份继续作为常规恢复锚点。删除 Passkey 不得解除 owner GitHub account。
- 若 GitHub 身份和全部 Passkey 同时丢失，只能进入经审计的 operator recovery。部署数据库外的认证门禁固定为 `normal`、`deny_all`、`owner_recovery` 三态；`owner_recovery` 只开放 allowlist OAuth callback、session/logout、设备绑定和 Passkey 登记，所有模块路由及其他身份均关闭。流程必须先启用第 9 节的 `RecoveryEdgeGate`，再把唯一 active Worker version 切到 `deny_all` 并完成 50 秒排空；随后在受审 Core D1 batch 中撤销全部 session、Device Authorization code/attempt、verification、device 和 action proof。任何 account mapping INSERT/CAS 之前，必须删除当前 mapping 指向的 outgoing identity 以及本次隔离 incoming identity 的全部 Passkey，终结相关 audit intent 并写入只含数量的审计，再权威验证两者 credential、未决 intent 与匿名 verification/device-code 状态均为零。每次 subject 变更都先清空 outgoing identity 是永久不变量，因此 A→B 时已删除 A，未来 B→A 不能重新激活 A 的旧 Passkey。
- 清理完成后生成新的 versioned release manifest，只更新 owner GitHub numeric subject，保持 environment、稳定 account ID 与全部 D1 ID 不变，完成完整性校验和离线备份后部署与该 manifest hash 绑定的 `owner_recovery` Worker。Worker allowlist 必须从这一份 manifest 派生，旧 manifest、新 manifest 和 Worker allowlist 任一混搭都 fail closed；新 numeric ID 首次 OAuth callback 只能创建隔离 Better Auth identity/session，不能走普通首次账户创建。所有模式都使用上段的 subject-derived `.invalid` email，`overrideUserInfoOnSignIn=false`，因此旧/new GitHub ID 即使 email 相同也不会触发隐式 linking。operator CLI 随后核验 release manifest 中的稳定 account ID，以 `hako_accounts` singleton、固定 account ID/application/provider、旧 manifest subject 与旧 `auth_user_id` 为条件，在同一 Core D1 batch 中把 `provider_subject` 和 `auth_user_id` 原子切换为新 manifest subject 与隔离 identity，并写入 subject-change 审计；affected rows 不等于一或完整 tuple 与任一 manifest 不符时回到 `deny_all` 且不删除旧映射。重映射成功后撤销隔离 session，用户再次 OAuth 登录、绑定设备并重新登记 Passkey。完成这些动作后必须按第 9 节执行最终 `deny_all` 冻结、排空与权威核验，才能切回 `normal` 并撤销 `RecoveryEdgeGate`。不得创建第二个 Hako account、更换 account ID、迁移业务 D1 或暴露公共 recovery API。

### 6.2 Web 与五个原生平台的登录流

- Web 在 canonical origin 使用 Better Auth 的 GitHub OAuth 和 Passkey 页面；成功后只使用 `Secure; HttpOnly; SameSite=Lax; Path=/` 的 host-only session Cookie。JavaScript 不读取或保存 session token，所有写请求保持 Better Auth 的 Origin/CSRF 校验，认证与同步响应使用 `no-store`。
- Passkey ceremony 只在第 5.2 节当前环境对应的 canonical origin 执行，`rpID` 精确等于同一行的 RP ID，并按第 6.1 节同时强制 user verification。不得跨环境复用 credential，也不得在 Tauri WebView 中依赖平台各异的 WebAuthn 实现。
- Windows、macOS、Linux、iOS 和 Android 统一使用 Hako 的 RFC 8628 Device Authorization：Rust identity service 请求并独占保存秘密 `device_code`，只把 `user_code` 与 verification URL 交给 Vue，再经 Tauri Opener 打开系统浏览器。批准页先按第 6.1 节把 `user_code` 解析为服务端 pending context；最终 approve 才必须通过 `OwnerIdentityGate` 并消费与当前 attempt 绑定、十分钟内签发的 action proof。当前浏览器没有 Hako session 或没有可用 proof 时，先完成 GitHub owner 身份确认；阶段二后已有 owner Passkey 的浏览器也可完成 UV Passkey，再返回同一 `user_code` 的批准页。该 owner 浏览器 session 不要求预先绑定为 Hako 同步设备，一次性 action proof 才是批准门禁，其中只有 `passkey_uv` 提供近期强认证。批准成功后，Rust 按服务端 interval 轮询并取得 opaque access/session token。这里不调用 GitHub Device Flow；首版也不实现自定义 scheme、Universal Link/App Link 或 Hako 自己的 OAuth Provider。
- Device Authorization 为每个 environment × platform 使用独立、编译期登记的 public client ID，code 十分钟过期、单次批准，轮询最短五秒并正确处理 `authorization_pending`、`slow_down`、`expired_token`、`access_denied` 和 `invalid_grant`。审批页只根据服务端登记的 client ID 显示环境与平台，并显示 `user_code`；设备名称在取得 token 后的 Hako 设备绑定页确认，不能声称 Better Auth code 请求已经携带名称。
- 锁定 Better Auth 版本的 code、approve/deny 与 token handler 不具备项目所需的跨撤销原子性，因此外层 route allowlist 禁止直达这些原 handler。Hako 使用版本锁定 wrapper 和受审 SQL：签发 code 的同一 Core D1 batch 同时写 Better Auth `deviceCode` 与 `device_authorization_attempts`，并把当前 `auth_runtime_state.device_authorization_generation` 冻结到 attempt。approve、deny、token 和来自 Device Authorization 的首次 bind 必须使用下一段统一的 claim-first SQL 模式，不能只在 batch 返回后检查 affected rows。

每次 claim-first 操作生成随机、request-scoped `claim_nonce`。batch 的第一条 DML 只在 attempt 状态、expiry、当前 generation、权威 owner/session，以及本操作要求的 device、proof 和 `claim_nonce IS NULL` 条件都满足时，才写入 `claim_nonce`、固定 `claim_kind` 及所需候选 ID；预读结果不参与最终仲裁。batch 中每条后续 `INSERT`、`UPDATE` 和 `DELETE` 都必须在 SQL 内通过 `attempt_id + claim_nonce + claim_kind` 的 `WHERE EXISTS` 或 `INSERT ... SELECT` 依赖同一个 winner。首条 claim CAS 为零时，后续 DML 也必须全部为零，batch 提交后数据库与调用前一致，再权威重读并返回已处理、过期或无效；不得先提交部分状态，再由 TypeScript 根据 `meta.changes` 宣称失败。

winner 的最后一条 DML 只按 `attempt_id + claim_nonce + claim_kind` 命中 attempt，执行目标状态转换并清空 claim。版本绑定 migration 为该转换安装 `BEFORE UPDATE` 断言 trigger，按 claim kind 核验 code、session、mapping、generation、目标状态，以及 approve 所需 proof 已由同一 claim nonce 消费的后置条件；任何依赖 DML 意外影响零行或产生错误状态时，trigger 使用 `RAISE(ABORT, 'hako_auth_invariant')` 使 statement 失败并回滚整个 D1 batch。该内部错误只返回脱敏、retryable 503 并告警，不能伪装成预期的 `invalid_grant`。成功响应只能在 batch 成功，且 claim、各业务 DML 和最终转换均达到精确预期行数后生成；所有终态 attempt 的 claim 字段必须为空。

approve 的首条 claim 只接受 pending、未过期且 generation 当前的 attempt，并在同一条件更新中要求：approver 是仍有效且通过 `OwnerIdentityGate` 的 owner session；存在同 owner user/session、`purpose = device_authorization_approval`、target 为当前 attempt、尚未消费且 `expiresAt` 晚于当前请求仲裁时刻的 proof；proof method 在阶段一必须是 `github_oauth_identity`，阶段二才允许 `github_oauth_identity | passkey_uv`。claim 同时冻结 `action_proof_id`、approver session 和可选的 active approver device；浏览器 session 未绑定同步设备不阻止批准。proof 消费 DML 只在 proof ID 与 attempt 中冻结值一致、该 attempt 仍持有同一 `claim_nonce + claim_kind` 时，才写入 `consumed_at` 与 `consumed_by_claim_nonce`；code 更新和最终 approved 转换都必须在 SQL 中再次依赖该 proof 已由同一 claim nonce 消费。proof 门禁未命中时首条 claim 为零，attempt、proof、code 和其他认证状态均不变；依赖 DML 意外为零时最终 trigger 抛错并回滚全 batch。deny 使用同样的 pending claim，但不需要 action proof，最终转换为 denied。`/device/token` 由 Hako wrapper 完整接管，不调用插件分离的 `consumeOne → createSession` 写路径：token claim 只接受仍有效的 approved attempt，先把预生成的候选 session ID 冻结到 `minted_session_id`；code consume、锁定 Better Auth session codec 的 session `INSERT ... SELECT` 和最终 minted 转换都依赖同一 nonce，trigger 再核验 code 已消费且精确 session ID、owner 与 account 映射存在。只有全批提交才交付内存中的 token。新 session 绑定设备时，bind claim 校验 attempt generation 仍当前、候选 session 未绑定，以及相同 installation 已存在或 active count 小于 16；device 与 mapping DML 依赖同一 nonce，最终转换为 `bound`，在此之前 session 仍可由撤销事务通过 lineage 删除。若锁定版本无法提供上述 batch、trigger 或 session codec，则当前 Device Authorization adapter 不满足阶段一上线门禁，必须替换。Better Auth 升级时必须重审全部受审 SQL、trigger 与 session codec。

任一有效 session logout 或任一 device 被撤销时，同一 Core D1 batch 先把 singleton generation 严格加一，再失效所有旧 generation 的 pending/approved attempt 及 code，并删除这些 attempt 中尚未 `bound` 的 `minted_session_id` 对应 Better Auth session/mapping。如果 token/bind batch 先提交，后续撤销会通过 lineage 删除未绑定派生 session；如果撤销先提交，后续 approve/token/bind 的 generation guard 失败。已完成可见设备绑定的其他 session 不因无关设备 logout/revoke 而被删除；上述保守规则只取消旧 generation 的未决授权和尚未绑定派生凭据，客户端收到 `invalid_grant` 后重新发起。
- 原生 Bearer token 只交给 Rust identity service 并存入环境隔离的 Stronghold；Vue/WebView 只能取得脱敏会话状态。Hako auth adapter 通过 Better Auth Bearer 插件验证该 token；`AuthResponseBoundary` 保证 Web 登录及会话响应的 header 和 JSON body 都不暴露 JS 可读的 session secret。token 过期、撤销或 401 后重新走 Device Authorization，不重置模块 store 或 outbox。
- Better Auth OAuth state、PKCE、Passkey challenge、session 和 device code 均由其固定版本实现；项目不得复制或自行发明这些密码学协议。

### 6.3 Hako 设备 API

Better Auth session 表示认证会话，Hako `sync_devices` 表示同步归因和用户可见设备；二者不得混为一个 ID。项目自有 `sync_device_sessions` 显式把 Better Auth session ID 映射到 Hako device ID，不能按 User-Agent、IP 或客户端自报字段推断。认证完成后，客户端用本地 `installationId` 绑定当前 session；未绑定或已撤销设备的 session 可以完成退出或显式重新绑定，但不能调用同步 API。

active 设备摘要固定为 `{ id, name, platform, createdAt, lastSeenAt, isCurrent }`；`platform` 只能是 `windows`、`macos`、`linux`、`ios`、`android` 或 `web`，名称去除首尾空白后为 1 至 80 个字符。撤销历史只进入审计，不混入首版设备列表。

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| Better Auth `/api/auth/*` | OAuth、Passkey、Device Authorization 的显式 allowlist 路径 | 使用 Better Auth/RFC 定义的响应并经 `AuthResponseBoundary` 脱密，不套 Hako 同步错误信封 |
| `PUT /api/v1/devices/current` | 已认证 session；`{ installationId, name, platform, confirmRebind? }` | 200 `DeviceSummary`；绑定或更新当前设备 |
| `GET /api/v1/devices` | 已认证 owner session；允许尚未绑定 | 200 `{ devices }`；只返回 active 设备，首版上限 16，因此不分页 |
| `DELETE /api/v1/devices/:deviceId` | 已认证 owner session；允许尚未绑定 | 204；幂等撤销设备及其已知 session，未知 ID 返回 404 |
| `GET /api/v1/session` | Web Cookie 或原生 Bearer | 200 `{ signedIn: true, device }`；只返回脱敏登录状态和 `DeviceSummary`，不返回 account ID；未认证为 401，未绑定设备时 `device=null` |
| `POST /api/v1/session/logout` | Cookie/Bearer 可选 | 权威确认无有效 session，或当前 session/mapping 撤销事务已提交时返回 204；Web 只在该结果下过期 Cookie，不删除本地业务数据 |
| `GET /api/v1/health` | 无 | 200 `{ status: "ok" }`，不查询 D1 或泄露版本、bindings |

`installationId` 是随机、非秘密、环境隔离的安装标识，只能在已认证请求中使用，不参与认证。active row 使用 `UNIQUE(account_id, installation_id) WHERE revoked_at IS NULL`，因此正常重试复用同一 `deviceId`，历史撤销 row 仍可保留。若同一 installation 只有撤销历史，首次绑定返回 409 `device_rebind_confirmation_required`；只有 `confirmRebind=true` 且当前 session 创建时间晚于最新撤销时间时，才能创建新的 `deviceId` 并写审计，残留旧 session 不能静默复活设备。旧 session 即使携带 `confirmRebind=true` 也继续返回同一 409 且零写入，客户端必须重新认证；新 session 再次取得确认后才能重试。

新设备绑定在一个 Core D1 batch 中完成：先按 account 查找 active installation；不存在时用条件 `INSERT ... SELECT` 在 active count 小于 16 时创建，再严格插入当前 session 映射。`sync_device_sessions.session_id` 是引用 Better Auth `session.id` 且 `ON DELETE CASCADE` 的主键；同一 session 再绑定同一 device 才是幂等，绑定不同 installation/device 返回 409 `session_device_mismatch`。来自 Device Authorization attempt 的未绑定 session 必须使用第 6.2 节的 bind claim，让 device、mapping 和 `bound` 转换都依赖同一 nonce；其他登录流不创建 attempt，但仍使用同一个 batch 和条件 DML。并发 partial-unique 或数量 guard 的 loser 重新读取：已有同 installation active row 就幂等绑定，active count 已满就返回 409 `device_limit_reached`，不能依赖事务外 `COUNT`。撤销也在一个 Core D1 batch 中原子设置 `revokedAt`、按仍存在的 session mapping 删除锁定 Better Auth schema 中对应 session rows、删除 mappings、严格递增 Device Authorization generation、失效旧 attempt/code、删除旧 attempt 的未绑定派生 sessions 并写审计；有效 session logout 使用同一 generation/lineage 规则。任一 statement 失败则全部回滚。未绑定的原生 Device Authorization session 在用自身身份撤销其他设备后也属于旧 generation，必须被同批删除；这是释放设备名额后的预期失效，不允许客户端用旧 bearer 直接 bind。自然过期 session 的 hourly 删除通过外键级联清除 mapping；conformance 还必须验证无 orphan mapping。Better Auth 禁用 session cookie cache 和 secondary session storage；项目只维护这些由生成 migration 和 conformance test 固定的窄 session/Device Authorization SQL，不修改框架 schema。撤销前已经完成认证检查的在途业务请求允许完成，但不允许在撤销后用旧 attempt 留下可用的新 session；跨 `CORE_DB` 与业务 D1 不宣称原子撤销。

Hako 设备 API 请求体最多 16 KiB，超限在 JSON 解析前返回 413。它们使用第 7.4 节错误信封：`authentication_required` 为 401，`device_not_found` 为 404，`device_limit_reached`、`device_rebind_confirmation_required` 与 `session_device_mismatch` 为 409，`rate_limited` 为 429，`auth_maintenance` 与 `database_unavailable` 为 retryable 503。logout 是窄例外：没有凭据、凭据格式非法、或 Core 权威读取已确认 session 过期/不存在/已撤销时幂等返回 204；有效 session 的撤销与 mapping 删除必须在一个 Core 事务提交后才返回 204。Core 状态无法判定或撤销事务未提交时返回 retryable 503，不发送过期 Cookie 指令。这使撤销已提交但响应丢失的重试能在下一次权威读取中收敛到 204，而不确定结果不会让客户端提前丢失重试凭据。`identity_not_allowed` 与 `auth_capacity_limited` 只属于 Better Auth 登录 adapter 的拒绝结果；Better Auth `/api/auth/*` 与 RFC 8628 错误保持上游协议格式，客户端 auth adapter 负责把它映射为明确状态和提示，不能伪装成同步业务错误。

### 6.4 Core D1 与 migration 所有权

| 表 | 所有者与用途 |
| --- | --- |
| Better Auth core/plugin tables | `user`、`session`、`account`、`verification`、`passkey`、`deviceCode` 等；名称与字段由锁定版本生成的 migration 唯一维护 |
| `hako_accounts` | 第 6.1 节在公开部署前预置的唯一 owner account anchor；account ID、`application_id = "hako"` 与 provider 不变，subject 只可随 versioned manifest 在受控恢复中和 `auth_user_id` 原子切换，`auth_user_id` 只能由合规 OAuth 回调或受控恢复绑定 |
| `auth_runtime_state` | 环境 singleton Device Authorization generation；仅能在 code issue 读取或 logout/device revoke 事务中严格递增 |
| `sync_devices` | account、installation、名称、平台、创建/撤销时间和节流后的最近活跃时间 |
| `sync_device_sessions` | `session_id` 主键及其到 account/device 的显式映射；外键随 Better Auth session 删除，不复制 session token |
| `device_authorization_attempts` | code ID、冻结 generation、account/user、approver session、可空 approver device、冻结的 action proof ID、minted session、pending/approved/denied/minted/bound/invalid 状态，以及临时 `claim_nonce`/`claim_kind`；claim nonce 使用非空唯一索引，只作 batch 内仲裁，不存 code/token 原文 |
| `owner_action_proofs` | manifest application/account/provider/subject、可空 initiating owner user/session、至少 128 bit opaque context nonce、callback 后的 issued owner/session、`github_oauth_identity | passkey_uv` 方法、`passkey_registration | device_authorization_approval` 用途、固定 return route、创建/过期时间、pending/issued/consumed 状态、唯一 target 绑定、消费时间与 `consumed_by_claim_nonce`；同一未结束 Device Authorization attempt 最多一条 live context，Passkey 登记固定使用 GitHub owner 身份确认，原生设备批准在阶段一使用 GitHub owner 身份确认，阶段二起也可使用 UV Passkey |
| `passkey_audit_intents` | Passkey registration/delete 的短期 operation、credential、预期前后状态和补偿状态；`operation_id` 唯一且同一 credential 最多一条 unresolved intent，不保存 challenge 或 WebAuthn response |
| `auth_audit` | 有界的登录拒绝、Passkey/设备变化和 operator recovery 事件；固定 `rejection`、`activity`、`securityCritical` 优先级，不记录 token、code、email 或完整 OAuth payload |

认证中间件必须在每个请求中同时验证 Better Auth session、owner allowlist、与当前 release manifest 完全一致的唯一 `hako_accounts` anchor、`sync_device_sessions` 映射和 active `sync_devices`，再产生 `AuthenticatedPrincipal`。其中 `applicationId` 固定取服务端配置的 `hako`，`accountId` 固定取该 anchor，不能读取客户端同名字段或跨请求缓存旧映射。设备绑定、设备列表/撤销、登录状态、logout 与 Device Authorization 验证/批准是已验证 owner identity 但尚未绑定 session 可访问的窄例外；批准还必须满足第 6.2 节的一次性 action proof。它们不能产生 `AuthenticatedPrincipal` 或调用模块 D1。任何成功的 authenticated API 请求可触发 `lastSeenAt` 最多每小时一次的最佳努力更新；失败不得改变已经确定的主响应。

Better Auth schema 和 Hako 自有 Core 表可以位于同一 `CORE_DB`，但 migration 所有权必须显式分段：先由锁定版本生成 auth SQL 并审核，再追加项目自有 migration；不得手写修改 Better Auth 已生成列、让运行时自动补 schema，或让 Better Auth 查询业务 D1。第 5.3 节的项目自有索引/容量 trigger、本节的 session 外键，以及第 6.2 节的 Device Authorization code/approve/deny/token/session 版本绑定 wrapper、claim SQL 与断言 trigger 是仅有例外，必须作为版本绑定 migration/SQL 独立命名，并在每次 Better Auth schema 升级时重跑 conformance。

认证配置固定 `account.encryptOAuthTokens=true`、`verification.disableCleanup=true`、`overrideUserInfoOnSignIn=false`，并关闭 account linking。GitHub OAuth App 不提供 OIDC `idToken`；`/sign-in/social` 外层仍拒绝任何 `idToken` body 分支，锁定版本的 account create/update database hook 也必须保证待持久化 `idToken` 始终为 `null`。Hako 不开放 provider logout/token 功能；通过 `disabledPaths` 加外层 route allowlist 只暴露 Hako 实际使用的 GitHub OAuth redirect/callback、Passkey 和 Device Authorization 路径，公开 Better Auth `get-session`、provider access/refresh token 获取、link/unlink account、密码/邮箱注册及其他未列端点全部 404。

锁定的直接 D1/Kysely adapter 不能把首次 OAuth 的 Better Auth `user → account → session` 三步包进 interactive transaction。`OwnerIdentityGate` 在交给 Better Auth callback 前执行受控 orphan repair：仅当 provider/subject 精确命中数据库外 allowlist、subject-derived email 只对应一个 user，且该 user 不存在任何 provider account、session、Passkey、`hako_accounts`、device 或 audit 关联时，才在一个 D1 batch 里用重复 `NOT EXISTS` guard 条件删除这个纯孤儿 user，让 callback 重建。删除一行后重启本次 callback；删除零行必须权威重读：user 已不存在表示另一 repair 胜出，重启 callback；已出现与 allowlist provider/subject 精确一致的 account、session 或 Hako mapping 部分状态时，按已有 identity 的普通幂等路径继续；仍是纯孤儿时最多再执行一次相同条件删除，仍无进展才 fail closed。只有多行受影响、错误 owner 关联或权威重读出现无法归类的不一致状态时才进入 operator recovery，正常 repair 竞争不得切换 recovery 状态。存在 account 但 session 创建失败时绝不删除 user/account，普通 callback 重试应基于既有 provider account 创建 session。Better Auth 三步全部成功后的 Hako mapping/审计则按第 6.1 节独立、幂等地收敛。该 repair 不接收客户端 user ID/email，不处理任何非 allowlist identity，也不能演变为通用 account linking。

阶段一即预建 `owner_action_proofs` 和 `passkey_audit_intents`。`owner_action_proofs` 在阶段一开始写入 GitHub owner 身份确认方法的设备批准 proof，`passkey_audit_intents` 在阶段二前保持空表。认证记录只由 hourly scheduled handler 物理回收：每次 invocation 总计最多删除 500 行、每条 DML 最多 100 行，并为 `verification`、`deviceCode`、`device_authorization_attempts`、过期 session（依靠外键级联 mapping）、action proof、Passkey audit intent 和 `auth_audit` 分别保留可继续推进的分页。attempt 只能在关联 code 已不可用，且 minted session 已删除或已完成 `bound` 后删除；回收顺序不得先丢失未绑定派生 session 的撤销 lineage。失败留到下一小时，积压超过 24 小时或任一第 5.3 节容量门禁达到 70% 时告警。scheduled handler 在任何 D1 调用前读取随 Worker version 固定、位于 `CORE_DB` 外的认证门禁；状态不是 `normal` 时立即 no-op。Core export/restore/secret rotation 在切到 `deny_all` 后必须同时等待已启动的 API 和 scheduled invocation 排空，不能只排空 HTTP 请求；触发器传播延迟不能替代这条门禁。

`auth_audit` 是最多保留 90 天、全表硬上限 4096 行的有界 ring，其中公开的非 owner 登录拒绝桶最多占 1024 行。同一 `eventType + providerId + subjectHash + UTC hour` 的公开拒绝用唯一时间桶聚合 `count` 与首末时间，subject 只存 keyed hash；插入新拒绝桶同时原子检查 1024 子上限与 4096 总上限，达到上限就丢弃该新桶并增加边缘指标，但仍返回原 `identity_not_allowed`。

Hako 自有的设备、撤销和 operator recovery 状态变更必须与审计放在同一 Core D1 batch：若插入前已到 4096 行，同一 batch 按 `rejection → activity → securityCritical` 优先级和 `createdAt, id` 稳定顺序删除恰好一条最旧记录，然后插入最新审计。Passkey DML 仍由 Better Auth plugin 持有，公开 hook 不提供跨语句事务注入，因此不虚构同批原子性。registration options 阶段只绑定 action proof，不创建 audit intent；registration verification wrapper 先从客户端 WebAuthn credential response 提取并按 WebAuthn 规则校验/规范化 credential ID，再在调用 plugin verification 前以唯一 `operationId` 写入 pending `passkey_audit_intents`。delete wrapper 则使用请求中已经核验存在的 credential ID。条件 INSERT 同时强制全表 pending 小于 128，且 `UNIQUE(credential_id) WHERE status='pending'`；同一 credential 的 loser 在既有 intent 裁决前不得调用 plugin。两者都记录操作和预期前状态，intent 写入失败就不调用 plugin。plugin 返回后幂等地把实际结果写入 `auth_audit` 并删除 intent；若 Worker 在二者之间退出，hourly job 用该精确 credential ID 对照 Better Auth Passkey 权威表，判断 registration credential 已存在或 delete credential 已不存在，再以 `operationId` 补写同一审计并删除 intent。plugin 明确失败且权威状态未改变时删除 intent；结果无法判定时保留并告警，不猜测。一小时未收敛即告警，未裁决 intent 不因达到 24 小时而自动删除，新的 Passkey 变更可被门禁暂停直至人工裁决。审计淘汰增加告警指标；最新 Hako 自有安全变更不能仅因审计已满而失败，但除容量淘汰外的同批审计写错误仍使对应 Hako 自有状态事务回滚。普通 OAuth、Passkey、session 或 Device Authorization 请求不得执行会随过期 backlog 线性增长的删除；锁定配置必须关闭 Better Auth verification 的请求内惰性清理。scheduled cleanup 的 rows written、CPU 和查询数在阶段一 Free-first benchmark 中验证。

## 7. 模块同步协议 v1

### 7.1 路由与版本

每个模块使用独立端点：

- `POST /api/v1/modules/:moduleKey/sync/push`
- `GET /api/v1/modules/:moduleKey/sync/pull?transportProtocolVersion=1&readableSchemaVersions=1,2&limit=200[&after=<opaque-cursor>]`

`:moduleKey` 必须命中编译期服务端注册表；客户端不能通过 payload 选择 D1 binding。push 请求体与所有同步成功响应携带 `transportProtocolVersion` 和 `moduleKey`；第 7.4 节的请求级错误信封除外。push 批次还携带唯一的 `moduleSchemaVersion`，不同 payload 版本不得混在一个批次。

每个服务端模块注册项必须声明：

- `supportedChangeSchemaVersions`：当前 Worker 能编码新 change snapshot 并解码历史 change payload 的版本集合。
- `supportedPushSchemaVersions`：当前 Worker 能解码、规范化、校验和幂等重放的 mutation 版本集合。

模块 D1 的 `sync_metadata` 另存 `activeChangeSchemaVersion`、`acceptedPushSchemaVersions`、`requiredReadableChangeSchemaVersions`、随机 `epoch`、随机 `writeFence` 和 `maintenance` 状态。新 change 和新 conflict snapshot 使用当前请求固定的 active 版本，push 版本必须位于 accepted 集合，push/pull 客户端必须覆盖 required 集合。门禁固定为 `activeChangeSchemaVersion ∈ requiredReadableChangeSchemaVersions ⊆ supportedChangeSchemaVersions` 且 `acceptedPushSchemaVersions ⊆ supportedPushSchemaVersions`；现存 change 和 receipt conflict snapshot 仍可能返回的全部版本也必须包含在 required 集合中。Worker 只在这些条件全部成立且 `maintenance=false` 时开放该模块，不要求代码支持集合与数据库激活集合完全相等。

registry 的 supported 集合是 Worker 代码常量；D1 的 active、accepted 和 required metadata 禁止跨请求缓存。每个 push/pull 必须在业务操作前读取一次权威 metadata 并在整次请求内固定使用。pull 将 metadata/readable 检查与本页 change 查询放入同一个只读 `D1Database.batch()`；实现前必须用 conformance test 验证 D1 在该用法下提供一致快照，若无法证明则改为在同一事务取得受 metadata 约束的 seq 高水位，并只返回该高水位内的记录。push 可以继续使用预检时取得的旧快照处理整个批次，因为普通升级只扩展 accepted/required，旧 active 仍在 required 中。激活前开始的请求只产生和返回旧版本，激活后开始且不支持新 required 的请求在写入或查询前得到 426。

metadata 管理命令必须读取当前完整 tuple，并以 `WHERE` 精确匹配旧 tuple 的条件更新提交；affected rows 不是 1 时中止并重新读取。普通升级还必须断言新 accepted/required 分别是旧集合的超集、active 位于新 required 中，不能靠运维文字约定单调性。

版本升级分阶段完成：先应用不改变激活版本的 expand migration，再部署同时支持旧版和新版、但仍按旧 active 版本写 change 的 bridge Worker。新版加入 accepted 集合前，跨版本 golden fixtures 必须证明：每个合法新版 mutation 提交后的权威实体，经当前 active change codec 编码并由新版 codec 解码后，规范化领域语义保持相同。满足该无损 round-trip 门禁时，可以先扩展 accepted，再发布能够读取新旧 change 且写新版 mutation 的客户端，最后在独立事务中激活新写版本并把它加入 required。不能无损表示时，bridge 只暗发布 codec；兼容客户端发布后，在同一个 maintenance metadata 事务中扩展 accepted、切换 active 并扩展 required，激活前的新版 push 按第 7.1 节返回 409，不得提前写入。不得在首次加入新版 codec 的同一次部署中激活新版。accepted 和 required 在普通升级中只能增加，activation、epoch rotation 和恢复操作必须经过第 9 节同一个 maintenance 串行区，并只更新各自负责的列。

客户端冻结与迁移行为由[客户端 outbox 不变量](./hako-client-foundation.md#82-outbox-不变量)维护。服务端继续接受 accepted 集合中的旧 mutation，并按首次 receipt 重放；不能覆盖 required 集合的客户端在 push 或 pull 前收到 426。

cursor 不绑定 payload schema，因此升级后的客户端可从原 seq 继续拉取混合版本 change。change log 和 receipt 首版不自动清理，普通版本升级中的 required 集合只能增加；投入生产的旧 codec 不得直接删除。无法保持该兼容性的变更必须另写破坏性迁移规格，选择新 module key 或显式 epoch/outbox 迁移，不能静默返回永久 426。

transport 版本不兼容返回 426 `client_upgrade_required`；push/pull 声明未覆盖 required 集合时返回 426 `module_upgrade_required`。语法有效且 Worker 支持、但尚未进入 accepted 集合的 push 版本返回 409 `module_version_not_accepted`；超出当前 Worker supported 集合的 push 版本返回 409 `module_version_unsupported_by_server`。这两个 409 都表示服务端尚未具备接收能力，固定提供 `Retry-After: 300`，不提示用户升级客户端。各版本轴的所有者和边界以[客户端版本边界](./hako-client-foundation.md#51-版本边界)为唯一事实来源。

### 7.2 Push

请求体固定为 `{ transportProtocolVersion, moduleKey, moduleSchemaVersion, readableSchemaVersions, epoch, mutations }`，成功响应固定为 `{ transportProtocolVersion, moduleKey, epoch, results }`。请求体最大 256 KiB，单条规范化 payload 最大 64 KiB，private sync beta 单次最多 5 条 mutation；只有在 production-like benchmark 证明更大批次仍满足当前 Workers/D1 套餐的 query、CPU、内存和响应预算后，才能向上调整，但 transport v1 的绝对上限仍为 50。

Worker 在写入前按固定顺序处理请求：

1. 检查原始 body 大小、Content-Type、Origin 和认证；超限在 JSON 解析前返回 413。
2. 解析 JSON 并校验通用信封与字段语法；路径与 body 的 `moduleKey` 必须完全相同，版本字段必须是规定范围内的整数，否则返回 400/422。
3. 校验 transport、模块 registry、metadata 版本门禁和 epoch；语法有效但能力不兼容时才返回 409 或 426。
4. 用批次声明版本的 wire codec 解码全部 payload，并用该版本冻结的 canonicalizer 生成规范字节和请求哈希；任一结构或 codec 错误都使整批返回 422 且零写入。
5. 进入逐项业务 validator 与 D1 仲裁。解码后的业务无效数据形成稳定的逐项 `rejected` receipt，不再退回请求级 422。

客户端必须按 `moduleSchemaVersion` 分批。canonicalizer 把 `{ moduleSchemaVersion, entityType, entityId, operation, baseRevision, payload }` 按 RFC 8785 JSON Canonicalization Scheme 编码为 UTF-8，再计算 32 字节 SHA-256 请求哈希；批次顺序、`mutationId` 及 `readableSchemaVersions` 不参与哈希。每个已发布的 module schema version 必须冻结 canonicalizer 和共享 golden fixtures，缺失与 `null`、Unicode 字节和数字表示以后不得改变；需要改变时发布新的 module schema version。wire JSON 数值必须是有限的 IEEE-754 safe integer，超出范围的整数必须按 schema 使用规范十进制字符串，否则在第 4 步拒绝。

通用 mutation 字段：

| 字段 | 规则 |
| --- | --- |
| `mutationId` | 客户端全局生成 UUID v4，重新登录或重新授权设备后也不改变；服务端在当前 account 与模块内保证幂等 |
| `entityType` | 由模块 schema 定义 |
| `entityId` | UUID v4；一经用于任何已提交 create 或 tombstone 就永久退役，不得用于新实体 |
| `operation` | `create`、`update` 或 `delete` |
| `baseRevision` | 规范十进制字符串；create 为 `"0"`，update/delete 为最后确认 revision |
| `payload` | create/update 为模块完整快照；delete 为 `null` |

请求携带该模块最后确认的 `epoch`；缺失或不匹配时整批返回 409 `cursor_reset_required`，不得执行部分写入。全新客户端先 pull 获得 epoch。每条 mutation 事务中的所有状态变更语句，包括 change 和 receipt，都必须以请求开始时固定的 `epoch`、`writeFence` 和 `maintenance=false` 为条件；任一条件不再成立时整批停止并返回 503 `module_maintenance`，不能只依赖事务外预检。

通过预检后按请求顺序处理，每条 mutation 是一次独立的模块 D1 事务；一条冲突或拒绝不回滚其他项。每项结果都携带原 `mutationId`，与请求 mutation 一一对应并保持请求顺序。逐项结果只有：

- `applied`：目标实体的新 revision，使用规范十进制字符串；客户端仍必须通过 pull 推进 cursor。
- `conflict`：`revision_mismatch`、规范十进制字符串 current revision、`moduleSchemaVersion` 及该版本的服务端快照或 tombstone；首次结果使用 active 版本，receipt 重放保持首次版本和内容。
- `rejected`：稳定的通用或模块业务错误码。

create 遇到已退役的 `entityId` 时返回当前实体或 tombstone 的 `revision_mismatch` conflict；不能让底层唯一约束变成请求级 500。

mutation 首次终态 `applied`、`conflict` 或业务 `rejected` 必须和规范化请求哈希写入 receipt。`mutation_receipts` 以 `(account_id, mutation_id)` 为主键。receipt 预读未命中不代表取得执行权；`SyncRuntime` 必须把模块 DML、change 和严格的 receipt `INSERT` 放入同一 batch，禁止对首次 receipt 使用 `INSERT OR IGNORE` 或 `REPLACE`。模块业务写入未命中 guard 时，receipt 条件插入也必须为零，运行时重新读取并重试仲裁。

如果并发请求先取得同一 `mutationId`，loser 的严格 receipt insert 触发唯一约束并使整个 loser batch 回滚。Worker 随后从 primary 重读 winner receipt：请求哈希相同就返回首次终态并标记 `replayed: true`，不同则只把该项拒绝为 `idempotency_key_reused`。loser 的实体或 change 不得留下效果。

处理中途出现请求级可重试错误时，Worker 停止处理剩余 mutation 并返回对应非 200 错误；此前已经提交终态的 mutation 不回滚。客户端原样重试整个冻结批次时，已提交项由 receipt 返回 `replayed: true`，未处理项再首次执行。

### 7.3 Pull

`after` 可省略：这表示从 seq `0` bootstrap，而不是一个空字符串 cursor。`limit` 可省略，默认 100，只接受 1 至 200 的十进制整数。请求仍必须携带 transport 版本和客户端可读取的 payload 版本集合。响应顶层固定包含 `{ transportProtocolVersion, moduleKey, epoch, changes, nextCursor, hasMore }`；即使数据库没有 change，首次 bootstrap 也返回当前 epoch 和表示 seq `0` 的非空 `nextCursor`，客户端据此才可开始 push。

如果 `readableSchemaVersions` 未覆盖模块 D1 metadata 的 required 集合，服务端在查询或返回 change 前以 426 拒绝，不能部分返回或推进 cursor。change 至少包含：

- `seq`：十进制字符串。
- `moduleSchemaVersion`、`entityType`、`entityId`、规范十进制字符串 `revision`。
- `operation`: `upsert` 或 `delete`。
- `payload`：upsert 的完整不可变快照；delete 为 `null`。
- `originDeviceId` 和 `serverChangedAtMs`。

查询固定为 `account_id = AuthenticatedPrincipal.accountId AND seq > cursor.seq ORDER BY seq LIMIT`，不得使用 offset。单页编码后的 `changes` 最大 1 MiB；服务端按 `limit + 1` 查询，并在数量或字节预算先到达时停止。单条合法 change 必须能装入该预算，因此写入时已经受第 7.2 节单 payload 上限约束。只要最后实际返回项之后仍有记录，`hasMore=true`；`hasMore=false` 表示该页事务观察到的 seq 高水位内没有后续记录。存在未返回 change 时不得返回空页。

`nextCursor` 只推进到实际返回的最后一项；已有 cursor 的空页保持旧 cursor。push 响应不能推进 pull cursor。

cursor 编码 `{ transportProtocolVersion, accountId, moduleKey, epoch, seq }` 并带服务端 MAC，客户端视为不透明字符串，不能伪造或解析。服务端必须用当前 `AuthenticatedPrincipal.accountId` 校验 cursor，不能让一个 account 的 cursor 查询另一个 account。模块数据库 Time Travel、change log 不兼容迁移或日志重建后轮换该模块 epoch；其他模块不受影响。

### 7.4 请求级错误信封

```json
{
  "error": {
    "code": "database_unavailable",
    "retryable": true,
    "requestId": "uuid"
  }
}
```

| 场景 | HTTP 与语义 |
| --- | --- |
| session/Bearer 缺失、过期、无效或撤销 | 401 `authentication_required`，`retryable=false` |
| JSON 或字段非法 | 400/422 `invalid_request`，`retryable=false` |
| 请求体超过限制 | 413 `request_too_large`，`retryable=false` |
| 模块未部署 | 404 `module_not_found`，`retryable=false` |
| 目标设备不存在 | 404 `device_not_found`，`retryable=false` |
| mutation ID 换内容 | push HTTP 200 的逐项 `rejected` |
| push 版本受 Worker 支持但尚未 accepted | 409 `module_version_not_accepted`，`retryable=true`，`Retry-After: 300` |
| push 版本超出 Worker supported 集合 | 409 `module_version_unsupported_by_server`，`retryable=true`，`Retry-After: 300` |
| cursor MAC/字段无效或 epoch 不匹配 | 409 `cursor_reset_required`，`retryable=false` |
| active device 已达上限 | 409 `device_limit_reached`，`retryable=false` |
| installation 存在撤销历史且尚未由新 session 确认 | 409 `device_rebind_confirmation_required`，`retryable=false` |
| 当前 session 已绑定其他 installation/device | 409 `session_device_mismatch`，`retryable=false` |
| 业务 revision 冲突 | push HTTP 200 的逐项 `conflict` |
| 限速 | 429 `rate_limited`，`retryable=true` 并提供 `Retry-After` |
| Core 处于认证或全局维护窗口 | 503 `auth_maintenance`，`retryable=true` 并提供 `Retry-After` |
| 模块处于维护窗口 | 503 `module_maintenance`，`retryable=true` 并提供 `Retry-After` |
| invocation 已超过 D1 调用发起截止时间 | 503 `request_deadline_exceeded`，`retryable=true` 并提供 `Retry-After` |
| 模块约束 CAS 持续争用 | 503 `constraint_contention`，`retryable=true` |
| Core 或模块 D1 暂时不可用 | 503 `database_unavailable`，`retryable=true` |
| 未知服务端错误 | 500 `internal_error`，`retryable=true` |
| transport 版本不兼容 | 426 `client_upgrade_required`，`retryable=false` |
| module schema 不兼容 | 426 `module_upgrade_required`，`retryable=false` |

本文只定义服务端结果；客户端暂停范围、重试和 intent 处理以[客户端错误映射](./hako-client-foundation.md#84-调度与故障隔离)为唯一事实来源。

## 8. 模块 D1 接入契约

每个同步模块所在的业务 D1 至少包含：

| 表 | 用途 |
| --- | --- |
| `sync_metadata` | module key、active/accepted/required payload 版本、随机 epoch、write fence 与 maintenance 状态 |
| `mutation_receipts` | 以 account + mutation ID 为主键，保存来源设备、请求哈希、首次终态和完整结果 |
| `changes` | D1 内自增 seq、account、实体/版本、操作、不可变 snapshot、设备和服务端时间；account 可有 seq 间隙 |
| 模块业务表 | 由模块规格定义 |

通用约束：

- 每次 push/pull 都读取不跨请求缓存的 metadata，校验 registry key 与 metadata key 相等，并执行第 7.1 节的 active/accepted/required 门禁；不兼容只使该模块返回 503，不能阻止 Worker 或其他模块启动。
- 所有业务实体、tombstone、receipt 和 change 都有非空 `account_id`，值只取自 `AuthenticatedPrincipal`；所有读取、约束和写入都必须带 account guard，模块 wire payload 不含该字段。
- `UNIQUE(account_id, entity_type, entity_id, revision)`；同一 account 的同一实体版本只有一条 change。
- `changes` 保存当时的完整快照，不能只保存指向当前实体的指针。
- 同一 mutation 的 receipt、实体变化和 change 必须由 `SyncRuntime` 组装到一个该模块 `D1Database.batch()`；任何 statement 失败都回滚整个 sequence。模块计划必须返回每条 DML 的预期 affected rows 和结果解释器，不能只依赖 TypeScript 预读判断成功。
- TypeScript 的预读和纯 validator 只能提供早期错误；涉及多行或跨实体不变量的模块必须在同一 D1 batch 中使用条件 DML、guard revision 或 trigger 作最终仲裁，affected row 不符合预期时整条 mutation 冲突或拒绝。
- revision 只由服务端当前值仲裁，不使用客户端时间；D1 内使用有符号 64 位整数，读出时 `CAST(... AS TEXT)`，create 从 `1` 开始，已接受 update/delete 每次加 `1`，传输层只使用规范十进制字符串。
- tombstone 不能物理删除。private sync beta 不自动清理 receipt 和 change log，以保证离线设备可重放和 bootstrap；这不是永久兼容承诺。任一业务 D1 达到套餐容量的 70% 前必须暂停新增高写入模块并完成 compaction 规格，compaction 必须提供 snapshot bootstrap、轮换 epoch 并覆盖离线客户端恢复。
- Core 认证记录的容量门禁与有界回收只由第 5.3、6.4 节维护；模块运行时不得复制或绕过它们。`auth_audit` 的阶段一硬上限/90 天保留不可推迟；`sync_devices` 撤销记录的长期保留细化可在 hardening 阶段补充，清理不得影响模块库中的 `originDeviceId` 审计字符串。
- 模块不能查询 `CORE_DB` 或其他模块 D1，也不能建立跨库外键。

首个模块 `fuel` 的表、实体类型、payload 和业务 validator 由[Fuel 同步接入规格](./fuel-tracking.md#9-fuel-同步接入)唯一维护。

## 9. 故障、回档与安全恢复

| 故障 | 服务端行为 |
| --- | --- |
| `CORE_DB` 不可用 | 需要身份的 API 返回 503，不写模块 D1；离线客户端不受影响 |
| 单个模块 D1 不可用 | 仅该模块路由返回 503；认证、设备管理和其他模块保持可用 |
| 模块 handler 抛错 | 转为脱敏 500，不影响其他路由 |
| GitHub OAuth 不可用 | 既有有效 session 和已登记 Passkey 登录继续工作；GitHub 登录与 operator recovery 暂停，本地功能保持可用 |
| Worker 发布故障 | 远端 API 暂停，不改变客户端本地数据 |

private sync beta 必须先具备可执行的最小恢复路径，但不要求第一版就实现全部自动化运维探针。

模块与 Core 恢复共用同一排空定义。maintenance deployment 必须只包含预期的单一 Worker version 并承载 100% 流量；不得把旧 normal version 以 0% 留在同一 deployment，也不得保留可命中旧 version 的 override 或 production preview URL。production 固定 `preview_urls=false`，canonical Host 与 release-manifest 完整性检查在任何 D1 调用前执行。只有 deployment API、`CF_VERSION_METADATA` 与 canonical-host probe 都确认预期门禁 version 已全量生效后才记录 `drainStartedAt`，随后至少等待 50 秒：旧 invocation 最迟在入口后 20 秒发起 D1，已发起的单条 query 或整次 `batch()` 最迟再运行 30 秒。等待期间禁止发布、改变门禁或执行目标 metadata 管理写；日志暂未观察到 D1 调用、Time Travel 会取消当时的 query，均不能缩短这 50 秒。

涉及 owner OAuth 的恢复还必须先启用 `RecoveryEdgeGate`：operator 通过 Cloudflare zone WAF custom rule，在 production hostname 的 `/api` 与 `/api/*` 上阻断除本次 operator 精确公网 IP 外的全部请求。启用前通过 Cloudflare API 枚举并保存该 zone 的 IP Access rules、custom rules 顺序与 Skip 参数；production host/path 存在任何适用的 IP Access `Allow`、前置 custom `Skip` 或其他能绕过该 gate 的规则时，必须先临时移除/禁用并再次枚举，不能只新增一条靠后的 block rule。RecoveryEdgeGate rule ID、规范表达式、operator IP、被临时禁用规则的精确快照、environment、Worker version 与 release-manifest hash 写入本次 recovery manifest；必须同时通过 Cloudflare API、允许来源探针和至少一个不属于既有 allowlist 的独立拒绝来源探针确认规则已经生效，才能从 `deny_all` 进入 `owner_recovery`。operator IP 变化时立即回到 `deny_all`，更新并重新验证规则。该门禁在 Worker invocation 前阻止匿名流量重新填满 verification/device-code 容量，从恢复开始一直保留到 normal version 的只读 smoke 通过，随后才删除，并按快照恢复此前规则、重新核验常态 WAF；它不替代常态 WAF rate rule，也不开放公共恢复 API。

恢复模块 D1：

1. 在目标 D1 条件事务中设置 `maintenance=true` 并轮换 `writeFence`，让已经预检但尚未提交的旧 mutation 零写入。
2. 生成并部署 `forcedModuleMaintenanceKeys` 包含精确目标 `moduleKey` 的 versioned release manifest。该列表只能包含编译期 registry 的已知、无重复 key，否则启动失败；门禁在认证、解析同步 body 或访问目标 D1 前返回 retryable 503 `module_maintenance`，Core 与其他模块继续服务。按本节共同定义确认该 maintenance version 是唯一 active version。
3. 从确认时刻执行至少 50 秒排空屏障；完成后才记录恢复前 bookmark，并执行 Time Travel 或从已验证导出恢复。数据库内的 `maintenance` 和 `writeFence` 可能被一并回档，因此整个步骤都必须保留数据库外模块门禁。
4. 保持外部门禁，重新应用并验证 migrations；从 D1 外的 versioned activation manifest 恢复已批准的 active/accepted/required 集合，并在同一 metadata 事务中写入新的随机 `writeFence`、轮换 epoch、保持 `maintenance=true`。旧 cursor 和旧 epoch mutation 从此不能写入新时间线。
5. beta 先在恢复副本或 disposable preview 上完成全量 pull、conformance 和客户端 recovery 验证。随后部署将来实际承载流量、从 `forcedModuleMaintenanceKeys` 移除目标模块的唯一候选 version；数据库内 `maintenance=true` 仍使公开目标路由返回 503。hardening 阶段才增加由 Cloudflare Access 保护的 production 只读 pull probe；它只能绕过数据库内的读门禁，且必须核验 canonical Host、Worker version、manifest、epoch 与 write fence，不能接受用户 token、push、写 D1 或推进真实 cursor。
6. 候选验证后只以条件 metadata 事务设置 `maintenance=false`，不得在验证与开放之间再次部署。恢复后第一个可写请求必须观察到新 epoch 和 write fence。

恢复 `CORE_DB` 是安全事件，因为 Time Travel 可能复活旧 session、device code 或已删除 Passkey：

1. 先启用并验证 `RecoveryEdgeGate`，再部署 `authGateMode=deny_all` 的单一 active Worker version，关闭认证、同步和 scheduled cleanup 的 D1 入口；仅修改 D1 内标志不足以抵抗 Time Travel 回档，也不得保留可由 override/preview URL 到达的旧 normal version。
2. deployment metadata 与 canonical-host probe 确认该 version 后执行至少 50 秒共同排空屏障。旧 OAuth callback、Passkey invocation、scheduled cleanup 和 `waitUntil` 任务即使仍停在外部 I/O，超过各自 20 秒截止后也不得再发起 `CORE_DB` 调用。屏障完成后才核验 release manifest 的 hash、environment、稳定 account ID、owner provider/subject、Worker allowlist、实际 Core D1 database ID 和全部已接入业务 D1 database ID；manifest 缺失、allowlist 不是从该 manifest 派生或任一值不符时保持 `deny_all`。核验通过后才执行恢复并重新应用当前 Core migrations。
3. 在恢复后的事务中撤销全部 Better Auth session、Device Authorization code/attempt、verification state、Passkey 和 Hako sync device，删除全部 `owner_action_proofs`，并严格递增 `device_authorization_generation`；恢复出的 `passkey_audit_intents` 因其时间线已不可信，在 Passkey 全量撤销后统一终结，并写一条包含数量但不含 secret 的 `core_recovery_discarded_auth_intents` 安全审计。`hako_accounts` 恰好一行且 account ID、application、provider、subject 与当前或恢复流程明确指定的旧 manifest tuple 完全一致时才保留，并核验其 Better Auth user/provider account；因 bookmark 早于 account anchor seed 而没有 mapping 时记录为待重建。出现其他 account ID、多行或 tuple 不符时保持 `deny_all`，不得自动改写或生成新 ID。production 不能带着恢复出的旧认证状态直接开放。
4. 若怀疑 Better Auth secret 泄露，不能直接替换单钥或无限保留泄露旧钥。保持 `deny_all`，在受审 Core D1 batch 中清空所有 account access/refresh/`idToken` ciphertext、撤销全部 session/verification/device code，并在 GitHub 支持时撤销远端 token；然后部署只含全新 version 的 `BETTER_AUTH_SECRETS` keyring，确认旧 version 完全移除后才继续恢复。Hako 不开放 provider token 功能，因此选择清空而非逐行重加密；下一次 owner GitHub OAuth 会写入新 key version 的 access token ciphertext，`idToken` 仍为 null。若怀疑 GitHub OAuth client secret 泄露则同时在 GitHub 侧轮换 client secret。只发生数据误操作时无需无意义轮换这些 secrets。`github` + numeric user ID owner allowlist 位于恢复数据库外并保持不变。
5. 若恢复后的 GitHub numeric user ID 与精确 account mapping 仍和数据库外 allowlist、manifest 一致，把门禁切到 `owner_recovery`，直接用同一 owner GitHub OAuth 创建新 session、绑定设备并凭新的 GitHub owner 身份确认登记 Passkey，不创建隔离 identity，也不执行 account CAS。mapping 因恢复点早于 account anchor seed 而完全缺失时，allowlist OAuth callback 只创建隔离 Better Auth identity/session；operator CLI 以表中零 account row、manifest account ID 和匹配 provider/subject 为条件，在同一 Core D1 batch 中插入原 account ID mapping 与 recovery 审计。numeric ID 已更换时使用第 6.1 节的隔离 identity，并以固定 account/application/provider、旧 manifest subject 与旧 `auth_user_id` 为条件，把 `provider_subject` 和 `auth_user_id` 原子切到新 manifest/new identity。任一分支失败都回到 `deny_all`；不得猜测、新建其他 account ID、迁移业务 D1 行或开放空工作区。验证旧 session/Bearer 均失败。没有公共恢复密钥或 recovery-register mode。
6. `owner_recovery` 下 hourly scheduled handler 仍不得访问 D1；若新 Passkey 的 plugin 调用与 audit finalize 之间退出，beta 使用仓库内版本锁定、由 operator 通过 Wrangler 身份在本地执行的 `reconcile-passkey-audit` CLI。CLI 启动前要求手工输入并精确确认 environment、Worker version、Core D1 database ID 和 release manifest hash，每次最多读取 128 条当前 recovery window 的 intent，只按精确 credential ID 对照 Better Auth Passkey 表并执行第 6.4 节的同一补偿，不开放 HTTP 路由、用户 token 或其他表权限。用户完成 OAuth、设备绑定与 Passkey 登记后，不得从 `owner_recovery` 直接开放：先部署相同 artifact/bindings/secrets、仅把 `authGateMode` 改回 `deny_all` 的单一 active version，确认后执行共同 50 秒排空，使已启动的 recovery callback、Passkey ceremony 和 audit finalize 都不能再触碰 D1。
7. 最终冻结后，operator CLI 权威核验唯一 account mapping、预期 owner subject、当前恢复 session/device、Passkey 集合、零 verification/device-code/attempt、零 action proof 与零未决 audit intent。beta 的 `verify-recovery-module-read` CLI 同样通过 Wrangler operator 身份运行，逐个要求精确确认 environment、候选 Worker version、module D1 database ID、release manifest hash、稳定 account ID、预期 epoch 与 write fence；它复用只读 pull codec/page 查询模块 D1，不访问 Core、不接受用户 token、不写 D1，也不推进真实客户端 cursor。只有 Core 核验和每个未回档模块日志核验都通过，才能部署 artifact、bindings、secrets 与已验证候选完全一致而仅把门禁改为 `normal` 的 version；不得在这两次部署间改代码、binding、secret 或 manifest。在 `RecoveryEdgeGate` 下完成 normal 的 session/只读 pull smoke 后才删除该 edge rule。阶段四可把两个 CLI 增强为具备同等边界的 Access 内部端点，但不能成为 beta 恢复前提。各模块 D1 未回档时不轮换其 epoch；稳定 account ID 不变，因此这些模块的既有 cursor、receipt 和业务行继续属于同一 account。若也恢复业务 D1，则分别执行上面的模块流程。

D1 Time Travel 只覆盖指定数据库，不回滚 Worker 代码、secrets 或其他 D1。Free/Paid 的恢复窗口不同，且都不能替代长期导出。Worker 回滚不会回滚 schema，因此 migration 使用 expand/contract，部署后的 schema 至少兼容当前和指定 rollback version。

## 10. 安全基线

以下项目在首次把认证或同步 API 暴露到互联网前就是上线门禁，不能以“以后再加安全”为由推迟：

- production 使用固定 HTTPS custom hostname，local 只使用 `http://localhost:8787`；每个已启用环境的 OAuth callback、Better Auth base URL、ceremony origin 和 RP ID 必须精确匹配第 5.2 节对应行，禁止任意 redirect URI 或跨环境复用。
- owner 使用 release manifest 固定并派生的 GitHub numeric user ID allowlist，公开认证启用前已预置唯一 Hako account anchor，并关闭公开注册和 email 自动合并；subject 变化只能走第 6.1 节的 operator recovery。Passkey 登记和原生设备批准都必须消费十分钟内签发、与当前 session/用途/目标绑定的一次性 owner action proof；`github_oauth_identity` 只确认 owner 身份，只有 `passkey_uv` 提供近期强认证。
- Better Auth 的 OAuth state、PKCE、CSRF/Origin 检查、安全 Cookie、Passkey challenge、Device Authorization expiry/polling guard 全部保持启用；Passkey registration/authentication 都要求经过服务器验证的 `userVerified=true`，关闭 ID-token 直登和请求内无界 verification cleanup，原生 token 不进入 Vue、WebView、URL、日志或明文 store。
- 所有 SQL 使用 prepared statement 和 bind 参数；模块 route 到 D1 binding 的映射是编译期常量，不接受请求值索引任意 `env` 属性。
- 原始 D1 binding 不得离开 Worker 入口；所有 fetch、scheduled、Better Auth、模块和 `waitUntil` 路径只能经第 4 节的 `DeadlineCheckedD1` 发起调用，新增未包装的终端 D1 方法必须使 conformance 失败。
- Hono 在解析 JSON 前执行 body 上限、Content-Type、可信 Host 与限流检查；API、异常和日志不得回显原始 D1 错误、SQL、OAuth token、Cookie、device code、WebAuthn response 或完整业务 payload。
- API 返回 `no-store`、HSTS、`nosniff` 等头；静态 HTML 的 CSP、相同 HSTS、frame 防护和其他 header 由 `dist/web/_headers` 唯一配置。
- production、preview、local 的 D1、OAuth client、Better Auth secret、release manifest、稳定 account ID、origin 和 RP ID 完全隔离；Worker owner allowlist 只从同环境的已批准 manifest 派生，测试不得连接 production binding。数据库外认证门禁只允许 `normal`、`deny_all`、`owner_recovery` 三态；模块门禁只允许 release manifest 的 `forcedModuleMaintenanceKeys` 引用编译期 registry 中已知且不重复的 key，任一未知值或配置混搭都启动失败。
- `BETTER_AUTH_SECRETS` 使用带单调整数 version 的 keyring，每个 key 与 `HAKO_CURSOR_MAC_KEY` 分别使用至少 32 个密码学安全随机字节；第一项只用于新加密，其余只在受控迁移窗口解密旧 envelope。泄露响应按第 9 节清空 provider token ciphertext 并移除旧 version，不能把旧 key 永久留作 fallback。cursor 使用固定 domain separator、规范 tuple、HMAC-SHA-256、base64url 和固定时长 MAC 比较；任何非法输入 fail closed。
- Better Auth 及插件精确锁版本，启用依赖安全告警；每次升级审核 changelog、auth schema diff、Cookie/session 行为和 security advisory。
- Cloudflare 的传输/静态加密不是端到端加密；服务维护者能够读取同步业务数据，客户端在启用同步前披露。

以下属于 hardening 阶段，可在纯离线阶段或仅本机开发时不实现，但不得假装已经具备：preview 远端环境、Cloudflare Access 运维探针、自动 D1 导出、定时恢复演练、secret rotation runbook、全 D1 容量/费用/账单告警、change compaction 和多 payload version bridge。阶段一仍必须交付第 6.4 节仅针对公开认证记录 backlog 与容量门禁的最小告警；它不是完整的运维监控。Cloudflare Access 只保护 `/api/internal/*`，不作为 Hako 用户登录、设备身份或 Passkey 系统。

## 11. 发布、费用与运维

- D1 migration 总是先过 local。持久 preview 建立后，再经 preview conformance 和 production 备份后应用；首次 production `CORE_DB` 尚无持久 preview 时，必须先在一次性 remote D1 上应用同一 migration、运行 auth conformance 并删除该临时资源，不能因阶段顺序跳过远端验证。Better Auth schema 先由锁定 CLI 生成并审核，再作为 Wrangler SQL migration 提交；production 禁止 runtime auto-migrate。
- 第一个远端 beta 固定 GitHub OAuth App、单一 owner 和 Fuel payload v1，不先建设通用 OAuth Provider、多租户或 schema bridge。第 7.1 节的多版本机制在第一次真实 payload v2 前实现和验证即可。
- Free-first：阶段一先用 Workers Free + production Core D1，但首次公开认证前必须已经启用第 5.3 节的 invocation 前 WAF rule。Workers Free 每个账号每天只有 100,000 次动态 Worker 请求并按 UTC 重置；请求一旦进入 Worker，即使 health、应用内 429 或认证失败也占 invocation。阶段一对 OAuth callback、session、Device Authorization、设备绑定/撤销和 scheduled cleanup 记录当前套餐的 invocation、D1 queries、rows read/written、CPU、内存和响应大小；阶段三再加入 production Fuel D1，用真实满载 fixture 测同步路径并把 push 批次固定为 5。日额度达到 50% 时告警；达到 75% 或确认遭遇消耗攻击时，在继续公开服务前必须通过 zone WAF 临时只允许 owner 来源，或升级 Workers Paid。只要任一已引入关键路径超过 Free limits 或需要更长 Time Travel 窗口，也必须在开放相应能力前升级；发生升级后只需在 Paid 重测，不要求为了对照指标主动付费，且不能削弱原子性或校验。
- Workers Paid 是 Cloudflare 账号级套餐，不按 Worker 或 D1 数量分别收取。截至 2026-08-12，最低订阅为每月 5 美元，含每月 1000 万动态请求和 3000 万 CPU-ms；D1 Paid 另按超出包含量的 rows read、rows written 和存储计费，静态资源请求免费且 D1 无 egress 费。价格只作预算快照，部署前必须以官方 pricing 页复核。
- D1 按第 5.1 节从 0 → 1 → 2 → 4 渐进创建。production/preview 共四个 D1 是 hardening 目标，不是四份独立账单，也不是开始本地功能的前提。
- Free D1 Time Travel 最多 7 天，Paid 最多 30 天。进入 production hardening 后，每月至少导出 Core 和业务 D1，并在 migration、metadata 激活和 Time Travel 前额外导出；导出文件离线加密保存并定期演练导入。D1 export 会阻塞目标数据库，请求必须先进入对应 maintenance，而不是在普通请求内等待。
- 每日检查 Worker dynamic invocation 与 Free 额度门槛；每周检查 D1 size、rows read/written 与 Worker CPU。任一业务 D1 达到容量 70% 前停止新增高写入模块并完成 compaction 规格，不依赖第二模块或 payload v2 才触发。配置 Worker CPU/subrequest 上限和账单告警，避免意外费用。
- payload rollout 遵守第 7.1 节：无损路径为 bridge → accepted → 客户端 → active/required；非无损路径为 bridge 暗发布 → 兼容客户端（预激活 push 409）→ accepted/active/required 同一 maintenance 事务。
- Wrangler dry-run 只能验证 bundle 与声明，不能证明远端 binding、OAuth callback 或 RP ID 实际正确。首次公开 production 认证前，OAuth、Device Authorization 和写入流程先在 local 与一次性 remote D1 验证；持久 preview 建立后改由 preview 承担。常规 production smoke 使用既有 owner session 执行 health、session、设备列表和只读 pull，禁止用破坏性 operator recovery 做 smoke test。

外部依赖：Cloudflare 账号、用户自有域名、可管理该域名 zone WAF rule 的 operator 权限、每个已启用环境独立的 GitHub OAuth App client credentials、环境独立且带 version 的 `BETTER_AUTH_SECRETS` keyring、包含 `github` provider、GitHub numeric subject 与 `HAKO_OWNER_ACCOUNT_ID` anchor 的 release manifest，以及 `HAKO_CURSOR_MAC_KEY`。Worker owner allowlist 从 manifest 派生。阶段一还需要 hourly Cron 回收过期认证记录；Cloudflare Access、持久远端 preview 和自动导出只在 hardening 阶段成为依赖。

## 12. 计划文件边界

```text
pnpm-workspace.yaml             # 根 workspace：客户端与 server package
server/
  package.json                 # 服务端独立依赖与 scripts，不生成独立 lockfile
  wrangler.jsonc
  tsconfig.json
  src/
    index.ts                    # Hono API 入口
    core/
      auth/                     # Better Auth config、AuthenticatedPrincipal adapter、owner 与设备
      errors/                   # 错误信封和日志脱敏
      modules/                  # 服务端静态模块注册表
      sync/                     # 通用门禁、receipt、cursor 与 push/pull 运行时
    modules/<moduleKey>/        # 模块 handler 与 D1 repository
  deploy/<environment>/
    module-activation.json      # 目标 D1 外的已批准 payload 激活状态
    release-manifest.json       # 已批准 Worker version、环境、origin/RP ID、稳定 account ID、D1 IDs、authGateMode 与 forcedModuleMaintenanceKeys
  migrations/
    core/                       # 审核后的 Better Auth SQL 与 Hako Core migrations
    <moduleKey>/                # 模块 D1 migrations
  scripts/                      # 版本锁定的 beta operator recovery CLI
  tests/                        # Workers/D1 集成测试
public/
  _headers                      # 随 Web 构建复制到 dist/web 的静态安全头
shared/
  auth/                         # 不含 Better Auth 类型的 Hako auth/device DTO
  sync/                         # 通用 HTTP DTO 与 Zod schema
  modules/<moduleKey>/          # 模块 wire schema；由对应模块拥有
```

## 13. 可独立合并的实施阶段

### 阶段零：离线产品

先实现客户端应用壳与离线 Fuel；不创建 `server/` 远端资源、不要求登录，也不产生 Cloudflare 费用。这是当前的下一实施阶段。

### 阶段一：认证纵向切片

创建 `server/` workspace、一个 Worker、本地与 production `CORE_DB`、`DeadlineCheckedD1`、invocation 前 WAF rule、`RecoveryEdgeGate` runbook、认证记录容量 trigger、hourly cleanup 及其 backlog/70% 最小告警、Hono/Better Auth 集成和固定 custom-domain 配置。Core migration 创建 `auth_runtime_state`、`device_authorization_attempts`、`owner_action_proofs` 与 `passkey_audit_intents`：阶段一立即使用 GitHub owner 身份确认方法的设备批准 proof，`passkey_audit_intents` 到阶段二才开始写入。接入 GitHub OAuth App、由 release manifest 派生的 GitHub numeric user ID owner allowlist、Web Cookie、五原生 Hako RFC 8628 Device Authorization、`AuthenticatedPrincipal`、Hako 设备绑定/撤销和认证集成测试。通过一次性 remote D1 验证 migration 后，生成并离线备份 production release manifest 与稳定 account ID，在 production `CORE_DB` 条件预置唯一 `hako_accounts` anchor，完成资源/manifest/anchor 核验后才允许 Worker 对外提供认证路由。allowlist owner 首次 GitHub OAuth 只绑定该 anchor 的 `auth_user_id`，再绑定首台设备并核验 callback/origin；原生设备批准还必须消费同一 owner 十分钟内签发的 GitHub owner 身份确认 proof。后续发布 smoke 一律使用既有 session。尚未开放同步时模块路由返回 404 `module_not_found`。

### 阶段二：Passkey

先完成一次绑定当前 session 与 ceremony、十分钟内签发的 GitHub owner 身份确认，再登记 Passkey；完成 Web 登录、Passkey 删除/登录和 OAuth 恢复测试。阶段二后，经服务端确认 UV 的 Passkey 可签发 `purpose = device_authorization_approval` 的近期强认证 proof；GitHub owner 身份确认仍是个人版 fallback，但不宣称近期强认证。不得为了 Passkey 把认证页面塞进 Tauri WebView，也不建设 Hako OAuth Provider。

### 阶段三：Fuel private sync beta

创建 production `FUEL_DB`，以固定 payload v1 和最多 5 条 mutation 的批次交付 registry、push/pull、receipt/change/epoch、数据库外 `forcedModuleMaintenanceKeys` 门禁、Fuel handler 与端到端测试。先验证 Free limits；不满足时升级 Workers Paid。同步不可用时阶段零能力不降级。

### 阶段四：发布 hardening 与通用化

增加远端 preview 两个 D1、Access 运维探针、自动导出、全 D1 容量/费用/账单告警、恢复与 secret rotation 演练。阶段一认证记录最小告警继续保留并纳入统一监控。通用多版本 bridge 由第一个 payload v2 触发，跨模块恢复设计由第二个模块或共享 D1 触发，compaction 由实际 retention/容量门禁触发；只有第 1 节的拆分条件出现时才新建通用服务端项目。

## 14. 验证与验收

各阶段只需通过本阶段已引入的门禁；不得要求阶段零先实现阶段四运维。最终目标自动化测试至少覆盖：

- SPA 深链接返回应用壳并带 CSP/HSTS 等 `_headers` 安全头，`/api` 与 `/api/*` 永远不被 SPA fallback 或缓存接管，未知 API 返回 JSON 404。
- production/preview 绑定和 secrets 不能交叉，测试环境无法访问 production D1。
- production WAF rate rule 的 path/阈值与 deployment manifest 完全一致；Free-first 的 zone inventory 证明其他 hostname 不使用 `/api` 或 `/api/*`，否则部署门禁要求升级并增加 Host 条件。持续超阈值探针最终由 WAF 429 阻断，发送量大于 Worker invocation marker 的增量，但测试不得假定精确第 11 次必然被拦截。Free dynamic invocation 达到 50% 会告警，达到 75% 会触发临时 owner-only WAF 或 Paid 升级门禁；计数传播延迟和分布式来源绕过单 IP 规则的演练仍按第 15 节 fail closed，而不宣称 WAF 提供全局精确配额。
- production 公开认证前已有且只有一条 `application_id = "hako"`、account ID/provider/subject 与 release manifest 完全相同、`auth_user_id IS NULL` 的 `hako_accounts` anchor；manifest 缺失或 anchor 缺失/多行/字段不符时 Worker fail closed。非 allowlist GitHub numeric user ID 即使 email/`login` 与 owner 相同，也不能通过首次或既有 OAuth callback、Passkey 和 Device Authorization 敏感路由创建或刷新 session；拒绝不新增或修改 Better Auth user/account/session，预置 Hako account anchor 的前后快照完全相同。允许的 owner 即使修改 GitHub `login` 或公开邮箱仍映射到同一 account，numeric ID 变化则必须进入 operator recovery。首次合法 GitHub OAuth 只把预置 anchor 绑定到唯一 Better Auth user，不创建或选择 Hako account；故障注入覆盖 user INSERT 成功/account INSERT 失败后的 guarded orphan repair、两个 callback 并发 repair 同一纯孤儿 user、account 成功/session 失败后的保留 account 重试、Better Auth session 成功/Hako anchor CAS 失败，以及 CAS 成功/响应丢失，全部重试后都不切换 operator recovery，且只收敛到一个 owner identity、account anchor、session、Hako mapping 和 identity-bound audit。
- production、preview 和 local 的 GitHub OAuth App client ID/secret 与 callback 不交叉；callback 只接受对应 canonical origin 的 `/api/auth/callback/github`，local 精确使用 `http://localhost:8787` 并拒绝 `127.0.0.1`。授权请求的 scope 集合精确为 `read:user user:email`，GitHub Device Flow 保持关闭。GitHub 主邮箱 private、`/user` email 为 null、`login` 更名和错误环境 callback 都必须通过 conformance；任何路径都不能请求或使用仓库、组织、workflow 权限。
- OAuth state/PKCE、Origin/CSRF、Cookie 属性和日志脱敏符合 Better Auth 固定版本与安全基线；`idToken` 直登在配置和外层请求校验中双重关闭，公开 `get-session`、provider-token/account-linking 路径为 404。Passkey verification 在 128 KiB 边界内成功、超过一字节即在解析/plugin/D1 前 413；其他 auth body 同样覆盖 16 KiB 的边界、缺失或伪造 `Content-Length`。除原生 `/device/token` 的 RFC JSON 外，全部公开认证响应的 header/body 都没有 `set-auth-token`、顶层 `token`、`session.token` 或其他 bearer，正常 Web OAuth/Passkey 登录后只能通过 HttpOnly Cookie 读取 Hako 会话摘要。数据库 account row 的 access/refresh token 已加密，`idToken` 在首次及重复 OAuth create/update 时均为 null，user/account 行不含真实 provider email 或可解码的明文身份 JWT。任一环境的 redirect URI、base URL、ceremony origin 和 RP ID 混搭时启动或请求 fail closed。
- Passkey 只能凭十分钟内、一次性、`method = github_oauth_identity`、`purpose = passkey_registration` 的 owner action proof 登记；该方法只确认固定 GitHub owner，不声称最近十分钟内重新验证了 GitHub credential。`method = passkey_uv`、普通 Passkey session 或原生 Bearer 都不能新增 Passkey。OAuth pending nonce 送入 Passkey handler、Passkey challenge 送入 OAuth callback，或签发 handler 派生的 `actualVerifierMethod` 与 pending method 不一致时，proof 必须保持 pending 且零认证状态写入。两个并发 options/verification ceremony 通过唯一 `ceremonyId` 的原子 bind/consume 最多产生一个 credential，plugin 失败也消费 proof。registration 与 authentication 的 UV=false fixture 都在 credential/session 写入前失败且零写入，只有服务器确认 `userVerified=true` 才成功。每个已创建环境分别使用第 5.2 节对应的 origin/RP ID 完成 registration 与 authentication；local 的 `localhost` 成功，`127.0.0.1`、production RP ID 和任意跨环境组合在写 credential/session 前失败。非 owner、无 session、proof/challenge 重放和已删除 credential 全部失败；owner allowlist subject 变更或 mapping 失效后，旧 subject 的已有 Passkey 也必须在写 session 前失败且零 session。OAuth 仍可恢复登录并重新登记 Passkey。
- 五个原生平台使用系统浏览器完成 Device Authorization；client ID 唯一确定环境与平台，审批页不伪造设备名。approval context 只能由服务端把 `user_code` 解析为 attempt 后创建，OAuth state/Passkey challenge 只能引用该 context 的 opaque nonce，callback 只能回到固定批准路由；伪造 target、return URL、跨 owner context、callback session 轮换、context 重放和 OAuth/Passkey verifier 交叉使用都不能改变 proof/code/attempt。无 Cookie 浏览器输入有效 `user_code` 后能够创建唯一 pending context，完成 GitHub OAuth，回到同一批准页并取得绑定新 session 的 proof；无效或跨 owner callback 零状态变更。approve 只能消费当前 owner session、十分钟内、一次性、阶段允许的 method、`purpose = device_authorization_approval` 且 target 匹配当前 attempt 的 action proof；其中 `github_oauth_identity` 只确认 owner 身份，`passkey_uv` 才是近期强认证。批准浏览器 session 可以尚未绑定同步设备。缺失、过期、已消费、错误 method/session/purpose/target 均不能取得首条 claim，也不能改变 proof/code/attempt；依赖 proof consume 意外为零时断言 trigger 回滚全 batch，重新完成 GitHub owner 身份确认或 UV Passkey 后才能继续原批准。无效 client ID、过期/二次批准、过快轮询、拒绝和响应丢失符合 RFC 错误语义；同一来源多个按五秒 interval 轮询的客户端触发 WAF 或 binding 429 时，code/attempt/session 行均不变化，客户端遵守 `Retry-After` 或十秒 fallback 后仍在原 expiry 内收敛。code issue、approve、deny、token consume/session mint、首次绑定与 logout/revoke 经受审 wrapper、attempt lineage 和 generation 仲裁。approve、deny、token 与 bind 各自注入两个完成相同预读的并发请求时，只允许一个首条 claim 命中；loser 的后续 DML 全为零，前后表快照一致。winner claim 后分别注入 proof 消费、code 更新、session 插入、device 或 mapping 插入零行，最终断言 trigger 必须抛错并回滚 claim、proof、code、session、device 和 mapping；不能只是不交付 token。code 批准后若 owner allowlist subject 或 Hako mapping 发生变化，后续 token poll 必须在 consume/session mint 前失败，且零 session、零 access token；任一有效 session logout 或同账户设备撤销会推进 generation，旧 pending/approved code 都按 `invalid_grant` 失效。并发故障注入还覆盖：撤销先于 approve；approve 先于撤销；token 已取得 consume 权但尚未写 session 时撤销；token batch 先提交、尚未绑定时撤销；bind 与撤销并发。每种交错在撤销提交后都不得留下可用的未绑定派生 session/token，已绑定且未被指定撤销的其他设备仍有效；每个已结束请求的 claim 字段为空。秘密 `device_code` 与 access token 从不返回 Vue/WebView，后者也不写入非 Stronghold store。
- Web Cookie 与原生 Bearer 都归一为相同 `AuthenticatedPrincipal`，其 `applicationId` 恒为服务端配置的 `hako`，`accountId` 恒为预置 owner account anchor；伪造这两个字段、未绑定、已撤销或跨环境 device 都不能同步。重新登录不改变既有 mutation ID、outbox 或本地业务数据。
- 同一 installation 并发绑定不重复创建设备，active device 上限 16；同一 session 只能映射一个 device，重复绑定其他 installation 返回 `session_device_mismatch`，自然 session 过期不留下 orphan mapping。未绑定 Web session 以服务端验证的 session ID 作为限流键列出并撤销一台已有设备后，只在该 session 仍权威有效时直接重试；未绑定原生 Device Authorization session 完成同一撤销后必须已随 generation 失效，旧 bearer bind 为 401，删除该 bearer、重新授权后才能绑定。旧 session 携 `confirmRebind=true` 仍得到零写入的 `device_rebind_confirmation_required`；只有重新认证产生的新 session、再次明确确认后才创建新 `deviceId`。撤销设备与其 session/mapping 同批提交，旧 session 不能复活设备；撤销前已认证的在途请求按第 6.3 节完成。
- logout 在无凭据、凭据已权威确认失效或撤销提交后返回 204；Core 故障或 maintenance 下的不确定结果返回 retryable 503。注入撤销已提交但 204 响应丢失时，Web 和 native 重试都收敛到 204；在 503 下前者不过期 Cookie、后者不删除 Stronghold token。
- 公开认证写入在同一 INSERT 内执行 `deviceCode`/`verification` 的未过期与 retained 行数门禁，并发不能越过固定上限；达到门禁只拒绝新认证状态，不影响既有 session 或模块同步。非 owner OAuth 拒绝按 subject hash 小时桶聚合并受 1024 行子上限保护；`auth_audit` 受 4096 行/90 天 ring 门禁保护，公开拒绝饱和仍保持原拒绝结果，已验证 session 将 ring 填满后，设备撤销与 operator recovery 仍在同一 batch 淘汰最旧低优先级事件、完成状态变更并留下最新审计。Passkey registration verification 在调用 plugin 前从 WebAuthn response 取得精确 credential ID 并写唯一 audit intent，delete 使用已存在 ID；同一 credential 的并发 delete/retry 只有一个 unresolved intent 可以调用 plugin。在已有多个 credential、同目标并发 delete 和各崩溃点下，补偿任务仍只对目标 ID 的真实状态变化按 operation ID 恰好一次收敛，无法裁决时保留 intent、告警并暂停新 Passkey 变更。hourly cleanup 每轮不超过 500 行、每条 DML 不超过 100 行，永不再轮询的 device code 也会被回收；失败不执行无界补偿且不阻塞正常认证，普通 auth request 的 rows written 不随过期 backlog 线性增长，超龄积压、审计淘汰与 70% 容量均产生告警。
- `DeadlineCheckedD1` conformance 覆盖锁定 Better Auth 与 Workers 类型实际使用的全部终端方法；旧 OAuth callback 暂停在 GitHub fetch、Passkey 暂停在 plugin DML 前、scheduled cleanup 暂停在分页间、`waitUntil(lastSeenAt)` 延迟执行时，入口后 20 秒恢复都不得再发起 D1。Core 进入 `deny_all` 后，只有单一 maintenance version 100% 生效并等待至少 50 秒，才能 export、Time Travel 或应用 migration；49.999 秒时仍禁止操作。恢复窗口注入的新 Cron 在 D1 前 no-op，旧 invocation 也不能留下 user/account/session/mapping/credential/audit 写入。
- operator recovery 的 `RecoveryEdgeGate → deny_all → owner_recovery → 最终 deny_all/50 秒冻结 → normal → 删除 edge gate` 顺序、隔离 identity、固定 account ID 的 INSERT/CAS、失败保持维护和成功后无第二个 Hako account 均有演练测试。把一个 recovery OAuth callback 暂停在首次 D1 前、另一个 Passkey verification 暂停在下一次 D1 前；最终冻结恢复二者后，D1 RPC spy 必须为零，最终 Core 核验后也不能新增 session、credential 或 audit intent。先把 `verification` 填到 512 未过期/2048 retained 门禁，再证明非 operator 来源在 Worker 前被阻断、operator 清理后仍能完成 OAuth；预置一个 IP Access `Allow` 或前置 custom `Skip` 时 preflight 必须先检测并停在 `deny_all`，临时移除后才可继续，结束时按快照恢复。WAF 未生效、operator IP 变化或 probe 不一致时同样不能离开 `deny_all`。新旧 subject 使用同一 provider email 时仍可创建隔离 identity；A→B→A 演练必须证明第一次恢复在 mapping CAS 前删除 A 的全部 Passkey，第二次恢复删除 B 并确认 A 仍为零，旧 A credential 写 session 为零。subject recovery CAS 必须同时更新 `provider_subject` 与 `auth_user_id`，并保持 account ID/application/provider 不变；任一字段与旧/新 manifest 不一致都维持 `deny_all`。分别覆盖 mapping 精确存在、因恢复点早于 account anchor seed 而完全缺失、错误 account ID 和多行四种状态：前两种恢复到 manifest 的同一 account ID，后两种保持 `deny_all` 且模块 D1 零写入。旧 manifest subject、新 manifest subject 与 Worker allowlist 任一混搭时启动或请求必须 fail closed；只有当前已批准 manifest 能产生 allowlist。`CORE_DB` 单独回档、`FUEL_DB` 不变时，`verify-recovery-module-read` 必须以 stable account ID 只读验证既有 Fuel entity/change/receipt/cursor，重新 OAuth 后仍能访问它们。
- `CORE_DB` 失败时不写模块库；模块库失败时设备管理仍可用。
- 两个请求都预读不到同一 receipt 后并发提交：同 ID/同 hash 只有一个业务效果，loser 返回 replay；同 ID/不同 hash 且写不同实体时也只有 winner 有效果，loser 返回 `idempotency_key_reused`，不能出现 500/503。
- 一批 mutation 的成功结果与请求等长同序，每项 `mutationId` 精确关联原 intent；冲突或拒绝不回滚其他成功项，且每项均可安全重试。
- 一批 mutation 处理到中途返回请求级 503 时，重试通过 receipt 重放已提交项并继续未处理项。
- 请求校验顺序、路径/body module key、非法版本语法、unsupported/尚未 accepted 版本、wire codec 错误和业务 rejected 分别得到规定结果，所有请求级失败都零写入。
- 每个已发布 schema version 的 canonicalizer golden fixtures 跨客户端与 Worker 产生相同 SHA-256；unsafe integer、浮点数和非规范 revision 字符串在写入前拒绝。
- delete 后使用相同 entity ID create 返回带 tombstone 的 conflict，不触发请求级 500。
- 空数据库 bootstrap 返回 epoch 和 seq 0 cursor；伪造 cursor、account 不匹配、epoch 不匹配和分页恢复均不跳过 change。省略、`0`、负数、超上限和非法 `limit` 覆盖默认值与错误边界。轮换 MAC key 后模块 cursor 进入 recovery。
- 数量上限和 1 MiB 字节预算分别截断 pull 时 `hasMore` 与 `nextCursor` 正确；存在后续 change 时不返回空页。
- push/pull 响应丢失、超过 200 条分页、并发写入和客户端时钟偏移后最终收敛。Fuel 的 5 条普通 mutation，以及单条包含 1000 个子记录的 vehicle delete，必须记录当前套餐下的 D1 query、rows read/written、CPU、内存和响应预算；不满足 Free 时升级并在 Paid 重测，不能减少事务保护，也不要求仅为采集对照数据而升级。
- bridge Worker 部署前后和 metadata 激活前后都能提供服务；active 不在 required、历史 change/receipt 版本未被 required 覆盖或任一集合超出 Worker supported 集合时，该模块以 503 fail closed 且零写入、零推进 cursor。
- bridge 只接受 v1 时提前提交 v2 得到带 `Retry-After: 300` 的 409 `module_version_not_accepted`。只有跨版本 golden fixtures 证明 v2 权威实体经 v1 change codec 往返后语义无损，才允许 accepted 先加入 v2 并继续写 v1 change；不能无损时，accepted、active 和 required 在兼容客户端发布后的同一个 maintenance 事务中切换。
- v2 激活后，能读 v1/v2 的新客户端重放 stale v1 mutation 时取得标记为 v2 的 conflict snapshot，随后重试仍得到首次 receipt；只能读 v1 的旧客户端在 push 前收到规定的 426。
- 一个请求已经读取并固定旧 metadata snapshot 时，另一请求激活 v2：前者只写入或返回 v1，激活后开始的旧客户端请求得到 426；任何 pull page 都不能混入其 metadata snapshot 未声明的版本。
- 进入 maintenance 时，已经预检但尚未提交的旧 mutation 因 write fence 变化而零写入；数据库外 `forcedModuleMaintenanceKeys` 的单一 version 全量生效并等待 50 秒后，暂停旧请求才不得再调用目标 D1。把 D1 回档到 `maintenance=false`/旧 fence 的 bookmark 也不能绕过外部门禁；从 restore 到新 epoch/fence/`maintenance=true` 重建之间，目标模块始终返回 retryable 503 且零目标 D1 调用，其他模块与 Core 保持服务。active deployment 含 0% old normal version、`preview_urls=true`、错误 Host、未知或重复 module key 任一情况都使恢复 preflight 失败；49.999 秒时仍禁止回档，达到 50 秒后才允许。恢复后旧 epoch/write fence 请求也无法写入；Access 只读探针必须同时通过 hostname、version、manifest、epoch 和 write fence 校验，且不能产生业务、cursor 或 Core 写入。
- Core 与业务 D1 导出只在各自 50 秒 maintenance barrier 后开始；导出完成后业务数据和未恢复模块 epoch 不变。
- Fuel D1 恢复到 v2 激活前的 bookmark 时，从外部 activation manifest 恢复批准的版本集合并轮换 Fuel epoch；Core D1 回档后全部旧 session、Bearer、device code 和 Passkey 失效。
- Core 回档重放 migrations 后，全部旧 session、device code、verification、Passkey 和 sync device 均失效；数据库外 maintenance 在同 subject 重新认证或 subject 变更的 CAS 恢复、新 Passkey/设备验证完成前持续生效。Better Auth secret 泄露演练还必须证明旧 key version 完全移除、旧 provider token ciphertext 已清空，现有 provider account 仍能重新 OAuth 登录并只写新 version 密文，Passkey/Device Authorization 恢复不依赖旧 key。
- 首次 production bootstrap 在公开认证前预置唯一 account anchor，再由 allowlist owner 完成一次 OAuth 绑定、GitHub owner 身份确认、明确批准设备和首设备绑定；阶段二首次启用时再登记首个 Passkey。之后的 production 发布 smoke 只使用现有 owner session 执行认证只读接口和 pull，不执行 operator recovery；完整 OAuth/Passkey/Device Authorization 写路径由 local/preview 覆盖。
- Worker 当前版本和指定 bridge 回滚版本都能读取 expand 阶段 schema，支持全部 active、accepted 和 required payload 版本；rollback 不要求 down migration。

实施后至少通过：

```text
pnpm test:server
pnpm exec wrangler d1 migrations apply hako-core --local --config server/wrangler.jsonc
pnpm exec wrangler d1 migrations apply hako-fuel --local --config server/wrangler.jsonc
pnpm exec wrangler deploy --dry-run --config server/wrangler.jsonc
```

## 15. 回滚与最脆弱假设

- Worker 回滚只能回到兼容当前 Better Auth/Core schema、模块 D1 schema、active/accepted/required 集合和当前 secrets 的版本；数据库默认向前修复，不自动 down migration。
- 单个模块可从 registry 隐藏并关闭路由，保留该模块 D1、receipt 和 change。
- 服务端完全不可用时不改变任何 D1 状态；客户端的离线与恢复行为以[客户端回滚规则](./hako-client-foundation.md#14-回滚与最脆弱假设)为准。

本方案最脆弱的实现假设是 Better Auth 的 D1、Passkey 和 Device Authorization 插件在锁定版本上能同时满足 Workers runtime 与六端系统浏览器流程；它没有官方 Tauri adapter，因此阶段一、二必须以真实五原生平台 conformance 结果作为继续投入同步的门禁。失败时优先替换认证 adapter 或改用托管身份服务，不改同步协议和模块数据。

本方案最脆弱的安全假设仍是允许设备/session 撤销前已通过认证的在途请求完成。若以后要求撤销提交后连在途写入也不能成功，需要 Durable Object 或重新合并授权守卫与业务写入的事务边界；首版不承担这项复杂度。

容量方面的最脆弱假设是个人数据增长速度足以让人工导出和 70% 告警在 D1 满前留出 compaction 设计时间；上线后必须用实际 rows written、数据库大小和导出演练验证，不能把“首版不清理”当作无限容量。

Free-first 还明确接受一项远端可用性风险：zone WAF 与应用限流都不能阻止分布式低速匿名请求消耗每天 100,000 次 Worker invocation，额度耗尽后远端认证与同步会 fail closed 到下次 UTC 重置或套餐升级，但本地离线数据不受影响。第 11 节的 50%/75% 门槛、临时 WAF 收紧和升级 Paid 是首版处置路径；若不能接受这段人工响应窗口，应在公开认证前直接使用 Workers Paid。

GitHub OAuth callback 只能确认当前浏览器会话对应固定 owner subject，不能证明密码、2FA、Passkey 或其他 credential 在最近十分钟内重新验证。GitHub OAuth App 没有可供 Hako 校验的 `max_age` 或 `auth_time`，GitHub sudo mode 也可能复用已有认证状态。因此 `github_oauth_identity` 只作为个人版 bootstrap 与敏感动作的身份确认 fallback，不抵抗已解锁 owner 浏览器或 Hako origin 已被控制的场景；阶段二可以改用 `passkey_uv` 获得近期强认证。若以后要求抵抗这类浏览器会话接管，必须停用该 fallback，并单独设计强认证与恢复流程。

## 16. 参考资料

- [Cloudflare Workers Hono](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/)
- [Better Auth Hono 集成](https://better-auth.com/docs/integrations/hono)
- [Better Auth Cloudflare D1](https://better-auth.com/blog/1-5)
- [Better Auth 数据库与 migration](https://better-auth.com/docs/concepts/database)
- [Better Auth OAuth](https://better-auth.com/docs/concepts/oauth)
- [Better Auth GitHub provider](https://better-auth.com/docs/authentication/github)
- [Better Auth Passkey](https://better-auth.com/docs/plugins/passkey)
- [Better Auth Device Authorization](https://better-auth.com/docs/plugins/device-authorization)
- [Better Auth Bearer](https://better-auth.com/docs/plugins/bearer)
- [Better Auth 安全基线](https://better-auth.com/docs/reference/security)
- [Better Auth 配置选项](https://better-auth.com/docs/reference/options)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [GitHub OAuth App 注册](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- [GitHub OAuth App 授权流程](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [GitHub durable user ID](https://docs.github.com/en/rest/users/users#get-a-user-using-their-id)
- [GitHub sudo mode](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/sudo-mode)
- [Cloudflare Workers Static Assets SPA](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Cloudflare Workers 静态资源 bindings](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Cloudflare Workers 静态资源 headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Cloudflare Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cloudflare WAF Rate Limiting Rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)
- [Cloudflare WAF Custom Rules](https://developers.cloudflare.com/waf/custom-rules/)
- [Cloudflare Ruleset phases](https://developers.cloudflare.com/ruleset-engine/reference/phases-list/)
- [Cloudflare Workers Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers Scheduler](https://developers.cloudflare.com/workers/runtime-apis/scheduler/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)
- [Cloudflare Workers version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/)
- [Cloudflare Workers preview URLs](https://developers.cloudflare.com/workers/configuration/previews/)
- [Cloudflare Workers bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
- [Cloudflare Workers routes 与 custom domains](https://developers.cloudflare.com/workers/configuration/routing/)
- [Cloudflare Workers `workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Cloudflare Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Wrangler 多 D1 bindings](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [SQLite `UPDATE` 的零行语义](https://www.sqlite.org/lang_update.html)
- [SQLite trigger `RAISE()`](https://www.sqlite.org/lang_createtrigger.html#the_raise_function)
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Cloudflare D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Cloudflare China Network](https://developers.cloudflare.com/china-network/)
- [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- [RFC 8628 OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628)
- [Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)
