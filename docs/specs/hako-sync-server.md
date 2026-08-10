# 临时规格：Hako 共享同步服务端

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
- 服务端代码位于当前仓库的 `server/`，使用同一个 pnpm lockfile，但拥有独立 Wrangler 配置、构建验证和发布流程。
- 首版只有一个 Worker；认证和模块同步通过内部代码边界隔离，不拆成多个 Worker 或独立仓库。
- 每个需要同步的业务模块使用独立 D1；身份认证使用独立 Core D1。

一个 Worker 已能绑定多个 D1，并能只让 `/api/*` 先进入 Worker、其余请求直接走静态资源。拆分仓库不会形成运行时安全边界，拆多个 Worker 则会增加部署顺序和契约漂移；只有未来出现独立团队、独立发布节奏或不可信模块时，才考虑使用 Service Binding 拆服务。

## 2. 范围

### 2.1 包含

- Web SPA 静态托管、SPA fallback 和 `/api/v1` 路由。
- 单用户个人工作区的设备注册、配对、列出、撤销和 Web 会话退出。
- Core D1 与模块 D1 的物理隔离、migrations、导出和 Time Travel 流程。
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
- D1 读副本、自定义域名和中国大陆 Cloudflare China Network 企业接入。

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
          └─ Module registry
             └─ FuelSyncHandler ──────> FUEL_DB
```

约束：

- 入口路由和认证中间件可以访问 `CORE_DB`；模块 handler 只能得到不可变 `AuthenticatedDeviceContext` 和自己的 D1 binding。
- 模块 handler 不接收完整 Worker `env`、`CORE_DB`、credential 原文或任意 binding 名称。
- `originDeviceId` 只作为模块数据库中的审计值，不建立跨 D1 外键。
- 模块加载阶段不得访问数据库、发网络请求或执行可能使整个 Worker 启动失败的初始化。

## 4. 服务端技术栈与部署边界

- TypeScript Cloudflare Module Worker。
- Hono 负责路由、中间件和类型化请求上下文。
- Zod 与 `@hono/zod-validator` 负责请求边界校验；服务端不信任客户端生成的 TypeScript 类型。
- Wrangler 负责本地运行、bindings、migrations、类型生成、dry-run 和部署。
- `@cloudflare/vitest-pool-workers` 在 Workers runtime 中运行集成测试。
- 根 pnpm 管理依赖和唯一 lockfile；`server/` 不创建第二个包管理器或独立仓库。

共享传输信封放在根目录 `shared/sync/`，是客户端和服务端唯一的 TypeScript 契约实现。模块 wire schema 放在 `shared/modules/<moduleKey>/`，由对应模块规格拥有；客户端和服务端都不得复制常量或字段表。

## 5. 环境与 Cloudflare 资源

### 5.1 固定资源

| 环境 | Worker | Core binding | 模块 binding |
| --- | --- | --- | --- |
| production | `hako` | `CORE_DB` → `hako-core` | `FUEL_DB` → `hako-fuel` |
| preview | `hako-preview` | `CORE_DB` → `hako-core-preview` | `FUEL_DB` → `hako-fuel-preview` |
| local | Wrangler local runtime | 本地模拟 `CORE_DB` | 本地模拟 `FUEL_DB` |

- production 和 preview 的 database ID、恢复密钥、credential pepper 与 cursor MAC key 必须完全不同。
- 两个 binding 分别配置 `server/migrations/core` 和 `server/migrations/fuel`。
- 新数据库创建时使用 `apac` location hint；该 hint 不保证具体物理位置。
- `compatibility_date` 首次固定为 `2026-08-10`，以后按有验证的升级变更更新，不使用隐式最新行为。

### 5.2 静态资源路由

Wrangler 从 `dist/web` 部署静态资源：

- `assets.not_found_handling` 使用 `single-page-application`。
- `assets.run_worker_first` 固定为 `['/api/*']`，API 无论是否带浏览器导航 header 都必须进入 Worker。
- 静态 hashed assets 不经过应用代码；API、认证和同步响应全部 `Cache-Control: no-store`。
- Web 构建必须把 `public/_headers` 复制到 `dist/web/_headers`，由 Static Assets 为 HTML 和 SPA fallback 设置 CSP、frame 防护、`nosniff` 和 Referrer Policy；这些请求不经过 Worker 代码，不能依赖 Hono middleware 补 header。
- Web SPA 与 API 同源，不开放宽泛 CORS。原生客户端使用固定 HTTPS origin。

## 6. 身份认证与设备管理

Hako 服务端是单租户、单个人工作区；客户端不得提交或选择 `accountId`。

### 6.1 API

设备摘要固定为 `{ id, name, platform, createdAt, lastSeenAt, revokedAt, isCurrent }`，其中 `platform` 只能是 `windows`、`macos`、`linux`、`ios`、`android` 或 `web`；名称去除首尾空白后为 1 至 80 个字符。所有 secret 只通过 HTTPS 请求体、响应体、Cookie 或 Authorization header 传输，不放入 URL。

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /api/v1/devices/register` | `{ recoveryKey, deviceName, platform, credentialDelivery }` | 201；设备摘要及第 6.2 节规定的一次 credential 交付 |
| `POST /api/v1/pairing-tokens` | 设备 credential；空 JSON | 201 `{ pairingToken, expiresAt }`，token 只返回一次 |
| `POST /api/v1/devices/pair` | `{ pairingToken, deviceName, platform, credentialDelivery }` | 201；原子消费 token，返回设备摘要及一次 credential 交付 |
| `GET /api/v1/devices` | 设备 credential | 200 `{ devices: DeviceSummary[] }`，包含 active 与 revoked 设备但不含 secret |
| `DELETE /api/v1/devices/:deviceId` | 设备 credential | 204；幂等撤销并失效目标设备创建的未消费 pairing token，未知 ID 返回 404 |
| `GET /api/v1/session` | Web Cookie | 200 `{ device: DeviceSummary }`；无效会话返回 401 |
| `POST /api/v1/session/logout` | Web Cookie | 204 并过期当前 Cookie，不撤销设备 |
| `GET /api/v1/health` | 无 | 200 `{ deploymentVersion }`，不查询 D1 或泄露 bindings |

