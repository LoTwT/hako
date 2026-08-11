# 临时规格：Hako 客户端共享基建

> 状态：待确认
>
> 创建日期：2026-08-10
>
> 适用版本：Hako `0.0.0` 之后的首个应用基建版本
>
> 单一事实来源：本文只定义客户端应用壳、模块契约、本地平台能力、身份状态和同步客户端；HTTP、认证及云端协议由[共享同步服务端规格](./hako-sync-server.md)定义，业务语义由各模块规格定义。
>
> 临时性：属于同一临时规格组，统一清理门禁见[文档索引](../index.md#临时规格)。

## 1. 目标

Hako 是供个人使用的跨平台工具箱，不是单一加油应用。客户端基建必须让 Windows、macOS、Linux、iOS、Android 和 Web 共用一致的应用入口，同时允许各工具独立持久化、独立同步和独立失败。

成功标准：

- 默认入口是工具首页，而不是任何具体工具。
- 未注册、未解锁、离线或服务端故障时，本地工具仍可完整使用。
- 一个工具初始化、迁移或同步失败时，应用壳和其他工具仍可使用。
- 新增第二个工具时，不需要修改既有工具的领域模型、数据库或同步状态机。
- Web 和五个 Tauri 原生平台复用 Vue 组件及纯 TypeScript 逻辑，但平台能力通过明确适配器隔离。

## 2. 范围

### 2.1 包含

- Vue 应用壳、工具首页、全局设置和响应式导航。
- Vue Router 路由、Pinia 应用级状态和编译期工具注册表。
- 模块生命周期、能力声明、初始化失败隔离和按需加载。
- Core 与各业务模块的本地数据库边界及 migration 规则。
- 原生 SQLite、Web IndexedDB、文件选择、PWA 和平台安全边界。
- 全局同步身份状态、原生凭据保险库和 Web 不透明会话状态。
- 通用同步调度、outbox、cursor、epoch reset、冲突和 Web lease 机制。
- Web/native 独立构建产物及六端验证入口。

### 2.2 不包含

- 可下载插件、第三方脚本、运行时动态安装工具或插件市场。
- 多用户、公开注册、账号切换、共享数据或角色权限。
- 业务模块的领域字段、计算公式、页面细节和归档内容格式。
- 服务端路由、认证 token 格式、D1 表和 Cloudflare 运维。
- 跨模块数据库事务、跨模块外键或隐式读取其他模块数据。
- 应用被终止或移动系统挂起后的后台同步保证。
- Hako 全量备份容器；首版仅允许模块分别导入导出自己的数据。

## 3. 架构与依赖方向

```text
                          Hako App Shell
                    ┌──────────┴──────────┐
              工具注册表 / Router       全局设置
                    │                 身份 / 同步状态
             ┌──────┴──────┐              │
         Fuel 模块       后续模块      Core services
             │              │          ├─ identity
       模块仓储与同步适配器   │          ├─ sync engine
             └──────┬───────┘          └─ platform ports
                    │                        │
             模块专属本地数据库       Native / Web adapters
                    │                        │
                    └──── 已认证传输 ────────┘
                                 │
                         Hako 同步服务端
```

依赖规则：

- `app` 可以组合 Core 和工具模块；Core 不得导入任何具体工具类型。
- 工具模块可以依赖 Core 公开契约，但不能导入其他工具模块。
- 领域层不得导入 Vue、Pinia、Tauri、浏览器 API、数据库驱动或网络客户端。
- 平台适配器实现 Core 或模块端口，不得反向包含业务决策。
- 模块不能读取 credential、构造任意服务端 origin 或直接调用未认证网络接口。

隔离结论：身份不是某个工具的“登录功能”，而是 App Shell 拥有的可选同步能力；未启用身份时所有本地工具照常使用。应用设置进入 Core store，credential 进入独立保险库，各工具业务数据进入各自物理 store；同步 Core 只通过端口调度，不拥有业务表。这个边界同时隔离代码、持久化、同步故障和后续模块演进。

## 4. 应用入口与导航

### 4.1 固定路由

| 路径 | 所有者 | 用途 |
| --- | --- | --- |
| `/` | App Shell | 工具首页，展示编译进当前版本且可用的工具 |
| `/tools/<moduleKey>` | 工具注册表 | 具体路径由模块 manifest 唯一声明 |
| `/settings` | App Shell | 全局设置首页 |
| `/settings/sync` | Core Identity/Sync | 同步启用、配对、解锁和状态 |
| `/settings/devices` | Core Identity | 已授权设备列表与撤销 |
| `/:pathMatch(.*)*` | App Shell | 明确的未找到页面 |

- Web 构建使用 HTML5 history，并由服务端 SPA fallback 支持刷新和深链接。
- Tauri 原生构建使用 hash history，避免本地协议刷新子路径时依赖服务端回退。
- `App.vue` 只装配全局样式、应用壳和 `RouterView`；任何完整业务页面不得写入根组件。
- 路由不以“已登录”为前置条件。未配对或 vault 未解锁只影响远程同步，不得重定向或阻止本地工具页面。

### 4.2 响应式入口

- 桌面和宽屏：常驻侧栏提供“工具首页”和“设置”，工具内部导航由工具自己拥有。
- 窄屏和移动端：根页面使用工具卡片；进入工具后使用系统式返回层级，不用固定塞满底部导航。
- 全局区域只显示聚合后的同步状态；具体待同步数量和冲突详情由对应模块渲染。
- 首版工具首页只注册“加油统计”，但结构不得假设只有一个工具。

## 5. 编译期工具注册表

首版使用静态 TypeScript 注册表，不建设动态插件系统。每个 `ToolModuleDefinition` 必须声明：

| 字段 | 规则 |
| --- | --- |
| `moduleKey` | 永久稳定，匹配 `^[a-z][a-z0-9-]{0,31}$`；发布后不得改名或复用 |
| `displayName` | 用户可见名称 |
| `routePath` | 唯一且位于 `/tools/` 下 |
| `loadView` | 路由级按需加载入口 |
| `persistence` | `none` 或模块专属 store 描述 |
| `syncAdapter` | 不同步时为空；同步模块声明当前写入版本、可读取版本及受 Core 驱动的适配器 |
| `archiveAdapter` | 不支持导入导出时为空；只描述内容 codec，不直接访问文件系统 |

注册表启动时同步校验 module key、route 和 store 名称不重复；失败模块标为 `unavailable`，不能使应用白屏。模块初始化状态固定为 `uninitialized`、`initializing`、`ready`、`unavailable`，只在首次进入或后台同步需要时按需初始化。

停用或移除模块时先从入口隐藏，保留数据库、outbox、冲突和归档能力；数据清理必须是以后单独授权的操作，不能随代码升级自动删除。

### 5.1 版本边界

以下版本独立演进，不得共用一个数字或相互推断：

| 版本 | 所有者 | 作用 |
| --- | --- | --- |
| 客户端 store migration | 各平台模块仓储 | SQLite/IndexedDB 物理 schema |
| 模块 D1 migration | 服务端模块仓储 | 云端物理 schema |
| transport protocol | 共享同步 Core | HTTP 信封、错误和 cursor 语义 |
| module payload schema | 模块 `syncAdapter` | 业务实体 wire payload |
| bootstrap version | 模块仓储 | 首次把既有本地实体转成 intent 的算法 |
| archive version | 模块 `archiveAdapter` | 用户导入导出的文件格式 |

纯本地模块不声明 module payload schema。同步模块的 payload 升级仍须遵守[第 8.2 节 outbox 不变量](#82-outbox-不变量)，本节不重复定义冻结与迁移行为。

## 6. 应用级状态

使用 Pinia Setup Stores，仅承载跨路由的界面和编排状态：

- `appSettings`：主题、界面偏好和非秘密安装标识的已加载状态。
- `identity`：`localOnly`、`unpaired`、`locked`、`ready`、`credentialInvalid` 状态及明确动作。
- `syncSummary`：每个模块的 `idle`、`syncing`、`offline`、`authBlocked`、`conflict`、`failed` 聚合结果。

Pinia 不保存业务实体、outbox 内容、credential 原文或数据库对象。业务仓储是持久数据的唯一事实来源；Store 只持有可重建的视图状态。Store 之间不得在 setup 阶段循环读取，跨 Store 协调只发生在 action 中。

## 7. 本地持久化边界

### 7.1 Core store

- 原生端：production 在 `com.ayingott.hako` 的应用数据目录使用 `hako-core.db`，preview/local 分别在自身应用目录使用 `hako-preview-core.db` / `hako-local-core.db`；Web 在当前 origin 下使用 IndexedDB `hako-core`。
- 只保存非秘密 `installationId`、应用设置、已知模块状态和本地 migration metadata。
- `installationId` 使用 UUID v4，首次成功打开 Core store 时创建；它不是服务端凭据，也不用于授权。
- Core store 不保存设备 secret、vault passphrase、恢复密钥或业务实体。

Core store 无法打开时，应用壳以默认设置进入降级模式，并明确显示设置不可保存；不得继续尝试初始化远程同步。

### 7.2 模块 store

- 每个持久化模块拥有独立物理数据库：原生 production 使用 `hako-<moduleKey>.db`，preview/local 分别使用 `hako-preview-<moduleKey>.db` / `hako-local-<moduleKey>.db`，且三者位于各自 identifier 的应用数据目录；Web 在当前 origin 下使用 IndexedDB `hako-<moduleKey>`。
- 业务实体、该模块 outbox、cursor、epoch、冲突、recovery shadow 和 bootstrap 标记必须位于同一模块 store，以便单事务提交。
- 所有服务端 conflict、模块专用远端 shadow 和 recovery shadow 都保存 `sourceEpoch`、服务端 revision，以及存在时的 change seq；revision 只能在同一 epoch 内比较，旧 epoch shadow 只能作为不可提交的历史证据。
- 模块独立维护单调递增、不可变的 migration 序列；数据库版本与 module payload schema version 分开演进。
- 不允许跨 store 外键或假装跨 store 原子事务。跨模块流程只能通过应用服务和显式、可重放事件编排。
- migration 失败只把该模块置为 `unavailable`，应用壳和其他模块继续启动；不执行自动 down migration。
- 新客户端遇到高于自身支持版本的 store 时只读提示升级，不得写入或降级 schema。

### 7.3 平台实现

- 原生端由 Rust `sqlx` 持有 SQLite pool、执行 migrations 和事务；不向 Vue 开放 SQL 插件或通用查询 command。
- Web 使用 IndexedDB transaction；模块业务写入及对应 outbox 必须处于同一 transaction。
- Vue 不获得通用 SQL 或 IndexedDB 句柄，只调用类型化仓储端口。
- 文件导入导出通过受限 `ArchiveFilePort` 完成：原生使用系统文件对话框的窄 Rust command，Web 使用用户触发的 File API；模块只提供 bytes/对象 codec。

## 8. 同步客户端 Core

### 8.1 模块契约

可同步模块提供 `SyncModuleAdapter`，负责：

- module key、当前写入 payload 版本、可读取历史 change 版本和对应实体 codec。
- 冻结待发送 mutation、应用回执、应用 pull change 和生成冲突视图模型。
- 模块 bootstrap、epoch reset 核对和业务错误解释。
- 在模块 store 内完成实体、outbox、cursor 和冲突的原子变化。

Core Sync Engine 只负责调度、认证传输、通用信封、退避和生命周期触发；不得识别 `vehicle`、`fuelEntry` 等业务类型。

### 8.2 outbox 不变量

- mutation 固化 `mutationId`、`moduleKey`、`moduleSchemaVersion`、首次发送时的 epoch、base revision、规范化 payload 及请求哈希。
- 同一实体最多一条 `inFlight` 和一条尚未冻结的 `pending` successor。
- 未发送连续编辑可以合并；一旦发送，ID、版本和内容冻结，超时后必须原样重试。
- 从未冻结的 create 后续被删除时，取消 create 与其 successor 并移除本地 active 投影，不生成发往服务端的 delete；该实体 ID 仍不得复用。
- 已同步实体的未冻结 update 后续被删除时，合并为一条基于最后确认 revision 的 delete；不得先发送已被删除内容的 update。
- 发送期间再次编辑只更新 successor；旧回执不得覆盖新编辑。
- in-flight 成功后先保存返回 revision，再用它补齐 successor 的 `baseRevision` 并重新校验；in-flight 冲突或业务拒绝时，successor 与用户 intent 一起转入模块冲突，不得静默丢弃或沿用过期 base revision。
- 一页 changes 的应用和 cursor 推进必须在同一模块事务中提交。
- 常规 payload 升级只允许迁移尚未冻结的 pending intent；in-flight 必须由兼容 codec 原样重试。epoch reset 是唯一例外，按第 8.6 节核对后原样确认或隔离，不能直接改写。

### 8.3 单轮同步状态机

同一模块任何时刻最多运行一轮同步：原生端使用进程内 mutex，Web 使用第 8.5 节的 lease。Windows、macOS 和 Linux 首版同时使用 Tauri Single Instance 插件，将它作为第一个 plugin 注册，并且在打开任何 store 前完成单实例仲裁；第二次启动只聚焦既有窗口并退出。持有执行权后按以下顺序运行：

1. 若本地没有该模块 epoch，省略 `after` 参数发起 bootstrap pull，禁止发送空字符串 cursor，并声明客户端可读取的 payload schema 版本；持续拉取到 `hasMore=false`，在每页事务中应用 changes、顶层 epoch 和 cursor。首次 bootstrap 完成前不得 push。
2. 从最旧 pending 中冻结一个有界批次；不同 payload schema 版本分别成批，已冻结旧版本 mutation 不升级。
3. push 一个批次并声明该适配器可读取的 payload 版本，在模块事务中按 `mutationId` 应用每项 receipt：确认 revision、重建 successor base revision、保存 rejected intent，或按结果声明的 payload 版本保存 conflict。
4. 从本地 cursor pull，逐页处理到 `hasMore=false`；即使 push 响应成功也不能用它推进 cursor。
5. 若运行期间产生新 successor 或触发器，只合并成下一轮；当前轮释放 mutex/lease 后再调度。

任何步骤失败都保存已完成事务的结果、释放执行权并按错误策略重试，不回滚先前已确认的网络操作。进程崩溃后，依赖冻结 mutation 的幂等 ID 和已提交 cursor 接管。

### 8.4 调度与故障隔离

同步触发点固定为：

- 模块本地 mutation 提交成功后。
- 应用启动并完成 Core 初始化后。
- 应用从后台回到前台后。
- 浏览器或系统报告网络恢复后。
- 应用保持前台且在线时，每 60 秒轮询一次。

Core 采用单并发、轮询各 ready 模块的调度器；一个模块失败后记录自己的退避时间并继续下一个模块。网络错误使用 1、2、4、8、16、30、60 秒指数退避并加入 ±20% jitter，单次成功后重置。重复触发合并为一次后续运行。

Core 身份失效或 credential 锁定暂停全部远程同步；模块数据库、payload 或协议错误只暂停该模块。本地 CRUD 不依赖任何同步状态。自动同步只承诺应用运行或恢复前台后的最终追平，不承诺进程终止后的后台执行。

服务端结果的客户端处理由下表唯一规定：

| 服务端结果 | 客户端动作 |
| --- | --- |
| 401 | 身份转为 `credentialInvalid`，暂停全部远程同步并保留所有 intent |
| 404 `module_not_found` | 暂停对应模块，保留 intent，等待服务端配置修复 |
| 409 `cursor_reset_required` | 进入第 8.6 节 cursor/epoch recovery，不直接重试 push |
| 409 `module_version_not_accepted` / `module_version_unsupported_by_server` | 仅暂停对应模块，保留 intent，并提示等待服务端完成版本部署；按服务端 `Retry-After` 自动探测，应用持续处于前台也不能无限暂停，不提示升级客户端 |
| 413 | 多 mutation 批次减小后重试；单条仍超限则暂停模块并保留 intent |
| 400/422 请求级错误 | 视为客户端或数据缺陷，暂停模块且不自动重试，保留冻结 mutation 供修复 |
| push 逐项 `applied` | 提交 revision、移除已确认 mutation，并按第 8.2 节重建 successor |
| push 逐项 `conflict` 或 `rejected` | 把服务端结果和本地 intent 写入模块冲突；不以同一 mutation 自动重试 |
| 426 `client_upgrade_required` | 暂停全部远程同步并提示升级，保留 intent |
| 426 `module_upgrade_required` | 只暂停对应模块并提示升级，保留 intent |
| 429 | 遵守 `Retry-After`，之后进入退避 |
| 503 `auth_maintenance` | 暂停全部远程同步并保留 intent，遵守 `Retry-After` 后重新探测身份状态 |
| 503 `module_maintenance` | 仅暂停对应模块并保留 intent，遵守 `Retry-After` 后原样重试 |
| `retryable=true` 的 5xx 或网络错误 | 保留原冻结 mutation，按退避原样重试 |
| `retryable=false` 的其他请求错误 | 暂停相应范围，不自动重试并保留 intent |

### 8.5 Web 多标签页

每个模块 store 独立保存 `sync_lease`。acquisition 原子增加单调 fencing generation，写入随机 owner 和 30 秒过期时间；持有者每 10 秒续租。应用 push/pull 响应、cursor 或 outbox 变化前，必须在同一 IndexedDB transaction 中验证 owner、generation 且 lease 未过期；验证失败即丢弃响应并由新持有者依赖幂等协议接管。

每个 IndexedDB 连接必须监听 `versionchange`：停止该模块的新 CRUD 和同步，等待当前 transaction 结束后关闭连接，并提示刷新页面。升级端收到 `blocked` 时通知其他 Hako 标签页关闭连接，向用户显示关闭或刷新旧标签页的操作提示；`blocked` 不是 migration 失败，升级完成前也不能继续使用旧 schema。

### 8.6 cursor/epoch reset

服务端报告 `cursor_reset_required` 时（包括 cursor 无效、MAC key 轮换或模块 epoch 不匹配）：

1. 只暂停该模块 push，保留实体、tombstone、outbox 和冲突。
2. 省略 `after` 参数，从 seq `0` 拉取该模块完整日志到独立 recovery shadow，不覆盖当前实体；首次响应确定候选新 epoch，每条记录保存该 `sourceEpoch` 和 change seq。
3. 核对必须同时读取 recovery shadow、实体最后确认的服务端 revision、tombstone 是否已确认以及既有 outbox，不能只比较当前 active 投影。既有 conflict 和模块专用 shadow 保留原 `sourceEpoch`，与旧 epoch revision 一起降级为历史证据，禁止和候选新 epoch 按 revision 大小合并。
4. 双方内容相同则接受新 revision。仅服务端存在且本地从未保存该 ID 时导入；本地存在 tombstone 或历史确认记录时不能按新实体导入，差异进入 `epoch_reset_reconciliation` 冲突。
5. 仅本地 active 且从未取得服务端 revision 时，复用尚未发送的 create intent；只有不存在该 intent 时才生成一条 create。曾取得服务端 revision 的 active 在服务端缺失时进入 `server_missing_after_epoch_reset` 冲突，不能自动用原 ID create。仅本地 tombstone 原样保留。
6. 旧 epoch 的 in-flight mutation 只有能由候选新 epoch recovery shadow 中的相同实体内容或 tombstone 确认终态时，才按该服务端 revision 收敛；否则连同 successor 保留为冲突证据并停止调度。恢复过程不得改写冻结 mutation，也不得为同一 intent 再生成第二条 mutation。
7. 全部核对完成后，才提交新 epoch/cursor，并把模块专用 current shadow 切换到该 epoch。用户解决冲突或恢复 successor 时，epoch 与 base revision 必须来自同一个当前 epoch snapshot；服务端缺失也要保存显式 missing marker，不能从旧 epoch shadow 补值。

HTTP 路径、信封、revision、cursor 编码和请求级错误由[服务端同步协议](./hako-sync-server.md#7-模块同步协议-v1)唯一维护。

## 9. 全局身份与凭据

Hako 首版没有传统账号登录页，只有一个本地个人工作区和可选的全局同步身份。

- 初次启动直接进入工具首页，状态为 `localOnly`；用户可在设置中启用同步。
- 原生端由 Rust credential service 使用 Stronghold 保存 `{ environmentId, canonicalOrigin, opaqueCredential }`，其中 credential 是服务端返回的完整值，例如 `hako_d_<deviceId>.<secret>`，不得解析、裁剪或自行重建。vault 文件和 record key 都必须包含编译期环境 ID；Rust HTTP client 每次请求前用编译期环境与 origin 精确读取，任一不匹配即 fail closed，credential 不得离开 service。首次配对时用户创建至少 12 个字符的 vault passphrase，并使用 Stronghold Argon2 初始化。
- passphrase 不写入文件、Core store、模块 store、日志或 Pinia；每次进程冷启动后需要解锁才启动同步。
- Vue 只能调用注册、解锁、锁定和同步等窄 command；Stronghold 内容和解锁后的 device credential 永不返回 WebView。passphrase 只作为一次 command 输入进入 Rust，并在使用后清零可清零的内存副本。
- 忘记 passphrase 时允许删除本地 vault 并重新配对，但不得删除任一模块数据、outbox 或冲突。
- 注册或配对在响应丢失、进程崩溃或 credential 持久化失败后属于结果不确定，不能自动重试一次性交付接口。Web 先调用 session API 判断 Cookie 是否已经生效，原生先检查 credential service；仍没有可用 credential 时保持 `unpaired`，由用户发起新的注册或配对，并在取得授权后撤销设备列表中的孤立设备。
- 使用恢复密钥注册可能触发服务端 recovery reset，客户端必须先明确提示其他设备会被撤销；正常增加设备只走配对流程。
- 设备设置允许撤销当前或其他设备。撤销最后一台设备需要二次确认；当前设备被撤销或 Web logout 成功后，本机立即进入 `unpaired`，停止远程同步但保留全部本地模块数据和 intent。
- Web 端长期 credential 只存在同源 HttpOnly Cookie；JavaScript 只读取会话状态 API 的结果。
- 模块只能调用 `AuthenticatedTransport`，不能读取 credential、Cookie、Stronghold 或认证 header。

恢复密钥、设备 credential、配对 token 和撤销的服务端格式由[服务端身份认证](./hako-sync-server.md#6-身份认证与设备管理)维护。

## 10. 平台、安全与构建

- `build:web` 输出 `dist/web`，使用 Web adapter、HTML5 history 和同源 `fetch`。
- `build:native` 输出 `dist/native`，使用 Tauri adapter、hash history 和窄 Rust command。
- Web bundle 不得导入或条件包含可执行的 `@tauri-apps/*` 调用；平台差异通过构建 alias 选择。
- 构建期 `HAKO_BUILD_ENVIRONMENT` 只允许 `production`、`preview` 或 `local`，并与 Tauri identifier、应用数据目录、Stronghold namespace 和 `HAKO_SYNC_BASE_URL` 组成不可拆分的受测映射：production 使用 `com.ayingott.hako`，preview 使用 `com.ayingott.hako.preview`，local 使用 `com.ayingott.hako.local`。构建脚本发现任一值不匹配时失败，运行时不能由 Vue、用户设置或远端配置切换环境。
- 原生已认证传输由 Rust HTTP client 实现，只从上述环境映射构造固定 API 地址，不接受 Vue 传入完整 origin；production 和 preview 只允许各自固定的 HTTPS origin，local 额外允许 `http://127.0.0.1:8787`，并拒绝跨源重定向。production 值必须等于服务端的 canonical origin；更换该 origin 需要保留旧兼容入口或发布显式客户端迁移，不能静默替换。
- Web 的 origin 天然隔离 Cookie 与 IndexedDB；原生依靠不同 identifier、应用数据目录和 Stronghold namespace 隔离。preview/local 构建不得打开 production store、读取 production credential 或把 production bearer 发往非 production origin；跨环境移动数据只能通过用户确认的模块归档导出和导入。
- Tauri capability 只开放已注册的业务、archive、credential 和 sync command，不开放 shell、通用 SQL、通用 HTTP 或任意文件系统范围。
- production 必须把当前 `csp: null` 替换为仅允许本地资源、Tauri IPC 和明确网络目标的 CSP；不加载远程脚本或 frame。
- PWA 只预缓存版本化应用壳和静态资源；`/api/`、认证和同步响应永不进入 Service Worker cache。
- Web 首次成功持久化业务数据后申请 `navigator.storage.persist()`；拒绝不阻塞使用，但设置页提示模块导出备份。
- 开启云同步前必须说明：首版不是端到端加密，服务提供方能够读取业务数据；服务端 tombstone、幂等 receipt 和 change log 会按服务端规格长期保留，本地“删除”不等于立即物理擦除云端历史。

## 11. 计划文件边界

```text
src/
  app/                         # App.vue、layouts、routes、工具首页
  core/
    identity/                  # Pinia identity store 与客户端用例
    settings/                  # Core store 与设置
    sync/                      # 调度器、通用状态机、信封客户端
    modules/                   # ToolModuleDefinition 与静态注册表
  features/<moduleKey>/        # 具体工具拥有的 domain/application/ui/ports
  platform/
    native/                    # Tauri adapter
    web/                       # Browser adapter
src-tauri/
  src/core/                    # Core store、credential、transport、archive command
  src/modules/<moduleKey>/     # 模块专属 repository command
  migrations/core/            # Core SQLite migrations
  migrations/<moduleKey>/     # 模块 SQLite migrations
  capabilities/               # 最小权限
shared/
  sync/                        # 客户端与服务端共用的通用 wire contract
  modules/<moduleKey>/         # 模块拥有的 wire schema 与纯 validator
```

项目继续使用同一仓库、根 `package.json`、pnpm 和单一 lockfile；服务端使用独立目录但不创建独立仓库。客户端计划新增 Vue Router、Pinia、Tauri Stronghold/Dialog/Single Instance 的 Rust 侧能力、Rust `sqlx` 与 HTTP client、`idb`、PWA、Vitest、Vue Test Utils 和 IndexedDB 测试实现，实际版本由 lockfile 固定。Vue 侧不新增 SQL、HTTP 或 Stronghold 的通用 guest API。

## 12. 可独立合并的实施阶段

### 阶段一：应用壳与本地模块平台

交付 Router、Pinia、工具首页、设置页、静态模块注册表、Core store、模块 store contract、Web/native 构建分流、PWA 和失败隔离。合并后 Hako 已是可离线运行的工具箱壳，Fuel 等模块可独立接入。

### 阶段二：身份与同步客户端 Core

交付 Stronghold/Web session adapter、已认证 transport、outbox contract、调度器、lease、epoch recovery、同步设置与状态。缺少服务端地址时同步入口明确显示“未配置”，本地工具仍完整可用；只有在[共享同步服务端规格](./hako-sync-server.md)对应端点部署后才开放配对操作。

阶段一不依赖阶段二；阶段二不改变任何既有模块业务数据。

## 13. 验证与验收

自动化测试必须覆盖：

- 注册表拒绝重复 key、route 和 store；一个模块初始化失败不阻止 Router、设置和其他模块。
- App 启动不等待网络、credential 或所有模块数据库。
- Web/native 使用相同 route name；Web 深链接刷新成功，原生 hash 路由重启成功。
- Core、Identity、Sync Pinia Store 不保存业务实体或 secret，Store action 无循环依赖。
- SQLite 与 IndexedDB 模块 store contract 一致；业务写入和 outbox 同时提交或回滚。
- 桌面第二实例不能打开 store 或启动第二轮同步；Web 旧标签收到 `versionchange` 后关闭连接，升级端从 `blocked` 恢复。
- 未冻结 create→delete 取消远端 mutation，已同步 update→delete 合并为正确 base revision 的 delete；成功回执正确重建 successor。
- 一个模块 migration、解码、422/426 或数据库失败不停止其他模块。
- 应用持续处于前台时，两个服务端版本 409 都按 `Retry-After` 自动探测并在服务端开放后恢复；`auth_maintenance` 暂停全部远程同步，`module_maintenance` 只暂停目标模块。
- 多标签 lease 过期后，旧 fencing generation 不能提交网络响应。
- in-flight mutation 重启后原样重试，successor 不被旧回执覆盖。
- 新模块先省略 `after` 从 seq `0` 完整 pull 并取得 epoch，再 push；正常轮次 pull 到 `hasMore=false`。
- 新客户端能原样重试旧 payload 版本的冻结 mutation，按 `mutationId` 关联逐项结果，并读取混合版本 change/conflict snapshot；纯本地模块不伪造 payload 版本。
- epoch reset 不重复 create intent，不自动重交曾被服务端确认但在回档后缺失的实体；旧设备不能复活其他设备已确认删除的数据。
- 回档前后两个 epoch 出现相同 entity revision 但不同 payload 时，旧 shadow 只保留为证据；当前投影、冲突决策和 successor 只使用新 epoch snapshot 或 missing marker。
- vault 锁定、401、Worker 不可用和离线时本地工具正常使用。
- 注册或配对响应丢失时不自动重复创建设备；Web 能识别已经生效的 session，原生没有持久化 credential 时保持 `unpaired` 并允许重新发起。
- 原生 credential 在注册、解锁和同步过程中从不返回 WebView，Web 响应从不暴露 Cookie 内容。
- PWA 离线冷启动成功，API/认证响应不在 Cache Storage 中。
- production bundle 不包含错误平台 adapter，Tauri capability 与 CSP 不开放通用特权。
- production、preview 和 local 构建的 identifier、数据目录、Stronghold record 与固定 origin 精确匹配；把 production vault/store 放到 preview 路径时，preview 仍不能读取或发送其中的 credential，构建参数混搭必须失败。

实施后至少提供并通过：

```text
pnpm test
pnpm build:web
pnpm build:native
cargo check --manifest-path src-tauri/Cargo.toml
```

macOS、iOS 模拟器和 Android 模拟器在本机 smoke test；Windows 与 Linux 由对应系统 CI runner 构建。未实际运行的平台必须明确标注，不能以交叉编译代替验证。

## 14. 回滚与最脆弱假设

- 应用壳可以隐藏新模块入口回滚，但不得自动删除 Core 或模块数据库。
- 同步客户端可以关闭全局入口回滚，但必须保留 outbox、冲突和模块实体。
- migration 只向前修复；旧版本遇到新 schema 进入只读或拒绝打开，不自动 down migration。

本方案假设 Hako 保持个人单用户工具。若未来需要公开注册、多账号或共享工作区，身份模型、所有服务端表和模块数据所有权都必须重新设计，不能只在现有设备凭据上增加登录页面。

## 15. 参考资料

- [Vue Router](https://router.vuejs.org/)
- [Pinia](https://pinia.vuejs.org/)
- [Tauri Stronghold 插件](https://v2.tauri.app/plugin/stronghold/)
- [Tauri Dialog 插件](https://v2.tauri.app/plugin/dialog/)
- [Tauri Single Instance 插件](https://v2.tauri.app/plugin/single-instance/)
- [Indexed Database API 3.0](https://www.w3.org/TR/IndexedDB/)
