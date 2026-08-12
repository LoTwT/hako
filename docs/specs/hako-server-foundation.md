# 临时规格：Hako 服务端共享基建

> 状态：待确认
>
> 创建日期：2026-08-10
>
> 适用版本：Hako 首个自动同步版本
>
> 单一事实来源：本文定义 HTTP、设备认证、通用同步协议、Cloudflare Worker、D1 边界和服务端运维；客户端行为由[客户端共享基建规格](./hako-client-foundation.md)定义，模块 payload 和业务约束由各模块规格定义。
>
> 临时性：属于同一临时规格组，统一清理门禁见[文档索引](../index.md#临时规格)。

## 1. 决策：需要独立服务端

自动同步需要一个永远不信任客户端时间、能够验证设备、仲裁 revision、保存幂等回执和提供增量日志的权威节点，因此必须有服务端。客户端不得直接持有 D1 管理凭据或绕过业务校验访问数据库。

首版选择：

- Cloudflare Worker 就是 Hako 的独立服务端部署单元。
- Web SPA 和 `/api/v1` 由同一个 Worker、同一个 origin 提供。
- 服务端代码位于当前仓库的 `server/`，作为独立 pnpm workspace package，拥有自己的 `package.json`、TypeScript 配置、Wrangler 配置、构建验证和发布流程；整个仓库只维护根目录的一份 pnpm lockfile。
- 首版只有一个 Worker；认证和模块同步通过内部代码边界隔离，不拆成多个 Worker 或独立仓库。
- 身份认证使用独立 Core D1；首个同步模块 Fuel 使用独立业务 D1。后续按事务与恢复边界决定是否新增 D1，不按模块名称机械分库；必须原子提交的跨模块数据必须位于同一业务 D1 或重新设计边界。第 7 至 9 节首版假定一个业务 D1 只承载一个同步恢复域；多个模块共享物理 D1 前，必须另写 D1 级 maintenance、全部受影响模块 epoch 轮换和联合 reconciliation 规格，在此之前禁止共享。

一个 Worker 已能绑定多个 D1，并能只让 `/api` 与 `/api/*` 先进入 Worker、其余请求直接走静态资源。拆分仓库不会形成运行时安全边界，拆多个 Worker 则会增加部署顺序和契约漂移；只有未来出现独立团队、独立发布节奏或不可信模块时，才考虑使用 Service Binding 拆服务。

## 2. 范围

### 2.1 包含

- Web SPA 静态托管、SPA fallback 和 `/api/v1` 路由。
- 单用户个人工作区的设备注册、配对、列出、撤销和 Web 会话退出。
- Core D1 与首个业务 D1 的物理隔离、migrations、导出和 Time Travel 流程。
- 模块化 push/pull 协议、revision、cursor、epoch、幂等回执和错误信封。
- 编译期服务端模块注册表及模块 handler 最小权限。
- production、preview 和 local 环境隔离。
- 安全响应头、Origin 校验、credential 摘要、日志脱敏和故障降级。

### 2.2 不包含

- 公开注册、多账号、共享工作区、角色权限、OAuth、邮箱或短信登录。
- 客户端 SQLite/IndexedDB、outbox 调度、Stronghold 解锁和页面实现。
- WebSocket、实时订阅、CRDT、后台推送或服务端主动唤醒客户端。
- 端到端加密；Cloudflare 和服务维护者可以读取同步的业务数据。
- 每个模块一个 Worker、独立 Git 仓库、Durable Objects、Queues 或 R2 自动备份。
- 跨 D1 事务或“撤销完成后连已通过认证的在途请求也不能提交”的强撤销语义。
- D1 读副本和中国大陆 Cloudflare China Network 企业接入。

## 3. 总体架构

```text
Web SPA / 五个 Tauri 原生平台
                 │
          HTTPS / 同源 Cookie
                 │
       Hako Worker（一个部署单元）
       ├─ Static Assets：Web SPA
       └─ Hono `/api/v1`
          ├─ Auth middleware ─────────> CORE_DB
          ├─ Device routes ───────────> CORE_DB
          └─ SyncRuntime
             ├─ cursor codec ─────────> HAKO_CURSOR_MAC_KEY
             └─ Module registry
                └─ FuelSyncHandler ───> FUEL_DB
```

约束：

- 入口层是完整 Worker `env` 的唯一持有者；它通过编译期 registry 把 `moduleKey` 解析为模块 descriptor 和直接的 D1 binding，不允许请求值索引任意 `env` 属性。
- `server/src/core/sync/` 的通用 `SyncRuntime` 接收不可变 `AuthenticatedDeviceContext`、目标业务 D1，以及入口层用 `HAKO_CURSOR_MAC_KEY` 构造的 cursor 签发与验证 capability。它唯一负责第 7、8 节的 transport、metadata、epoch、cursor、receipt、push 顺序和 pull 信封。
- 模块 handler 只提供版本化 codec、canonicalizer、业务 validator 和领域 DML 计划。它可以使用自己的业务 D1，但不接收完整 Worker `env`、MAC key、`CORE_DB`、credential 原文或其他 binding。
- `SyncRuntime` 组装每条 mutation 的最终 D1 batch，并检查通用与模块 DML 的 affected rows；模块 handler 不能自行提交 batch 或写 `mutation_receipts`。
- `originDeviceId` 只作为模块数据库中的审计值，不建立跨 D1 外键。
- 模块加载阶段不得访问数据库、发网络请求或执行可能使整个 Worker 启动失败的初始化。

## 4. 服务端技术栈与部署边界

- TypeScript Cloudflare Module Worker。
- Hono 负责路由、中间件和类型化请求上下文。
- Zod 与 `@hono/zod-validator` 负责请求边界校验；服务端不信任客户端生成的 TypeScript 类型。
- Wrangler 负责本地运行、bindings、migrations、类型生成、dry-run 和部署。
- `@cloudflare/vitest-pool-workers` 在 Workers runtime 中运行集成测试。
- 根 `pnpm-workspace.yaml` 管理客户端与 `server/` package，整个仓库只维护根 `pnpm-lock.yaml`。`server/` 独立声明依赖和 scripts，不创建第二份 lockfile、使用其他包管理器或拆成独立仓库。

共享传输信封放在根目录 `shared/sync/`，是客户端和服务端唯一的 TypeScript 契约实现。模块 wire schema 放在 `shared/modules/<moduleKey>/`，由对应模块规格拥有；客户端和服务端都不得复制常量或字段表。`shared/` 只能依赖与平台无关的 TypeScript 代码，不得导入浏览器、Vue、Tauri、Workers runtime、D1 或 Node.js 专用 API。

## 5. 环境与 Cloudflare 资源

### 5.1 固定资源

| 环境 | Worker | Core binding | 模块 binding |
| --- | --- | --- | --- |
| production | `hako` | `CORE_DB` → `hako-core` | `FUEL_DB` → `hako-fuel` |
| preview | `hako-preview` | `CORE_DB` → `hako-core-preview` | `FUEL_DB` → `hako-fuel-preview` |
| local | Wrangler local runtime | 本地模拟 `CORE_DB` | 本地模拟 `FUEL_DB` |

- production 和 preview 的 database ID、恢复密钥、credential pepper、认证 secret generation 与 cursor MAC key 必须完全不同。
- 两个 binding 分别配置 `server/migrations/core` 和 `server/migrations/fuel`。
- 新数据库创建时使用 `apac` location hint；该 hint 不保证具体物理位置。
- `compatibility_date` 首次固定为 `2026-08-10`，以后按有验证的升级变更更新，不使用隐式最新行为。
- 首版不启用 D1 read replication，也不使用 `withSession("first-unconstrained")`；以后启用时必须先补充 session bookmark 和一致性规格。

### 5.2 静态资源路由

Wrangler 从 `dist/web` 部署静态资源：

- `assets.not_found_handling` 使用 `single-page-application`。
- `assets.run_worker_first` 固定为 `['/api', '/api/*']`，API 无论是否带浏览器导航 header 都必须进入 Worker；命中静态文件的其他请求直接读取资源，非 API miss 再由 Worker 交给 `ASSETS.fetch()` 和 SPA fallback。
- 静态 hashed assets 不经过应用代码；API、认证和同步响应全部 `Cache-Control: no-store`。
- Web 构建必须把 `public/_headers` 复制到 `dist/web/_headers`，由 Static Assets 为 HTML 和 SPA fallback 设置 CSP、HSTS、frame 防护、`nosniff` 和 Referrer Policy；这些请求不经过 Worker 代码，不能依赖 Hono middleware 补 header。
- Web SPA 与 API 同源，不开放宽泛 CORS。原生客户端使用固定 HTTPS origin。

production origin 在首个稳定原生版本发布后视为持久协议标识，因为它同时决定 Web Cookie、IndexedDB 和原生构建期服务端地址。开发和 preview 可以使用 `workers.dev`；production 应使用自有域名。若首版仍选择 `workers.dev`，该 origin 在本规格内继续作为 canonical origin，不能以“更换部署位置”为由直接撤下或设置 `workers_dev=false`。改用自有域名必须先另写 origin migration 规格，明确旧 Web 数据、Cookie、原生固定地址和兼容入口的迁移及退出门禁。

### 5.3 粗粒度限流

Wrangler 配置三个 Workers Rate Limiting bindings，production 与 preview 使用不同 namespace，local 使用确定性 fake：

- `UNTRUSTED_API_RATE_LIMITER`：同一 `route class + source network key` 每 60 秒最多 60 次，用于 health 以外的全部 `/api/*` 路由，在认证或读取 D1 前执行，阻止随机无效 Bearer 绕过设备限流。
- `PUBLIC_AUTH_RATE_LIMITER`：同一 `route class + source network key` 每 60 秒最多 10 次，额外用于 register 和 pair，在读取 D1 或校验 secret 前执行。
- `DEVICE_API_RATE_LIMITER`：同一 `deviceId + route class` 每 60 秒最多 120 次，用于创建 pairing token、设备管理和各模块 push/pull，在认证成功后执行。

source network key 只从 Cloudflare 提供的可信客户端地址构造：IPv4 归一到 `/24`、IPv6 归一到 `/56`，再对固定 domain separator 与规范网络地址计算 SHA-256；摘要在不同 isolate 间稳定，但不写入应用日志。health 返回常量且不读取 D1，只依赖 Cloudflare 边缘 DDoS 防护，不占用应用限流 binding。

binding 拒绝时返回 429 `rate_limited` 与 `Retry-After: 60`；binding 自身不可用时 fail open，并记录不含凭据和原始网络标识的指标。Workers Rate Limiting 的计数按 Cloudflare location 隔离且是宽松计数，只用于控制滥用和成本，不能承载身份安全不变量；配对 token 的五次失败与数量上限仍由 Core D1 事务精确执行。第 6.2 节的 token 数量门禁失败也返回 429 `rate_limited`，但固定使用 `Retry-After: 3600`，不受 binding fail-open 影响。

## 6. 身份认证与设备管理

Hako 服务端是单租户、单个人工作区；客户端不得提交或选择 `accountId`。

### 6.1 API

设备摘要固定为 `{ id, name, platform, createdAt, lastSeenAt, revokedAt, isCurrent }`，其中 `platform` 只能是 `windows`、`macos`、`linux`、`ios`、`android` 或 `web`；名称去除首尾空白后为 1 至 80 个字符。所有 secret 只通过 HTTPS 请求体、响应体、Cookie 或 Authorization header 传输，不放入 URL。

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /api/v1/devices/register` | `{ recoveryKey, deviceName, platform, credentialDelivery }` | 201；按第 6.2 节 bootstrap 或 recovery reset，并一次性交付 credential |
| `POST /api/v1/pairing-tokens` | 设备 credential；空 JSON | 201 `{ pairingToken, expiresAt }`，token 只返回一次 |
| `POST /api/v1/devices/pair` | `{ pairingToken, deviceName, platform, credentialDelivery }` | 201；原子消费 token，返回设备摘要及一次 credential 交付 |
| `GET /api/v1/devices?limit=50[&after=<opaque-cursor>]` | 设备 credential | 200 `{ devices, nextCursor, hasMore }`，包含 active 与保留期内的 revoked 设备但不含 secret |
| `DELETE /api/v1/devices/:deviceId[?confirmLastActive=true]` | 设备 credential | 204；幂等撤销并失效目标设备创建的未消费 pairing token，未知 ID 返回 404 |
| `GET /api/v1/session` | Web Cookie | 200 `{ device: DeviceSummary }`；无效会话返回 401 |
| `POST /api/v1/session/logout` | Web Cookie（允许缺失、可判定无效或已撤销） | 204；幂等过期 Cookie，当前 Web 设备仍 active 时同时撤销设备并失效其未消费 token；无法确认服务端状态时按下文返回 503 |
| `GET /api/v1/health` | 无 | 200 `{ status: "ok" }`，不查询 D1 或泄露版本、bindings |

`credentialDelivery` 只有两种合法组合：

- Web 必须使用 `cookie`、`platform=web` 且请求 `Origin` 精确匹配部署 origin；响应只设置 HttpOnly Cookie，JSON 不含 credential。
- 原生必须使用 `body`、非 Web platform 且请求不带浏览器 `Origin`；JSON 额外返回一次 `credential`。带 `Origin` 的请求永远不能取得 body credential。

register/pair 的设备创建可能先于响应交付完成，服务端不保存可重放的 credential 原文，也不提供重放一次性交付响应的接口。Web session 可以判断 Cookie 是否已经生效；其余客户端恢复行为由[客户端 credential 生命周期](./hako-client-foundation.md#9-全局身份与凭据)维护。

logout 必须先校验 Web `Origin`，再处理 Cookie。Cookie 缺失或格式非法时不读取 D1，直接过期 `__Host-hako_device` 并返回 204。格式合法时，只有成功读取 Core D1 并查明设备不存在、已撤销或 credential 不匹配，或者 active device 的撤销事务已经提交，才能过期 Cookie 并返回 204；各状态对外不可区分。Core D1 不可用、generation/mode guard 失效或设备状态无法确认时返回相应 retryable 503，且不得过期 Cookie。这样撤销已经提交但响应丢失的重试仍能清除 HttpOnly Cookie，也不会在服务端撤销未提交时丢失唯一可重试凭据。

register、pair 和设备管理请求体最多 16 KiB，超限时必须在 JSON 解析和 secret 校验前返回 413。设备列表 `limit` 默认为 50，只接受 1 至 100 的十进制整数。每个设备插入时由 Core D1 分配不对外暴露、不可变且在同一 generation 内严格递增的 `listSequence`；第一页在同一个只读 batch 中固定当前 generation、`snapshotMaxListSequence` 和服务端 `snapshotAt`，后续页只读取 `listSequence <= snapshotMaxListSequence` 且在 `snapshotAt` 尚处于保留期内的成员，并按 `listSequence` 递增。列表 cursor 对 `{ generation, snapshotMaxListSequence, afterListSequence, snapshotAt, expiresAt }` 使用第 10 节的 MAC key 和独立 domain separator 签名，有效期十分钟；新设备留给下一次完整分页，不插入当前快照。客户端视 cursor 为不透明字符串，generation、期限、字段、编码或 MAC 无效时返回 400 `invalid_request` 并从第一页重试。

除上文幂等 logout 外，认证 API 使用第 7.4 节的错误信封：`invalid_request` 为 400/422，`request_too_large` 为 413，`invalid_recovery_key`、`invalid_credential` 和 `invalid_pairing_token` 为 401，`device_not_found` 为 404，`last_active_device_confirmation_required` 和 `device_limit_reached` 为 409，`rate_limited` 为 429，`auth_maintenance` 与 `database_unavailable` 为 503。两个 503 都是 `retryable=true` 并提供 `Retry-After`。过期、已消费、错误或尝试次数耗尽的配对 token 都返回同一个 `invalid_pairing_token`，响应不能用于枚举内部状态。

### 6.2 恢复密钥与 credential

- 部署时生成 32 个密码学安全随机字节，编码为 `hako_r_` 前缀 base64url 恢复密钥，由用户离线保存。
- Worker secret `HAKO_RECOVERY_KEY_SHA256` 只保存恢复密钥的 SHA-256 十六进制摘要；不得让第一次公开请求决定恢复密钥。
- register 不是普通的“增加设备”接口。没有 active device 时，它 bootstrap 首台设备；已有 active device 时，合法 register 必须在一个 Core D1 事务中撤销全部 active device、失效全部未消费 pairing token、写 `recovery_reset` 审计并创建唯一的新设备。正常增加设备只能使用 pair。
- 每台设备获得 `hako_d_<deviceId>.<secret>` credential；device ID 是 UUID v4，secret 至少 32 个随机字节，只返回一次。
- Worker secret `HAKO_CREDENTIAL_PEPPER` 至少 32 个随机字节；D1 只保存 credential 和配对 secret 的 HMAC-SHA-256，不保存 bearer 原文。
- credential 与配对 token 的 HMAC 使用同一 pepper 但加入不同的固定 domain separator，避免不同凭据类型复用摘要。
- credential、恢复密钥和配对 token 比较使用固定时长的字节比较，错误响应不得泄露是哪一部分不匹配。
- 已授权设备生成 `hako_p_<pairingId>.<secret>`；pairing ID 是 UUID v4，secret 至少 16 个随机字节，十分钟过期、单次使用，每个 pairing ID 最多五次错误兑换，并保存创建设备 ID。token 创建事务必须使用条件插入同时断言：该创建设备未撤销、未消费且未失效的未过期 token 少于 5 条、该设备尚未物理清理的 token 行少于 128 条、Core D1 尚未物理清理的 token 行少于 2048 条；任一条件失败时零写入并按第 5.3 节返回 429。限流 binding、active device 上限或事后清理都不能替代这三个权威门禁。
- active device 上限固定为 16。配对兑换的一个 `CORE_DB.batch()` 必须以随机 request nonce 条件更新 token；该条件同时要求创建设备仍未撤销且 active device 少于上限，再用 `INSERT ... SELECT` 只在 token 被同一 nonce 成功消费时创建设备。错误 secret 的失败次数也在同批条件更新。以 device insert 的 affected row 判断成功，并发兑换最多一个成功。达到上限返回 409 `device_limit_reached` 且不消费 token。设备撤销在同一个 Core D1 事务中失效该设备创建的全部未消费 token；撤销先提交时，随后兑换统一返回 `invalid_pairing_token`。
- `HAKO_AUTH_SECRET_GENERATION` 是随恢复密钥 hash 或 credential pepper 轮换而递增的正整数，并与 `auth_metadata` 中的 generation 精确相等。`auth_metadata.authMode` 只能是 `maintenance`、`recovery_register` 或 `normal`。请求入口固定本次观察到的 generation 和 mode；register、pair、token 创建、撤销、logout 和其他 Core 状态变更的事务必须再次以 generation 未变且当前 mode 允许该操作为条件，条件失效时零写入并返回 503 `auth_maintenance`。不能只在入口比较一次，也不得把 generation 错配伪装成 401。

### 6.3 Web Cookie 与请求校验

- Web 使用 `__Host-hako_device` Cookie：`Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`，不设置 `Domain`。
- 所有 Web 写请求校验 `Origin` 必须等于部署 origin；认证与同步响应使用 `no-store`。
- 原生端使用 `Authorization: Bearer hako_d_<deviceId>.<secret>`，拒绝跨 origin 重定向。
- 请求、错误、访问日志和诊断信息不得包含 Cookie、Authorization、恢复密钥、配对 secret 或完整请求 payload。

### 6.4 Core D1

| 表 | 用途 |
| --- | --- |
| `auth_metadata` | Core schema 版本、认证 secret generation、auth mode 和安全审计 metadata |
| `devices` | ID、内部单调列表序号、名称、平台、credential HMAC、创建/撤销时间、节流后的最近活跃时间 |
| `pairing_tokens` | token HMAC、创建设备 ID、过期/消费/失效时间、失败次数 |
| `auth_audit` | 注册、配对、撤销、恢复和密钥轮换事件，不记录 secret；首版只允许经 Cloudflare 认证的运维工具读取，不提供用户态 HTTP API |

认证中间件成功后只产生 `{ deviceId, deviceName, platform }` 的不可变上下文。仅当 `authMode=normal` 时，任何成功的 credential-authenticated API 请求，包括只读设备 API、空 pull 和 mutation 提交，才会触发 `lastSeenAt` 最多每小时一次的最佳努力更新；更新在主响应之外执行，失败不得改变已经确定的 API 结果。`recovery_register` 下用于确认新 credential 的 session 和设备列表必须保持只读，不更新 `lastSeenAt`。

所有 active device 权限相同，可以撤销自己或其他设备；撤销某个设备不级联撤销由它配对出的已生效设备。撤销事务的条件 DML 必须在 request-fixed generation 仍匹配时，原子检查“目标已撤销，或 `confirmLastActive=true`，或当前 active device 多于一台”；目标已撤销时幂等返回 204，目标仍 active 但已成为最后一台时返回 409 `last_active_device_confirmation_required`。两个设备并发互撤时，未携带确认的后提交者不能把 active 数量降到零。撤销后只能使用恢复密钥重新 bootstrap。Web logout 视为已明确确认的当前设备撤销，可以留下零台 active device。

设备撤销事务提交后开始的认证检查必须失败，目标设备创建但尚未消费的 pairing token 也必须失效；撤销当前 Web 设备时必须同时过期响应 Cookie。在撤销提交前已经完成认证检查的所有在途请求允许完成。跨 `CORE_DB` 与业务 D1 不宣称原子撤销。

恢复密钥是可轮换的 root credential。日常轮换不执行 Time Travel：先用 Core D1 事务把 `authMode` 从 `normal` 改为 `maintenance`，再部署 `HAKO_FORCE_AUTH_MAINTENANCE=true` 的临时强制 maintenance version；确认 100% 流量、客户端 503 和 scheduled handler no-op 后，按第 9 节的 20 秒 D1 调用发起截止时间与至少 50 秒等待完成包含既有 scheduled invocation 的 drain barrier。本地生成并只展示一次新 key，更新 `HAKO_RECOVERY_KEY_SHA256` 和 `HAKO_AUTH_SECRET_GENERATION`，部署将来实际承载正常流量、`HAKO_FORCE_AUTH_MAINTENANCE=false` 的同一个候选 Worker version；它因 D1 仍处于 maintenance 且 generation 尚未匹配而不能开放客户端 API。再以 Core D1 事务写入新 generation 并保持 maintenance，使用第 9 节的只读运维探针验证该候选 version、environment、两侧 generation、新 key 匹配且旧 key 不匹配；全部通过后，只用 Core D1 条件事务把 `authMode` 改为 `normal`，不得重新构建或部署另一个 Worker。不得用 production register 的预期失败执行旧 key 检查，因为配置错误时它会触发 recovery reset。事务内 generation/mode guard 是第二道防线，任何已经通过入口校验的旧请求都不能在轮换后重置设备。怀疑恢复密钥或 pepper 泄露时，还必须撤销全部设备和 token；当前恢复密钥与全部设备 credential 同时丢失时无法恢复。轮换后的 Worker version 成为认证 rollback floor，不能回滚到携带旧 hash、pepper 或 generation 的版本。

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

请求体固定为 `{ transportProtocolVersion, moduleKey, moduleSchemaVersion, readableSchemaVersions, epoch, mutations }`，成功响应固定为 `{ transportProtocolVersion, moduleKey, epoch, results }`。请求体最大 256 KiB，单条规范化 payload 最大 64 KiB，单次最多 50 条 mutation。

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
| `mutationId` | 客户端全局生成 UUID v4，重配对后也不改变；服务端在当前模块内保证幂等 |
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

mutation 首次终态 `applied`、`conflict` 或业务 `rejected` 必须和规范化请求哈希写入 receipt。`mutation_receipts.mutation_id` 是当前模块内的主键。receipt 预读未命中不代表取得执行权；`SyncRuntime` 必须把模块 DML、change 和严格的 receipt `INSERT` 放入同一 batch，禁止对首次 receipt 使用 `INSERT OR IGNORE` 或 `REPLACE`。模块业务写入未命中 guard 时，receipt 条件插入也必须为零，运行时重新读取并重试仲裁。

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

查询固定为 `seq > cursor ORDER BY seq LIMIT`，不得使用 offset。单页编码后的 `changes` 最大 1 MiB；服务端按 `limit + 1` 查询，并在数量或字节预算先到达时停止。单条合法 change 必须能装入该预算，因此写入时已经受第 7.2 节单 payload 上限约束。只要最后实际返回项之后仍有记录，`hasMore=true`；`hasMore=false` 表示该页事务观察到的 seq 高水位内没有后续记录。存在未返回 change 时不得返回空页。

`nextCursor` 只推进到实际返回的最后一项；已有 cursor 的空页保持旧 cursor。push 响应不能推进 pull cursor。

cursor 编码 `{ transportProtocolVersion, moduleKey, epoch, seq }` 并带服务端 MAC，客户端视为不透明字符串，不能伪造或解析。模块数据库 Time Travel、change log 不兼容迁移或日志重建后轮换该模块 epoch；其他模块不受影响。

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
| credential 缺失、无效或撤销 | 401 `invalid_credential`，`retryable=false` |
| JSON 或字段非法 | 400/422 `invalid_request`，`retryable=false` |
| 请求体超过限制 | 413 `request_too_large`，`retryable=false` |
| 模块未部署 | 404 `module_not_found`，`retryable=false` |
| mutation ID 换内容 | push HTTP 200 的逐项 `rejected` |
| push 版本受 Worker 支持但尚未 accepted | 409 `module_version_not_accepted`，`retryable=true`，`Retry-After: 300` |
| push 版本超出 Worker supported 集合 | 409 `module_version_unsupported_by_server`，`retryable=true`，`Retry-After: 300` |
| cursor MAC/字段无效或 epoch 不匹配 | 409 `cursor_reset_required`，`retryable=false` |
| 撤销最后一台设备但未显式确认 | 409 `last_active_device_confirmation_required`，`retryable=false` |
| active device 已达上限 | 409 `device_limit_reached`，`retryable=false` |
| 业务 revision 冲突 | push HTTP 200 的逐项 `conflict` |
| 限速 | 429 `rate_limited`，`retryable=true` 并提供 `Retry-After` |
| Core 处于认证或全局维护窗口 | 503 `auth_maintenance`，`retryable=true` 并提供 `Retry-After` |
| 模块处于维护窗口 | 503 `module_maintenance`，`retryable=true` 并提供 `Retry-After` |
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
| `mutation_receipts` | 以 mutation ID 为主键，保存来源设备、请求哈希、首次终态和完整结果 |
| `changes` | 自增 seq、实体/版本、操作、不可变 snapshot、设备和服务端时间 |
| 模块业务表 | 由模块规格定义 |

通用约束：

- 每次 push/pull 都读取不跨请求缓存的 metadata，校验 registry key 与 metadata key 相等，并执行第 7.1 节的 active/accepted/required 门禁；不兼容只使该模块返回 503，不能阻止 Worker 或其他模块启动。
- `UNIQUE(entity_type, entity_id, revision)`；同一实体版本只有一条 change。
- `changes` 保存当时的完整快照，不能只保存指向当前实体的指针。
- 同一 mutation 的 receipt、实体变化和 change 必须由 `SyncRuntime` 组装到一个该模块 `D1Database.batch()`；任何 statement 失败都回滚整个 sequence。模块计划必须返回每条 DML 的预期 affected rows 和结果解释器，不能只依赖 TypeScript 预读判断成功。
- TypeScript 的预读和纯 validator 只能提供早期错误；涉及多行或跨实体不变量的模块必须在同一 D1 batch 中使用条件 DML、guard revision 或 trigger 作最终仲裁，affected row 不符合预期时整条 mutation 冲突或拒绝。
- revision 只由服务端当前值仲裁，不使用客户端时间；D1 内使用有符号 64 位整数，读出时 `CAST(... AS TEXT)`，create 从 `1` 开始，已接受 update/delete 每次加 `1`，传输层只使用规范十进制字符串。
- tombstone 不能物理删除。首版不自动清理 receipt 和 change log，以保证无限期离线设备仍可重放和 bootstrap；这不是永久兼容承诺。任一业务 D1 达到套餐容量的 70% 前必须暂停新增高写入模块并完成 compaction 规格，compaction 必须提供 snapshot bootstrap、轮换 epoch 并覆盖离线客户端恢复。
- 已消费、失效或过期 pairing token 保留 30 天，revoked device 在设备列表中保留 90 天，相关脱敏 `auth_audit` 保留一年。同一 Worker 的每小时 scheduled handler 使用有界批次清理到期 Core 记录；正常可用性下以到期后 24 小时内删除为 SLO，失败或 maintenance no-op 后在下一小时重试，超过 24 小时仍未删除时告警并要求人工补偿，不能在普通认证请求中执行无界删除。revoked device 的物理删除须额外晚于十分钟列表 cursor 有效期，保证分页快照中的成员在 cursor 到期前仍可读取；清理不得影响模块库中的 `originDeviceId` 审计字符串。scheduled handler 从入口起设置 20 秒 D1 调用发起截止时间，并在每次 D1 调用前检查；`HAKO_FORCE_AUTH_MAINTENANCE=true` 时必须在任何 D1 调用前直接 no-op。Core 全局 maintenance 确认强制 version 承载 100% 流量后仍须等待至少 50 秒，覆盖 20 秒发起窗口与 D1 单次查询或 batch 最长 30 秒，排空此前已启动的 scheduled invocation；临时删除 Cron Trigger 不能替代该数据库外门禁与 drain。
- 模块不能查询 `CORE_DB` 或其他模块 D1，也不能建立跨库外键。

首个模块 `fuel` 的表、实体类型、payload 和业务 validator 由[Fuel 同步接入规格](./fuel-tracking.md#9-fuel-同步接入)唯一维护。

## 9. 故障、回档与安全恢复

| 故障 | 服务端行为 |
| --- | --- |
| `CORE_DB` 不可用 | 需认证 API 返回 503，不写模块 D1 |
| 单个模块 D1 不可用 | 仅该模块路由返回 503；设备管理和其他模块仍可用 |
| 模块 handler 抛错 | 转为脱敏 500，不影响其他路由 |
| Worker 发布故障 | 所有 API 暂停 |

恢复模块 D1：

1. 先在目标 D1 的 metadata 管理事务中设置 `maintenance=true` 并轮换 `writeFence`。第 7.2 节的事务内条件使已经预检但尚未提交的旧请求零写入并返回 503 `module_maintenance`。随后部署 maintenance Worker，使目标模块的新请求返回相同错误和 `Retry-After`，其他模块保持服务。正常 Worker 对每个 API 请求设置从入口起 20 秒的 D1 调用发起截止时间，并在每次 D1 调用前重新检查；截止后不得发起新的 D1 调用。确认完整流量已切换后等待至少 50 秒，覆盖 20 秒发起窗口与 D1 单次查询或 batch 最长 30 秒。D1 fence、部署状态和等待共同构成 drain barrier，不能只依赖将被恢复的 metadata 标志。
2. activation、export、restore、epoch rotation 和 compaction 共用同一个人工 maintenance 串行区；窗口内禁止执行其他 metadata 管理写。确认 drain barrier 后记录恢复前 bookmark，执行 Time Travel 原地恢复。
3. 重新应用并验证当前模块 migrations，盘点恢复后仍存在的 change 和 conflict receipt 版本。
4. 从目标 D1 外的 versioned activation manifest 读取最后批准的 active、accepted 和 required 集合。只有当前 bridge Worker 能覆盖这些集合以及恢复后的全部历史版本时，才在一个模块 D1 事务中写回版本集合、设置新的随机 `writeFence`、轮换随机 epoch，并保持 `maintenance=true`；无法覆盖时保持 maintenance，不能退回较旧 metadata 后直接开放。
5. 在 `maintenance=true` 时部署将来实际承载流量的候选 Worker version，通过 version metadata 和下述只读模块恢复探针完成全量 pull、模块 conformance 与客户端 recovery 验证。全部通过后，只用最终 metadata 条件事务设置 `maintenance=false`；验证与开放之间不得重新构建或部署另一个 version。恢复后第一个可写请求必须观察到新的 epoch 和 write fence。

候选 Worker 始终注册只读运维探针 `POST /api/internal/maintenance/recovery-key-probe`，但只有 Core D1 `authMode=maintenance` 且 Cloudflare Access service token 有效时才执行；其他 mode 一律返回 404。Worker 必须自行校验 `Cf-Access-Jwt-Assertion` 的签名、有效期、issuer 和 `HAKO_ACCESS_AUD`，不能只相信 Access header 存在。请求 hostname 还必须精确等于 release manifest 批准且受同一 Access application 保护的 production canonical hostname；production 始终设置 `preview_urls=false`。只有当前环境从未把 `workers.dev` 发布为稳定 canonical origin 时，canonical origin 为自有域名才设置 `workers_dev=false`；已经发布 `workers.dev` 的环境在 origin migration 规格完成前必须保持该 route。其他备用 hostname 必须关闭，Worker 也必须拒绝不匹配的 Host。探针通过 `CF_VERSION_METADATA` binding 返回实际 Worker version ID，并读取 Core D1 generation；请求携带待核对 recovery key，响应只返回 `{ workerVersionId, environment, forceAuthMaintenance, workerGeneration, databaseGeneration, matches }`。探针不得写 D1、设置 Cookie、返回 credential 或记录候选 key，沿用 16 KiB body 上限、`no-store` 和认证前限流。每次都必须验证 version、environment、`forceAuthMaintenance=false` 和两侧 generation 等于 `server/deploy/<environment>/release-manifest.json` 中批准的值；实际轮换 recovery key 时还必须分别验证新 key 的 `matches=true`、旧 key 的 `matches=false`，Core recovery 选择保留原 key 时只验证 retained key 的 `matches=true`，不能要求同一个 key 同时匹配和不匹配。通过对应分支后，才能用同一候选 version 结束 maintenance。

模块恢复另有 `POST /api/internal/maintenance/modules/:moduleKey/pull-probe`。它沿用上一段的 Access JWT、canonical hostname、version、16 KiB、`no-store` 和限流要求，只在目标模块 metadata 为 `maintenance=true`、active/accepted/required 与外部 activation manifest 一致，且请求中的 expected epoch、write fence 与当前 metadata 精确匹配时执行。探针调用与公开 pull 相同的 registry、版本门禁、cursor codec 和分页查询，只绕过公开路由的 `maintenance=false` 开放条件；响应使用正常 pull 成功信封，供全量日志、conformance 和客户端 recovery harness 验证。它不接受设备 credential 或 push，不写 D1、不推进真实客户端 cursor、不更新 `lastSeenAt`，也不把 payload 写入日志。公开模块路由在整个验证期间仍返回 503 `module_maintenance`。

恢复 `CORE_DB` 属于安全事件：

1. 部署 `HAKO_FORCE_AUTH_MAINTENANCE=true` 的强制 maintenance Worker version，关闭全部认证与同步 API，并让 scheduled handler 在接触 D1 前 no-op。确认 100% 流量与 version metadata 后，按模块恢复相同的应用截止时间和 drain barrier 等待旧 API 与 scheduled invocation 退出，并记录恢复前 bookmark。该配置属于 Worker version、位于 `CORE_DB` 外，从本步开始持续生效到第 3 步恢复后的 `authMode=maintenance` 已提交；Time Travel 把 D1 mode 回滚成 `normal` 也不能重新开放客户端路由。
2. 执行恢复，重新应用并验证当前 Core migrations。
3. 在恢复后的 `CORE_DB` 事务中撤销全部设备、失效全部 pairing token、设置 `authMode=maintenance` 并写安全审计；这一步是阻止旧凭据复活的权威措施。
4. 轮换 `HAKO_CREDENTIAL_PEPPER`、递增 `HAKO_AUTH_SECRET_GENERATION`，并部署 `HAKO_FORCE_AUTH_MAINTENANCE=false`、将来实际承载正常流量的同一个候选 Worker version；第 3 步已把 D1 mode 固定为 maintenance，因此移除数据库外门禁后它仍只开放 health 与运维探针。随后把相同 generation 写入 `auth_metadata` 并保持 maintenance。D1 全量撤销阻止旧 credential 复活，generation 则让旧 Worker fail closed，不能把新 credential 误报为无效。
5. 保留或按第 6.4 节轮换恢复密钥 hash，用只读探针验证候选 version、新旧 recovery key 与两侧 generation；全部通过后以 Core D1 条件事务把 `authMode` 改为 `recovery_register`。此 mode 只开放 health、register，以及仅供新 credential 验证的只读 session/设备列表；pair、设备写接口和全部模块路由返回 503 `auth_maintenance`。使用恢复密钥注册首台设备，并通过相应只读接口确认 Web Cookie 或原生 Bearer 生效。
6. 验证所有旧 credential/token 都失败且新设备可以认证后，只用 Core D1 条件事务把 `authMode` 改为 `normal`；不得在探针验证后重新构建或部署另一个 Worker。

D1 Time Travel 只覆盖指定数据库并取消恢复时正在执行的查询或事务；它不会终止已经离开 D1 调用的 Worker invocation，也不会回滚 Worker 代码或其他 D1。maintenance drain barrier 和恢复后的 epoch 轮换共同阻止旧请求写入新时间线。Worker 回滚不会回滚 schema，因此 migration 必须用 expand/contract，部署后的 schema 至少兼容当前和上一 Worker 版本。

## 10. 安全基线

- 所有 SQL 使用 prepared statement 和 bind 参数；不得拼接用户输入。
- Hono 路由严格执行第 7.2 节的校验顺序，再调用模块 handler；认证路由使用第 6.1 节独立 body 上限。
- 模块 route 到 D1 binding 的映射是编译期常量，不接受请求值索引任意 `env` 属性。
- API 由 Hono middleware 返回 `no-store`、`Strict-Transport-Security: max-age=31536000`、`X-Content-Type-Options: nosniff` 和适合 JSON 的安全头；静态 HTML 的 CSP、相同 HSTS、frame 防护和其他 header 由 `dist/web/_headers` 唯一配置。首版不声明 HSTS preload 或 `includeSubDomains`。
- API 响应、异常和日志不得回显原始 D1 错误、SQL、secret 或完整业务 payload。
- production 与 preview 的 D1、secrets 和 origin 完全隔离，测试不得连接 production binding。
- `HAKO_FORCE_AUTH_MAINTENANCE` 是随 Worker version 固定的布尔配置，不允许请求覆盖；值为 `true` 时关闭认证与同步 API，并让 scheduled handler 在任何 Core D1 调用前 no-op。Core Time Travel 时它是数据库外的开放门禁，只有恢复后 D1 已提交 `authMode=maintenance` 才能部署值为 `false` 的候选 version。
- 每个请求直接读取当前 `env` 的 secrets、generation、version metadata 和 bindings；不得在 module/global scope 缓存 secret 派生 verifier、HMAC key 或 binding client。仅变更 binding 时 Cloudflare 可能复用 isolate，运维探针必须能观察到本次请求的实际值。
- `HAKO_CURSOR_MAC_KEY` 使用至少 32 个密码学安全随机字节并独立备份。cursor 采用带固定 domain separator 的规范 tuple、HMAC-SHA-256 和 base64url，验证时先做严格长度与编码检查，再固定时长比较 MAC；任何非法输入 fail closed。丢失或主动轮换会让全部模块 cursor 进入 recovery，也会使尚未完成的设备列表分页 cursor 返回 400，客户端须从第一页重新列出设备；只能在 maintenance 窗口执行。
- Cloudflare 的静态和传输加密不等于端到端加密；服务提供方能够读取同步数据。用户界面披露由客户端规格维护。

## 11. 发布与运维

- D1 physical migration 先应用 local，再应用 preview 并运行 conformance tests，最后在 production 导出完成后应用；payload 版本激活是后续独立操作，不能夹在首次部署新版 codec 的 migration 中。
- payload deployment 先应用向后兼容 schema，再部署仍写旧 change 的 bridge Worker。跨版本 golden fixtures 证明无损时，后续顺序为 accepted 加入新版 → 可读新旧版本的客户端 → active/required 激活新版；不能无损时，顺序为兼容客户端发布但预激活 push 仍返回 409 → accepted、active、required 在同一个 maintenance 事务中切换。每次 metadata 管理写先更新并审核 `server/deploy/<environment>/module-activation.json`，再由同一版本的运维命令以事务应用；该 manifest 位于目标 D1 外，是 Time Travel 后恢复批准状态的事实来源。
- accepted、active 或 required 加入新版本后，只能回滚到支持这些激活值的 bridge 或更新版本；破坏性字段移除至少跨一个已发布客户端版本。认证或 cursor secret 轮换后，还必须满足相应 generation 与 key 的 rollback floor；需要恢复旧代码时重新用当前 secrets 构建部署，不能直接回滚到旧 secret 版本。
- Wrangler dry-run 必须验证 bundle、binding 声明和静态资源配置，但它不能证明远端资源真实存在；上传后把 Cloudflare 分配的 Worker version ID、目标环境和认证 generation 写入并审核 `release-manifest.json`，再创建 deployment。local 和使用全新 disposable D1 的 preview 执行 health、register、push、pull 和静态深链接 smoke test；任何已有 active device 的环境都只用现有授权设备执行 session/设备列表、只读 pull、health 和静态深链接检查，禁止用 register 做 smoke test。register 只允许首次 bootstrap 或明确批准的 recovery reset。这样验证实际 bindings 而不改变既有业务或设备状态。
- 在首个稳定原生版本前按第 5.2 节确定 canonical origin。在中国移动、中国联通、中国电信移动网络和一个家庭宽带上验证首次注册、push、pull 与断线重连；不达标时可以替换内部部署，但必须保留 canonical origin 或发布明确的客户端迁移。
- production 每月至少导出一次 Core 与业务 D1，并在每次 migration、metadata 激活和 Time Travel 前额外导出；导出文件离线加密保存 90 天，每季度演练一次导入到新 D1。D1 export 会阻塞目标数据库的其他请求，因此业务 D1 导出必须执行第 9 节的模块 maintenance、write fence 和 drain barrier；Core 导出必须先设置 `authMode=maintenance`，再部署 `HAKO_FORCE_AUTH_MAINTENANCE=true` 的强制 version，并按第 8 节排空 API 与 scheduled invocation。常态请求只得到带 `Retry-After` 的 503，不能等待 export。导出完成且校验文件可读后，部署实际承载流量且强制门禁为 `false` 的候选 version，再用 D1 条件事务恢复 normal；不轮换 epoch。Time Travel 只负责套餐窗口内的快速恢复，不能替代长期导出。
- production 每周读取 D1 size 与 rows written 指标；达到第 8 节 70% 门槛时告警并停止新增高写入模块。过期 Core 记录按第 8 节保留期清理，receipt/change compaction 必须另写协议规格。
- production 和 preview 都配置每小时 Cron Trigger 驱动第 8 节的 Core 保留期清理与 overdue 告警；local 通过直接调用 scheduled handler 的确定性测试覆盖相同逻辑，不能依赖实际时钟等待。
- 每次 Cloudflare D1 或 Workers 运行时行为更新后，在 preview 重跑 batch 原子性、只读分页快照、查询预算和恢复 conformance，再更新 `compatibility_date` 或 production 配置。

外部依赖：

- 一个启用 Workers Paid 的 Cloudflare 账号。Cloudflare D1 专属 limits 对每次 Worker invocation 的查询上限是 Paid 1000 次、Free 50 次；单批 50 条 mutation 至少需要 50 个独立模块事务，另有认证、metadata 和预读，不能满足 Free 上限。该限制不同于 Workers 的通用 internal-service subrequest 上限；若以后要求兼容 Free，必须先按最坏 SQL 路径重新测量并降低批大小。
- 首版含 Fuel 时，production/preview 共四个 D1 数据库。后续是否新增 D1 按第 1 节的事务与恢复边界决定。
- 两个环境各自独立的 `HAKO_RECOVERY_KEY_SHA256`、`HAKO_CREDENTIAL_PEPPER`、`HAKO_AUTH_SECRET_GENERATION` 和 `HAKO_CURSOR_MAC_KEY`。
- 每个 Worker version 明确固定 `HAKO_FORCE_AUTH_MAINTENANCE`；release manifest 必须记录该值，普通 deployment 只能为 `false`，Core export、恢复密钥轮换和 restore 的临时数据库外门禁 version 为 `true`。
- `CF_VERSION_METADATA` binding、`HAKO_ACCESS_TEAM_DOMAIN`、`HAKO_ACCESS_AUD`，以及只授权运维 service token 访问 maintenance probe 的 Cloudflare Access policy；客户端不能访问该路由。production Wrangler 始终关闭 Preview URL；只有当前环境从未以 `workers.dev` 发布稳定 canonical origin，且当前 canonical origin 也不是 `workers.dev` 时，才关闭 `workers.dev` route。
- 本地开发使用 `wrangler login`；自动部署只有在单独批准后才创建最小权限 API token。

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
      auth/                     # middleware、设备、配对与保留期清理
      errors/                   # 错误信封和日志脱敏
      modules/                  # 服务端静态模块注册表
      sync/                     # 通用门禁、receipt、cursor 与 push/pull 运行时
    modules/<moduleKey>/        # 模块 handler 与 D1 repository
  deploy/<environment>/
    module-activation.json      # 目标 D1 外的已批准 payload 激活状态
    release-manifest.json       # 已批准 Worker version、环境、强制门禁与认证 generation
  migrations/
    core/                       # CORE_DB migrations
    <moduleKey>/                # 模块 D1 migrations
  tests/                        # Workers/D1 集成测试
public/
  _headers                      # 随 Web 构建复制到 dist/web 的静态安全头
shared/
  sync/                         # 通用 HTTP DTO 与 Zod schema
  modules/<moduleKey>/          # 模块 wire schema；由对应模块拥有
```

## 13. 可独立合并的实施阶段

### 阶段一：服务端 Core 与静态 Web

交付 Hono/Worker 入口、SPA 静态托管、Core D1、恢复密钥注册、设备配对/撤销、环境隔离、migrations 和认证集成测试。部署后能够独立完成设备生命周期，尚未注册模块时模块路由明确返回 404 `module_not_found`。

### 阶段二：通用同步协议与 Fuel handler

交付模块 registry、push/pull、receipt/change/epoch、Fuel D1 binding 和 Fuel handler。阶段一设备和 Web 托管继续有效；Fuel handler 暗发布并通过 conformance tests 后再由客户端开放同步入口。

## 14. 验证与验收

自动化测试必须覆盖：

- SPA 深链接返回应用壳并带 CSP/HSTS 等 `_headers` 安全头，`/api` 与 `/api/*` 永远不被 SPA fallback 或缓存接管，未知 API 返回 JSON 404。
- production/preview 绑定和 secrets 不能交叉，测试环境无法访问 production D1。
- 恢复密钥错误、配对过期/二次使用/五次失败和撤销设备均失败；撤销设备创建的未消费 token 也失败。无效 Bearer 在读取 D1 前受来源网络限流，合法设备还受认证后限流；Rate Limiting binding 只产生粗粒度 429，不能替代五次失败或每设备 live 5 条、未清理 128 条、Core 总计 2048 条 token 的 D1 权威门禁。并发创建不能突破数量上限，门禁失败零写入并带规定的 `Retry-After`。每小时清理只删除符合保留期的记录且始终受批次预算约束；注入一次失败会在下一小时重试，最老 overdue age 超过 24 小时会告警并进入人工补偿流程，且不阻塞普通认证请求。
- 首次 register 创建唯一 active device；已有设备时 register 原子执行 recovery reset。active device 达到 16 时 pair 不消费 token，轮换恢复密钥后旧 key 失效。
- 两个请求并发兑换同一 token 时只有一个创建设备；兑换与创建设备撤销并发时，撤销先提交则兑换失败。
- Web 注册/配对只交付 Cookie，带 Origin 的请求不能取得 body credential；原生只取得一次 body credential。
- register/pair 响应丢失后服务端不重放 credential；Web session 能判断 Cookie 是否已经生效。
- 设备列表分页不重复或遗漏；第一页后并发创建的新设备不会插入当前快照，并在下一次完整分页出现，分页期间到达 90 天保留边界的 revoked device 在 cursor 到期前仍可读取。任意设备、自身和最后一台设备的撤销语义符合第 6.4 节。两个设备无确认并发互撤后至少保留一台 active device，后提交的撤销事务返回 409。Web logout 撤销服务端设备并清除 Cookie；撤销已提交但首次响应丢失时，重试仍返回 204 并过期残留 Cookie。若 Core D1 不可用或 generation/mode guard 失效，logout 返回 503 且保留 Cookie，恢复后仍能重试。
- Cookie 属性、Origin 校验、Bearer 重定向和日志脱敏符合安全基线。
- 认证 secret generation 不匹配时全部认证路由返回 503 `auth_maintenance`；匹配后新 credential 可认证，旧 generation Worker 不得把它误报为 401。旧恢复密钥请求在轮换前通过入口校验、轮换后才尝试 register 时，事务内 generation guard 必须零写入，不能撤销新设备或创建旧 pepper credential。
- `CORE_DB` 失败时不写模块库；模块库失败时设备管理仍可用。
- 两个请求都预读不到同一 receipt 后并发提交：同 ID/同 hash 只有一个业务效果，loser 返回 replay；同 ID/不同 hash 且写不同实体时也只有 winner 有效果，loser 返回 `idempotency_key_reused`，不能出现 500/503。
- 一批 mutation 的成功结果与请求等长同序，每项 `mutationId` 精确关联原 intent；冲突或拒绝不回滚其他成功项，且每项均可安全重试。
- 一批 mutation 处理到中途返回请求级 503 时，重试通过 receipt 重放已提交项并继续未处理项。
- 请求校验顺序、路径/body module key、非法版本语法、unsupported/尚未 accepted 版本、wire codec 错误和业务 rejected 分别得到规定结果，所有请求级失败都零写入。
- 每个已发布 schema version 的 canonicalizer golden fixtures 跨客户端与 Worker 产生相同 SHA-256；unsafe integer、浮点数和非规范 revision 字符串在写入前拒绝。
- delete 后使用相同 entity ID create 返回带 tombstone 的 conflict，不触发请求级 500。
- 空数据库 bootstrap 返回 epoch 和 seq 0 cursor；伪造 cursor、epoch 不匹配和分页恢复均不跳过 change。省略、`0`、负数、超上限和非法 `limit` 覆盖默认值与错误边界。轮换 MAC key 后模块 cursor 进入 recovery，设备列表 cursor 返回 400 并可从第一页重新开始。
- 数量上限和 1 MiB 字节预算分别截断 pull 时 `hasMore` 与 `nextCursor` 正确；存在后续 change 时不返回空页。
- push/pull 响应丢失、超过 200 条分页、并发写入和客户端时钟偏移后最终收敛。Fuel 有效上限的 10 条普通 mutation，以及单条包含 1000 个子记录的 vehicle delete，其 D1 query、rows read/written、CPU、内存和响应预算都在 Workers Paid 限制内。
- bridge Worker 部署前后和 metadata 激活前后都能提供服务；active 不在 required、历史 change/receipt 版本未被 required 覆盖或任一集合超出 Worker supported 集合时，该模块以 503 fail closed 且零写入、零推进 cursor。
- bridge 只接受 v1 时提前提交 v2 得到带 `Retry-After: 300` 的 409 `module_version_not_accepted`。只有跨版本 golden fixtures 证明 v2 权威实体经 v1 change codec 往返后语义无损，才允许 accepted 先加入 v2 并继续写 v1 change；不能无损时，accepted、active 和 required 在兼容客户端发布后的同一个 maintenance 事务中切换。
- v2 激活后，能读 v1/v2 的新客户端重放 stale v1 mutation 时取得标记为 v2 的 conflict snapshot，随后重试仍得到首次 receipt；只能读 v1 的旧客户端在 push 前收到规定的 426。
- 一个请求已经读取并固定旧 metadata snapshot 时，另一请求激活 v2：前者只写入或返回 v1，激活后开始的旧客户端请求得到 426；任何 pull page 都不能混入其 metadata snapshot 未声明的版本。
- 进入 maintenance 时，已经预检但尚未提交的旧 mutation 因 write fence 变化而零写入；暂停在两条 mutation 之间的旧请求在 drain barrier 后不能再调用 D1。恢复后旧 epoch/write fence 请求也无法写入；窗口内公开模块请求得到 retryable 503 而不是 404。只有通过 Access、hostname、version、epoch 和 write fence 校验的只读模块恢复探针能分页读取完整日志，且不能产生任何业务、cursor 或 Core 写入。
- Core 与业务 D1 导出只在各自 maintenance barrier 后开始；Core 强制 maintenance version 让新 API 返回 503、让新 scheduled invocation 在 D1 前 no-op，等待 50 秒后旧 API 与 scheduled invocation 的 D1 调用也已结束。导出完成后数据和 epoch 不变。
- recovery key 轮换在仍 maintenance 时，用绑定实际候选 version 的只读探针验证新 key 匹配、旧 key 不匹配和两侧 generation 一致；探针只接受批准 hostname，并独立验证 Access JWT 的签名、issuer、audience 和有效期，不产生设备、Cookie、`lastSeenAt` 或审计写入。随后只切换 D1 auth mode，同一个 version 开放正常流量，不能夹入第二次部署。
- Core recovery 保留 recovery key 时探针只要求 retained key 匹配；选择轮换时才要求新 key 匹配且旧 key 不匹配，两条路径都能完成而不调用 register 做负向验证。
- Fuel D1 恢复到 v2 激活前的 bookmark 时，从外部 activation manifest 恢复批准的版本集合并轮换 Fuel epoch；Core D1 回档并旋转 pepper 后旧设备全部 401。
- Core 回档重放 migrations 后，D1 全量撤销保证旧 credential 不能复活；旧 generation Worker 保持 maintenance，新 generation Worker 能认证恢复后创建的新设备。
- Core Time Travel 把 D1 `authMode` 回滚为 `normal` 时，数据库外的强制 maintenance version 仍持续返回 503；只有恢复后的全量撤销和 `authMode=maintenance` 同事务提交后才能移除该门禁。
- production 已有 active device 的发布 smoke 只执行认证只读接口和 pull，不调用 register 或产生 recovery reset；完整注册与写路径由 local/preview 覆盖。
- Worker 当前版本和指定 bridge 回滚版本都能读取 expand 阶段 schema，支持全部 active、accepted 和 required payload 版本；rollback 不要求 down migration。

实施后至少通过：

```text
pnpm test:server
pnpm exec wrangler d1 migrations apply hako-core --local --config server/wrangler.jsonc
pnpm exec wrangler d1 migrations apply hako-fuel --local --config server/wrangler.jsonc
pnpm exec wrangler deploy --dry-run --config server/wrangler.jsonc
```

## 15. 回滚与最脆弱假设

- Worker 回滚只能回到兼容当前 D1 schema、active 版本、accepted 集合、required 集合和所有 auth/cursor secret generation 的 bridge 或更新版本；数据库默认向前修复，不自动 down migration。secret 轮换后的旧代码必须用当前 secrets 重新部署，不能直接恢复旧 Worker version。
- 单个模块可从 registry 隐藏并关闭路由，保留该模块 D1、receipt 和 change。
- 服务端完全不可用时不改变任何 D1 状态；客户端的离线与恢复行为以[客户端回滚规则](./hako-client-foundation.md#14-回滚与最脆弱假设)为准。

本方案最脆弱的安全假设是允许撤销前已通过认证的所有在途请求完成。若以后要求撤销提交后连在途写入也不能成功，需要 Durable Object 或重新合并授权守卫与业务写入的事务边界；首版不承担这项复杂度。

容量方面的最脆弱假设是个人数据增长速度足以让人工导出和 70% 告警在 D1 满前留出 compaction 设计时间；上线后必须用实际 rows written、数据库大小和导出演练验证，不能把“首版不清理”当作无限容量。

## 16. 参考资料

- [Cloudflare Workers Hono](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/)
- [Cloudflare Workers Static Assets SPA](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Cloudflare Workers 静态资源 bindings](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Cloudflare Workers 静态资源 headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Cloudflare Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cloudflare Workers Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers version metadata](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)
- [Cloudflare Workers bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
- [Cloudflare Workers routes 与 custom domains](https://developers.cloudflare.com/workers/configuration/routing/)
- [Cloudflare Workers `workers.dev`](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Cloudflare Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Wrangler 多 D1 bindings](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Cloudflare D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Cloudflare D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Cloudflare China Network](https://developers.cloudflare.com/china-network/)
- [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