`credentialDelivery` 只有两种合法组合：

- Web 必须使用 `cookie`、`platform=web` 且请求 `Origin` 精确匹配部署 origin；响应只设置 HttpOnly Cookie，JSON 不含 credential。
- 原生必须使用 `body`、非 Web platform 且请求不带浏览器 `Origin`；JSON 额外返回一次 `credential`。带 `Origin` 的请求永远不能取得 body credential。

register/pair 的设备创建可能先于响应交付完成，客户端不能在超时或连接中断后自动重试一次性交付请求。Web 应先通过 session API 判断 Cookie 是否已生效；原生端若没有持久化 credential，则由用户发起新的注册或配对。首版不保存可重放的 credential 原文，结果不确定的旧设备通过设备列表显式撤销。

认证 API 使用第 7.4 节的错误信封：`invalid_request` 为 400/422，`invalid_recovery_key`、`invalid_credential` 和 `invalid_pairing_token` 为 401，`device_not_found` 为 404，`rate_limited` 为 429，`database_unavailable` 为 503。过期、已消费、错误或尝试次数耗尽的配对 token 都返回同一个 `invalid_pairing_token`，响应不能用于枚举内部状态。

### 6.2 恢复密钥与 credential

- 部署时生成 32 个密码学安全随机字节，编码为 `hako_r_` 前缀 base64url 恢复密钥，由用户离线保存。
- Worker secret `HAKO_RECOVERY_KEY_SHA256` 只保存恢复密钥的 SHA-256 十六进制摘要；不得让第一次公开请求决定恢复密钥。
- 每台设备获得 `hako_d_<deviceId>.<secret>` credential；device ID 是 UUID v4，secret 至少 32 个随机字节，只返回一次。
- Worker secret `HAKO_CREDENTIAL_PEPPER` 至少 32 个随机字节；D1 只保存 credential 和配对 secret 的 HMAC-SHA-256，不保存 bearer 原文。
- credential 与配对 token 的 HMAC 使用同一 pepper 但加入不同的固定 domain separator，避免不同凭据类型复用摘要。
- credential、恢复密钥和配对 token 比较使用固定时长的字节比较，错误响应不得泄露是哪一部分不匹配。
- 已授权设备生成 `hako_p_<pairingId>.<secret>`；pairing ID 是 UUID v4，secret 至少 16 个随机字节，十分钟过期、单次使用，每个 pairing ID 最多五次错误兑换，并保存创建设备 ID。
- 配对兑换的一个 `CORE_DB.batch()` 必须以随机 request nonce 条件更新 token，再用 `INSERT ... SELECT` 只在该 token 被同一 nonce 成功消费且创建设备仍未撤销时创建设备；错误 secret 的失败次数也在同批条件更新。以 device insert 的 affected row 判断成功，并发兑换最多一个成功。设备撤销在同一个 Core D1 事务中失效该设备创建的全部未消费 token；撤销先提交时，随后兑换统一返回 `invalid_pairing_token`。

### 6.3 Web Cookie 与请求校验

- Web 使用 `__Host-hako_device` Cookie：`Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`，不设置 `Domain`。
- 所有 Web 写请求校验 `Origin` 必须等于部署 origin；认证与同步响应使用 `no-store`。
- 原生端使用 `Authorization: Bearer hako_d_<deviceId>.<secret>`，拒绝跨 origin 重定向。
- 请求、错误、访问日志和诊断信息不得包含 Cookie、Authorization、恢复密钥、配对 secret 或完整请求 payload。

### 6.4 Core D1

| 表 | 用途 |
| --- | --- |
| `auth_metadata` | Core schema 版本和安全审计 metadata |
| `devices` | ID、名称、平台、credential HMAC、创建/撤销时间、节流后的最近活跃时间 |
| `pairing_tokens` | token HMAC、创建设备 ID、过期/消费/失效时间、失败次数 |
| `auth_audit` | 注册、配对、撤销和恢复事件，不记录 secret |

认证中间件成功后只产生 `{ deviceId, deviceName, platform }` 的不可变上下文。模块提交成功后的 `lastSeenAt` 更新是 Core D1 的最佳努力操作；更新失败不得把已成功的模块 mutation 返回为失败。

设备撤销的语义固定为：撤销事务提交后开始的认证检查必须失败，目标设备创建但尚未消费的 pairing token 也必须失效；在撤销提交前已经完成认证检查的所有在途请求都允许完成。跨 `CORE_DB` 与模块 D1 不宣称原子撤销。

## 7. 模块同步协议 v1

### 7.1 路由与版本

每个模块使用独立端点：

- `POST /api/v1/modules/:moduleKey/sync/push`
- `GET /api/v1/modules/:moduleKey/sync/pull?transportProtocolVersion=1&readableSchemaVersions=1,2&limit=200[&after=<opaque-cursor>]`

`:moduleKey` 必须命中编译期服务端注册表；客户端不能通过 payload 选择 D1 binding。push 请求体与所有 JSON 响应携带 `transportProtocolVersion` 和 `moduleKey`；push 批次还携带唯一的 `moduleSchemaVersion`，不同 payload 版本不得混在一个批次。

每个服务端模块注册项必须声明：

- `supportedChangeSchemaVersions`：当前 Worker 能编码新 change snapshot 并解码历史 change payload 的版本集合。
- `supportedPushSchemaVersions`：当前 Worker 能解码、规范化、校验和幂等重放的 mutation 版本集合。

模块 D1 的 `sync_metadata` 另存 `activeChangeSchemaVersion`、`acceptedPushSchemaVersions` 和 `requiredReadableChangeSchemaVersions`。新 change 和新 conflict snapshot 使用当前请求固定的 active 版本，push 版本必须位于 accepted 集合，push/pull 客户端必须覆盖 required 集合。门禁固定为 `activeChangeSchemaVersion ∈ requiredReadableChangeSchemaVersions ⊆ supportedChangeSchemaVersions` 且 `acceptedPushSchemaVersions ⊆ supportedPushSchemaVersions`；现存 change 和 receipt conflict snapshot 仍可能返回的全部版本也必须包含在 required 集合中。Worker 只在这些条件全部成立时开放该模块，不要求代码支持集合与数据库激活集合完全相等。

registry 的 supported 集合是 Worker 代码常量；D1 的 active、accepted 和 required metadata 禁止跨请求缓存。每个 push/pull 必须在业务操作前读取一次权威 metadata 并在整次请求内固定使用。pull 将 metadata/readable 检查与本页 change 查询放入同一个只读 `D1Database.batch()` 事务，确保激活事务不能插入两者之间；push 可以继续使用预检时取得的旧快照处理整个批次，因为普通升级只扩展 accepted/required，旧 active 仍在 required 中。这样激活前开始的请求只产生和返回旧版本，激活后开始且不支持新 required 的请求在写入或查询前得到 426。

版本升级分阶段完成：先应用不改变激活版本的 expand migration，再部署同时支持旧版和新版、但 metadata 仍只接受旧 push 并按旧 active 版本写入的 bridge Worker；conformance 通过后才在模块 D1 事务中扩展 accepted 集合、激活新写版本并把它加入 required 集合，最后发布能读取全部 required 版本的客户端。不得在首次加入新版 codec 的同一次部署中激活新版。新客户端只把未冻结 pending 迁移到当前写版本，冻结 mutation 仍以旧版本原样重试。升级后的客户端可以继续提交 accepted 集合中的旧 mutation；不能覆盖 required 集合的旧客户端在 push 或 pull 前收到 426 并暂停该模块，直到升级或被撤销。

cursor 不绑定 payload schema，因此升级后的客户端可从原 seq 继续拉取混合版本 change。change log 和 receipt 首版永久保留，普通版本升级中的 required 集合只能增加；投入生产的旧 codec 不得直接删除。无法保持该兼容性的变更必须另写破坏性迁移规格，选择新 module key 或显式 epoch/outbox 迁移，不能静默返回永久 426。

transport 版本不兼容返回 426 `client_upgrade_required`；push 版本不在 D1 metadata 的 accepted 集合，或 push/pull 声明未覆盖 required 集合时返回 426 `module_upgrade_required`。客户端 store migration、模块 D1 migration、transport、payload、bootstrap 与 archive 版本互不等价。

### 7.2 Push

请求体固定为 `{ transportProtocolVersion, moduleKey, moduleSchemaVersion, readableSchemaVersions, epoch, mutations }`，成功响应固定为 `{ transportProtocolVersion, moduleKey, epoch, results }`。请求体最大 256 KiB，单次最多 50 条 mutation。Worker 在任何模块写入前预检整批请求的认证、epoch、版本、大小、JSON 结构和字段类型；`readableSchemaVersions` 未覆盖 required 集合时也以 426 拒绝，预检失败时整批零写入。客户端必须按 `moduleSchemaVersion` 分批，服务端使用对应版本的 canonicalizer 计算请求哈希，再转换成当前领域输入校验。请求哈希只覆盖该 mutation 的 schema 版本、实体、操作、base revision 和规范化 payload；批次顺序及 `readableSchemaVersions` 不参与哈希，客户端升级能力后仍可重放同一冻结 mutation。

通用 mutation 字段：

| 字段 | 规则 |
| --- | --- |
| `mutationId` | 客户端全局生成 UUID v4，重配对后也不改变；服务端在当前模块内保证幂等 |
| `entityType` | 由模块 schema 定义 |
| `entityId` | UUID v4 |
| `operation` | `create`、`update` 或 `delete` |
| `baseRevision` | create 为 `0`；update/delete 为最后确认 revision |
| `payload` | create/update 为模块完整快照；delete 为 `null` |

请求携带该模块最后确认的 `epoch`；缺失或不匹配时整批返回 409 `cursor_reset_required`，不得执行部分写入。全新客户端先 pull 获得 epoch。

通过预检后按请求顺序处理，每条 mutation 是一次独立的模块 D1 事务；一条冲突或拒绝不回滚其他项。每项结果都携带原 `mutationId`，与请求 mutation 一一对应并保持请求顺序。逐项结果只有：

- `applied`：目标实体的新 revision；客户端仍必须通过 pull 推进 cursor。
- `conflict`：`revision_mismatch`、当前 revision、`moduleSchemaVersion` 及该版本的服务端快照或 tombstone；首次结果使用 active 版本，receipt 重放保持首次版本和内容。
- `rejected`：稳定的通用或模块业务错误码。

mutation 首次终态 `applied`、`conflict` 或业务 `rejected` 必须和规范化请求哈希写入 receipt。重试完全相同 mutation 返回首次终态并标记 `replayed: true`；相同 ID、不同规范化内容只把该项拒绝为 `idempotency_key_reused`，不能修改原 receipt 或丢失其他项的回执。

处理中途出现请求级可重试错误时，Worker 停止处理剩余 mutation 并返回对应非 200 错误；此前已经提交终态的 mutation 不回滚。客户端原样重试整个冻结批次时，已提交项由 receipt 返回 `replayed: true`，未处理项再首次执行。

### 7.3 Pull

`after` 可省略：这表示从 seq `0` bootstrap，而不是一个空字符串 cursor。请求仍必须携带 transport 版本和客户端可读取的 payload 版本集合。响应顶层固定包含 `{ transportProtocolVersion, moduleKey, epoch, changes, nextCursor, hasMore }`；即使数据库没有 change，首次 bootstrap 也返回当前 epoch 和表示 seq `0` 的非空 `nextCursor`，客户端据此才可开始 push。

如果 `readableSchemaVersions` 未覆盖模块 D1 metadata 的 required 集合，服务端在查询或返回 change 前以 426 拒绝，不能部分返回或推进 cursor。change 至少包含：

- `seq`：十进制字符串。
- `moduleSchemaVersion`、`entityType`、`entityId`、`revision`。
- `operation`: `upsert` 或 `delete`。
- `payload`：upsert 的完整不可变快照；delete 为 `null`。
- `originDeviceId` 和 `serverChangedAtMs`。

查询固定为 `seq > cursor ORDER BY seq LIMIT`，不得使用 offset。`nextCursor` 只推进到实际返回的最后一项；已有 cursor 的空页保持旧 cursor。push 响应不能推进 pull cursor。

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
| cursor MAC/字段无效或 epoch 不匹配 | 409 `cursor_reset_required`，`retryable=false` |
| 业务 revision 冲突 | push HTTP 200 的逐项 `conflict` |
| 限速 | 429 `rate_limited`，`retryable=true` 并提供 `Retry-After` |
| 模块约束 CAS 持续争用 | 503 `constraint_contention`，`retryable=true` |
| Core 或模块 D1 暂时不可用 | 503 `database_unavailable`，`retryable=true` |
| 未知服务端错误 | 500 `internal_error`，`retryable=true` |
| transport 版本不兼容 | 426 `client_upgrade_required`，`retryable=false` |
| module schema 不兼容 | 426 `module_upgrade_required`，`retryable=false` |

本文只定义服务端结果；客户端暂停范围、重试和 intent 处理以[客户端错误映射](./hako-client-foundation.md#84-调度与故障隔离)为唯一事实来源。

## 8. 模块 D1 接入契约

每个同步模块的 D1 至少包含：

| 表 | 用途 |
| --- | --- |
| `sync_metadata` | transport 版本、module key、active/accepted/required payload 版本与随机 epoch |
| `mutation_receipts` | mutation ID、来源设备、请求哈希、首次终态和完整结果 |
| `changes` | 自增 seq、实体/版本、操作、不可变 snapshot、设备和服务端时间 |
| 模块业务表 | 由模块规格定义 |

通用约束：

- 每次 push/pull 都读取不跨请求缓存的 metadata，校验 registry key 与 metadata key 相等，并执行第 7.1 节的 active/accepted/required 门禁；不兼容只使该模块返回 503，不能阻止 Worker 或其他模块启动。
- `UNIQUE(entity_type, entity_id, revision)`；同一实体版本只有一条 change。
- `changes` 保存当时的完整快照，不能只保存指向当前实体的指针。
- 同一 mutation 的 receipt、实体变化和 change 必须位于一个该模块 `D1Database.batch()`；任何 statement 失败都回滚整个 sequence。
- TypeScript 的预读和纯 validator 只能提供早期错误；涉及多行或跨实体不变量的模块必须在同一 D1 batch 中使用条件 DML、guard revision 或 trigger 作最终仲裁，affected row 不符合预期时整条 mutation 冲突或拒绝。
- revision 只由服务端当前值仲裁，不使用客户端时间；create 从 `1` 开始，已接受 update/delete 每次加 `1`。
- tombstone、receipt 和 change log 首版永久保留；“删除”不是物理擦除。客户端披露要求由[客户端安全规格](./hako-client-foundation.md#10-平台安全与构建)维护。
- 空 pull 不更新 Core D1；设备活跃时间最多每小时最佳努力写一次。
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

1. 关闭该模块同步路由。
2. 记录恢复前 bookmark，执行 Time Travel 原地恢复。
3. 重新应用并验证当前模块 migrations。
4. 在恢复后的数据库中轮换 `sync_metadata.epoch`。
5. 验证 pull 全量日志、模块 conformance 和客户端 recovery 流程后重新开放。

恢复 `CORE_DB` 属于安全事件：

1. 部署 maintenance 状态，关闭全部认证与同步 API，并记录恢复前 bookmark。
2. 执行恢复，重新应用并验证当前 Core migrations。
3. 在恢复后的 `CORE_DB` 事务中撤销全部设备、失效全部 pairing token 并写安全审计；这一步是阻止旧凭据复活的权威措施。
4. 轮换 `HAKO_CREDENTIAL_PEPPER` 并发布包含新 secret 的 Worker 版本，作为附加防线；即使以后回滚到持有旧 pepper 的 Worker，D1 中的全量撤销仍必须使旧 credential 失败。
5. 保留恢复密钥 hash，只开放恢复注册，使用恢复密钥注册首台设备。
6. 验证所有旧 credential/token 都失败后，再开放其他认证与同步 API。

D1 Time Travel 只覆盖指定数据库并取消该库在途查询；它不会回滚 Worker 代码或其他 D1。Worker 回滚也不会回滚 schema，因此 migration 必须用 expand/contract，部署后的 schema 至少兼容当前和上一 Worker 版本。

## 10. 安全基线

- 所有 SQL 使用 prepared statement 和 bind 参数；不得拼接用户输入。
- Hono 路由先执行请求大小、Content-Type、Origin、认证和 schema 校验，再调用模块 handler。
- 模块 route 到 D1 binding 的映射是编译期常量，不接受请求值索引任意 `env` 属性。
- API 由 Hono middleware 返回 `no-store`、`X-Content-Type-Options: nosniff` 和适合 JSON 的安全头；静态 HTML 的 CSP、frame 防护和其他 header 由 `dist/web/_headers` 唯一配置。
- API 响应、异常和日志不得回显原始 D1 错误、SQL、secret 或完整业务 payload。
- production 与 preview 的 D1、secrets 和 origin 完全隔离，测试不得连接 production binding。
- `HAKO_CURSOR_MAC_KEY` 必须稳定保存并独立备份；丢失或主动轮换会让全部模块 cursor 进入 recovery，只能在 maintenance 窗口执行。
- Cloudflare 的静态和传输加密不等于端到端加密；服务提供方能够读取同步数据。用户界面披露由客户端规格维护。

## 11. 发布与运维

- D1 physical migration 先应用 local，再应用 preview 并运行 conformance tests，最后在 production 导出完成后应用；payload 版本激活是后续独立操作，不能夹在首次部署新版 codec 的 migration 中。
- deployment 顺序固定为向后兼容 schema → 仍写旧版的 bridge Worker → D1 metadata 激活 → 客户端。accepted、active 或 required 加入新版本后，只能回滚到支持这些激活值的 bridge 或更新版本；破坏性字段移除至少跨一个已发布客户端版本。
- Wrangler dry-run 必须验证 bundle、bindings 和静态资源；部署后执行健康、注册、push、pull 和静态深链接 smoke test。
- 初期使用 `workers.dev` 域名并发布稳定 HTTPS origin；客户端如何消费该 origin 由客户端构建规格维护。
- 在中国移动、中国联通、中国电信移动网络和一个家庭宽带上验证首次注册、push、pull 与断线重连；不达标时保持客户端和协议不变，替换服务端部署位置。

外部依赖：

- 一个 Cloudflare 账号。
- 首版含 Fuel 时，production/preview 共四个 D1 数据库；以后每增加一个同步模块，每个环境增加一个模块 D1。
- 两个环境各自独立的 `HAKO_RECOVERY_KEY_SHA256`、`HAKO_CREDENTIAL_PEPPER` 和 `HAKO_CURSOR_MAC_KEY` secrets。
- 本地开发使用 `wrangler login`；自动部署只有在单独批准后才创建最小权限 API token。

## 12. 计划文件边界

```text
server/
  wrangler.jsonc
  tsconfig.json
  src/
    index.ts                    # Hono API 入口
    core/
      auth/                     # middleware、设备与配对
      errors/                   # 错误信封和日志脱敏
      modules/                  # 服务端静态模块注册表
    modules/<moduleKey>/        # 模块 handler 与 D1 repository
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

- SPA 深链接返回应用壳并带 `_headers` 安全头，`/api/*` 永远不被 SPA fallback 或缓存接管。
- production/preview 绑定和 secrets 不能交叉，测试环境无法访问 production D1。
- 恢复密钥错误、配对过期/二次使用/五次失败和撤销设备均失败；撤销设备创建的未消费 token 也失败。
- 两个请求并发兑换同一 token 时只有一个创建设备；兑换与创建设备撤销并发时，撤销先提交则兑换失败。
- Web 注册/配对只交付 Cookie，带 Origin 的请求不能取得 body credential；原生只取得一次 body credential。
- register/pair 响应丢失时，Web 可用 session 判断 Cookie 是否已经生效；原生客户端不会自动重试一次性交付请求，孤立设备可在后续授权后撤销。
- Cookie 属性、Origin 校验、Bearer 重定向和日志脱敏符合安全基线。
- `CORE_DB` 失败时不写模块库；模块库失败时设备管理仍可用。
- mutation 重试只产生一个 revision/change，换内容返回 `idempotency_key_reused`。
- 一批 mutation 的成功结果与请求等长同序，每项 `mutationId` 精确关联原 intent；冲突或拒绝不回滚其他成功项，且每项均可安全重试。
- 一批 mutation 处理到中途返回请求级 503 时，重试通过 receipt 重放已提交项并继续未处理项。
- 空数据库 bootstrap 返回 epoch 和 seq 0 cursor；伪造 cursor、epoch 不匹配和分页恢复均不跳过 change。
- push/pull 响应丢失、超过 200 条分页、并发写入和客户端时钟偏移后最终收敛。
- bridge Worker 部署前后和 metadata 激活前后都能提供服务；active 不在 required、历史 change/receipt 版本未被 required 覆盖或任一集合超出 Worker supported 集合时，该模块以 503 fail closed 且零写入、零推进 cursor。
- v2 激活后，能读 v1/v2 的新客户端重放 stale v1 mutation 时取得标记为 v2 的 conflict snapshot，随后重试仍得到首次 receipt；只能读 v1 的旧客户端在 push 前收到规定的 426。
- bridge isolate 已按旧 metadata 预热时并发激活 v2：激活前取得快照的 push/pull 只写入或返回 v1，激活后开始的旧客户端请求得到 426；任何 pull page 都不能混入其 metadata 快照未声明的版本。
- Fuel D1 回档只轮换 Fuel epoch；Core D1 回档并旋转 pepper 后旧设备全部 401。
- Core 回档重放 migrations 后，D1 全量撤销保证回滚到旧 pepper 的 Worker 仍不能认证旧设备。
- Worker 当前版本和指定 bridge 回滚版本都能读取 expand 阶段 schema，支持全部 active、accepted 和 required payload 版本；rollback 不要求 down migration。

实施后至少通过：

```text
pnpm test:server
pnpm exec wrangler d1 migrations apply hako-core --local --config server/wrangler.jsonc
pnpm exec wrangler d1 migrations apply hako-fuel --local --config server/wrangler.jsonc
pnpm exec wrangler deploy --dry-run --config server/wrangler.jsonc
```

## 15. 回滚与最脆弱假设

- Worker 回滚只能回到兼容当前 D1 schema、active 版本、accepted 集合和 required 集合的 bridge 或更新版本；数据库默认向前修复，不自动 down migration。
- 单个模块可从 registry 隐藏并关闭路由，保留该模块 D1、receipt 和 change。
- 服务端完全不可用时不改变任何 D1 状态；客户端的离线与恢复行为以[客户端回滚规则](./hako-client-foundation.md#14-回滚与最脆弱假设)为准。

本方案最脆弱的安全假设是允许撤销前已通过认证的所有在途请求完成。若以后要求撤销提交后连在途写入也不能成功，需要 Durable Object 或重新合并授权守卫与业务写入的事务边界；首版不承担这项复杂度。

## 16. 参考资料

- [Cloudflare Workers Hono](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/)
- [Cloudflare Workers Static Assets SPA](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Cloudflare Workers 静态资源 bindings](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Cloudflare Workers 静态资源 headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Wrangler 多 D1 bindings](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare D1 `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Cloudflare China Network](https://developers.cloudflare.com/china-network/)
