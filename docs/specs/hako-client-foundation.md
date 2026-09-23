# 临时规格：Hako 客户端共享基建

> 状态：历史参考，自 2026-09-13 起不再约束当前实现；本轮需求与技术方向以[重新设计记录](./redesign.md)为准。下文保留上一轮未确认的方案。
>
> 创建日期：2026-08-10
>
> 适用版本：Hako `0.0.0` 之后的首个应用基建版本
>
> 单一事实来源：本文只定义客户端应用壳、模块契约、本地平台能力、身份状态和同步客户端；HTTP、认证及云端协议由[服务端共享基建规格](./hako-server-foundation.md)定义，业务语义由各模块规格定义。
>
> 归档入口：[文档索引](../index.md#临时规格)。本文中的门禁与实施要求仅属于旧方案。

## 1. 目标

Hako 是供个人使用的跨平台工具箱，不是单一加油应用。客户端基建必须让 Windows、macOS、Linux、iOS、Android 和 Web 共用一致的应用入口，同时允许各工具通过独立仓储边界持久化、独立同步和独立失败。

成功标准：

- 默认入口是工具首页，而不是任何具体工具。
- 未登录、凭据保险库未解锁、离线或服务端故障时，本地工具仍可完整使用。
- 一个工具初始化或领域数据解码失败时，只停止该工具；同步失败只停止对应模块的远程同步，本地工具继续使用。共享物理数据库无法打开或迁移失败时，应用壳必须进入明确的全局持久化降级状态。
- 新增第二个工具时，持久化层只需向客户端全局 migration 序列追加自己的 schema 变更，不需要修改既有工具的领域模型、仓储契约或同步状态机。
- Web 和五个 Tauri 原生平台复用 Vue 组件及纯 TypeScript 逻辑，但平台能力通过明确适配器隔离。

## 2. 范围

### 2.1 包含

- Vue 应用壳、工具首页、全局设置和响应式导航。
- Vue Router 路由、Pinia 应用级状态和编译期工具注册表。
- 模块生命周期、能力声明、初始化失败隔离和按需加载。
- 单一本地数据库中的 Core、同步和业务模块逻辑边界及全局 migration 规则。
- 原生 SQLite、Web IndexedDB、文件选择、PWA 和平台安全边界。
- 全局同步身份状态、OAuth/Passkey 登录入口、原生凭据保险库和 Web 不透明会话状态。
- 通用同步调度、outbox、cursor、epoch reset、冲突和 Web lease 机制。
- Web/native 独立构建产物及六端验证入口。

### 2.2 不包含

- 可下载插件、第三方脚本、运行时动态安装工具或插件市场。
- 多用户、公开注册、账号切换、共享数据、角色权限或把 Hako 作为通用 OAuth Provider。
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
              单一本地 Hako 数据库      Native / Web adapters
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
- 模块不能读取 session/token、构造任意服务端 origin 或直接调用未认证网络接口。`AuthenticatedTransport` 和模块 wire payload 都不接受 `applicationId`、`accountId` 或当前会话的 `deviceId` 作为身份作用域；这些值只能由服务端根据部署配置与权威会话推导。`IdentityPort` 可以把设备列表返回的 `DeviceSummary.id` 作为显式撤销目标，但不能用它替换当前身份或模块账户作用域。

隔离结论：身份不是某个工具的“登录功能”，而是 App Shell 拥有的可选同步能力；未启用身份时所有本地工具照常使用。非秘密应用设置与各工具业务数据进入同一个本地 Hako 数据库，但分别由 Core 和模块的类型化仓储拥有；Web session 只存在 HttpOnly Cookie，原生 token 进入独立保险库。同步 Core 只通过 `IdentityPort`、`AuthenticatedTransport` 和模块同步适配器调度，不直接读取业务表。物理数据库统一不改变代码所有权、逻辑持久化边界或模块故障隔离。

## 4. 应用入口与导航

### 4.1 固定路由

| 路径 | 所有者 | 用途 |
| --- | --- | --- |
| `/` | App Shell | 工具首页，展示编译进当前版本且可用的工具 |
| `/tools/<moduleKey>` | 工具注册表 | 具体路径由模块 manifest 唯一声明 |
| `/settings` | App Shell | 全局设置首页 |
| `/settings/sync` | Core Identity/Sync | 同步启用、登录、保险库解锁和状态 |
| `/settings/devices` | Core Identity | 已授权设备列表与撤销 |
| `/auth/sign-in` | Core Identity（Web） | OAuth/Passkey 登录与安全 return path |
| `/auth/device` | Core Identity（Web） | 原生设备授权 code 验证、批准或拒绝 |
| `/:pathMatch(.*)*` | App Shell | 明确的未找到页面 |

- Web 构建使用 HTML5 history，并由服务端 SPA fallback 支持刷新和深链接。
- Tauri 原生构建使用 hash history，避免本地协议刷新子路径时依赖服务端回退。
- `App.vue` 只装配全局样式、应用壳和 `RouterView`；任何完整业务页面不得写入根组件。
- 工具路由不以“已登录”为前置条件。未登录或原生 vault 未解锁只影响远程同步，不得重定向或阻止本地工具页面；只有 `/auth/*` 和同步设置能主动进入认证流程。

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
| `persistence` | `none`，或包含稳定 `namespace` 与类型化仓储的描述；不得声明独立物理数据库 |
| `syncAdapter` | 不同步时为空；同步模块声明当前写入版本、可读取版本及受 Core 驱动的适配器 |
| `archiveAdapter` | 不支持导入导出时为空；只描述内容 codec，不直接访问文件系统 |

`persistence.namespace` 是模块物理对象名的唯一 canonical 前缀，匹配 `^[a-z][a-z0-9]{0,31}$`，发布后不得改名或复用；`core`、`sync` 和 `sqlite` 是保留值。业务表和 object store 统一命名为 `<namespace>_<objectName>`，不得从 `moduleKey` 推导。静态注册表在构建期和打开数据库前校验 module key、route、namespace 语法、保留值及全局唯一性；构建期失败阻止生成产物，运行时失败不得执行该构建包含的 migration。模块初始化状态固定为 `uninitialized`、`initializing`、`ready`、`unavailable`，只在首次进入或后台同步需要时按需初始化；单个模块初始化失败不能使应用白屏。该 lifecycle 只表示模块本地初始化和仓储可用性，与持久 bootstrap 状态及运行时同步状态正交；同步故障不得把 `ready` 改为 `unavailable`。

停用或移除模块时先从入口隐藏，保留该模块的业务行、outbox、冲突和归档能力；数据清理必须是以后单独授权的操作，不能随代码升级自动删除。

### 5.1 版本边界

以下版本独立演进，不得共用一个数字或相互推断：

| 版本 | 所有者 | 作用 |
| --- | --- | --- |
| 客户端本地数据库 migration | 各平台 persistence adapter | 该平台唯一 SQLite/IndexedDB 物理 schema |
| 模块 D1 migration | 服务端模块仓储 | 云端物理 schema |
| transport protocol | 共享同步 Core | HTTP 信封、错误和 cursor 语义 |
| module payload schema | 模块 `syncAdapter` | 业务实体 wire payload |
| bootstrap version | 模块仓储 | 首次把既有本地实体转成 intent 的算法 |
| archive version | 模块 `archiveAdapter` | 用户导入导出的文件格式 |

纯本地模块不声明 module payload schema。同步模块的 payload 升级仍须遵守[第 8.2 节 outbox 不变量](#82-outbox-不变量)，本节不重复定义冻结与迁移行为。

## 6. 应用级状态

使用 Pinia Setup Stores，仅承载跨路由的界面和编排状态：

- `appSettings`：主题、界面偏好和非秘密安装标识的已加载状态。
- `identity`：`localOnly`、`signedOut`、`authenticating`、`locked`、`ready`、`reauthenticationRequired` 状态及明确动作。
- `syncSummary`：每个声明 `syncAdapter` 的模块先显示持久 bootstrap 状态 `localOnly`、`bootstrapping`、`enabled`；只有 `enabled` 才叠加 `idle`、`syncing`、`offline`、`authBlocked`、`conflict`、`failed` 等运行时同步状态。它只形成可重建视图，不得反向修改模块 lifecycle；没有 `syncAdapter` 的模块不创建同步状态。

Pinia 不保存业务实体、outbox 内容、session/token 原文或数据库对象。业务仓储是持久数据的唯一事实来源；Store 只持有可重建的视图状态。Store 之间不得在 setup 阶段循环读取，跨 Store 协调只发生在 action 中。

## 7. 本地持久化边界

### 7.1 单一本地数据库

- 每个运行环境只使用一个非秘密本地数据库。原生端统一在当前 Tauri identifier 的应用数据目录使用 `hako.db`；production、preview 和 local 依靠不同 identifier 与应用数据目录隔离，不在文件名中重复环境。Web 在当前 origin 下使用 IndexedDB `hako`，依靠 origin 隔离环境。
- 本地数据库是界面读取和本地写入的唯一事实来源。首次版本只包含 Core 与已交付模块的业务数据；不为尚未实现的同步、认证或后续模块预建空表。
- Core 逻辑区域保存非秘密 `installationId`、应用设置、已知模块状态和本地 migration metadata。`installationId` 使用 UUID v4，首次成功打开数据库时创建；它不是服务端凭据，也不用于授权。
- 原生 `hako.db` 在首次创建时写入不可变的数据库身份标记，至少包含 `environmentId = HAKO_BUILD_ENVIRONMENT`。Rust 打开已有数据库时先以只读方式校验该标记，再执行任何 migration、Core/模块查询或同步；标记不匹配，或非空数据库缺少标记时，进入持久化降级且不得修改该文件。只有确认是全新空数据库时，初始 migration 才能创建标记。Vue、用户设置、模块归档和远端配置都不能修改它。
- 本地数据库不得保存 OAuth provider token、Better Auth session token、秘密 `device_code`、Passkey 私钥、vault passphrase 或 Stronghold 解锁材料。Web session 仍只存在 HttpOnly Cookie，原生 access token 仍只存在 Stronghold。

数据库无法打开或全局 migration 失败时，应用壳以默认设置进入持久化降级模式，明确显示本地数据暂不可用和设置无法保存；所有持久化模块停止写入且不得启动远程同步。共享物理数据库意味着这类基础设施故障不能伪装成单模块故障。

### 7.2 模块 store

- “模块 store”是同一本地数据库内由模块仓储拥有的逻辑数据分区，不是独立 SQLite 文件或 IndexedDB database。Core 表或 object store 使用 `core_` namespace，模块业务对象使用 `<persistence.namespace>_` namespace，通用同步对象使用 `sync_` namespace 并以 `moduleKey` 分区；模块规格拥有其业务对象的精确名称和字段。
- 模块只能通过自己的类型化仓储访问所属 namespace，不得取得原始数据库句柄、读取其他模块的表或把共享物理数据库当作跨模块耦合接口。
- 阶段三加入同步后，业务实体、该模块 outbox、cursor、epoch、冲突、recovery shadow 和 bootstrap 状态必须位于同一个本地数据库，以便单事务提交；阶段零的纯本地写入只提交业务实体，不创建虚假的 outbox。
- Core 拥有按 `moduleKey` 唯一的 `sync_module_bootstrap` 表或 object store，保存 `{ state, bootstrapVersion, phase, lastStableId, revision }`。`state` 只取 `localOnly`、`bootstrapping`、`enabled`；`phase` 是模块定义的有序实体阶段，`lastStableId` 是该阶段最后一次已提交的稳定 ID，每次状态、阶段或 checkpoint 提交都递增 `revision`。阶段三代码的每个模块 CRUD 事务都必须读取该记录：`localOnly` 只写业务实体；`bootstrapping` 为新增或编辑后的 active 实体幂等创建或合并 create intent，删除从未取得服务端 revision 的实体时同步取消其未冻结 create intent；`enabled` 按正常 outbox 规则写入。状态读取、实体变化和 intent 变化必须处于同一事务，不能依赖 Pinia 或进程内缓存判断是否写 outbox。模块一旦进入 `enabled` 就不能退回 `localOnly`；关闭自动同步只暂停调度，后续本地写入仍进入 outbox。
- 首次启用模块同步的事务把记录从 `localOnly` 切为 `{ state: bootstrapping, bootstrapVersion: current, phase: first, lastStableId: null }`。每个 bootstrap batch 都新开一个本地 read-write transaction，在事务中重新读取权威记录，从持久化 checkpoint 之后选择下一段稳定实体，并以同一组预期值作条件提交；每批最多处理 100 个实体且规范化 payload 合计不超过 1 MiB，intent、下一 checkpoint 和递增 revision 在该事务中一起写入。条件失配时整批零写入并重新读取，不能使用进程内 runner 游标继续。一个 phase 扫描完毕后，以同样的条件事务进入下一 phase 并清空 `lastStableId`；全部 phase 完成后才能切为 `enabled`。SQLite 通过单 writer 保证顺序，Web transaction 必须覆盖模块业务 object store、`sync_module_bootstrap` 与 outbox。应用成功打开数据库或从后台回到前台时，发现 `bootstrapping` 模块必须自动继续本地 bootstrap，不等待用户再次开启，也不依赖身份或网络；模块达到 `enabled` 前不得启动任何远端 pull 或 push，事务也不得跨 batch 或等待网络。
- 所有服务端 conflict、模块专用远端 shadow 和 recovery shadow 都保存 `sourceEpoch`、服务端 revision，以及存在时的 change seq；revision 只能在同一 epoch 内比较，旧 epoch shadow 只能作为不可提交的历史证据。
- 每个平台只维护一条单调递增、不可变且只向前的物理 migration 序列；新增模块或同步能力只能追加 migration，不得修改已经发布的 migration。SQLite 与 IndexedDB 的物理版本可以不同，但必须实现相同的类型化仓储契约；数据库版本与 module payload schema version 分开演进。
- 共享物理数据库仍禁止跨模块外键和跨模块业务事务。跨模块流程只能通过应用服务和显式、可重放事件编排；物理上能够 join 或同事务写入不构成授权。
- 全局 migration 事务失败时保留最近一个完整 schema 并进入第 7.1 节的持久化降级状态，不执行自动 down migration。模块仓储初始化或本地业务数据解码失败只把对应模块 lifecycle 置为 `unavailable`；sync adapter、wire payload、协议或 HTTP 失败只把该模块同步状态置为 `failed` 或暂停，不改变仍健康模块的 `ready` lifecycle，也不阻止其本地 CRUD。
- 客户端遇到高于自身支持版本的本地数据库时不得开启写事务或降级 schema，只读显示升级提示。
- 停用或移除模块只隐藏入口并停止其同步，所属逻辑数据继续保留；物理清理必须由以后单独授权的 migration 执行。

### 7.3 平台实现

- 原生端由 Rust `sqlx` 持有唯一 SQLite pool，并由唯一 `NativeSqliteWriteCoordinator` 串行化 Core/模块 CRUD、归档导入、outbox、cursor、conflict、bootstrap 和 migration 等全部写事务。read→validate→write 用例必须先取得 writer permit，再在第一次读取前以 `BEGIN IMMEDIATE` 开始；任何代码不得绕过 coordinator 从 pool 开启写事务。
- SQLite 所有连接使用固定 `busy_timeout`。遇到 `SQLITE_BUSY` 或 `SQLITE_LOCKED` 时，必须回滚并从第一次读取开始有界重试整个用例，不能只重试失败 statement 或 `COMMIT`；重试耗尽后返回明确的 retryable persistence error，且不得产生部分写入。只读查询可以使用其他 pool connection。
- Web 使用一个 IndexedDB database、统一的 version upgrade 和 transaction；阶段三启用同步后，模块业务写入及对应 outbox 必须处于同一 read-write transaction。
- 平台 persistence adapter 只向 `SyncModuleAdapter` 提供按 module key 限定的 `LocalUnitOfWork`，在同一底层事务中组合该模块的类型化业务仓储与 `SyncStateRepository`。两者都不能取得原始句柄、访问其他模块，writer permit 也不授权跨模块事务。
- Vue 不获得通用 SQL 或 IndexedDB 句柄，只调用类型化仓储端口。
- 文件导入导出通过受限 `ArchiveFilePort` 完成：原生使用系统文件对话框的窄 Rust command，Web 使用用户触发的 File API；模块只提供 bytes/对象 codec。模块导出必须按逻辑仓储读取自己的领域数据，不能复制或暴露整个 `hako.db` / IndexedDB。

## 8. 同步客户端 Core

### 8.1 模块契约

可同步模块提供 `SyncModuleAdapter`，负责：

- module key、当前写入 payload 版本、可读取历史 change 版本和对应实体 codec。
- 冻结待发送 mutation、应用回执、应用 pull change 和生成冲突视图模型。
- 模块 bootstrap、epoch reset 核对和业务错误解释。
- 在本地 Hako 数据库的单一事务中完成该模块实体、outbox、cursor 和冲突的原子变化。

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

同一模块任何时刻最多运行一轮同步：原生端使用进程内 mutex，Web 使用第 8.5 节的 lease。Windows、macOS 和 Linux 首版同时使用 Tauri Single Instance 插件，将它作为第一个 plugin 注册，并且在打开本地数据库前完成单实例仲裁；第二次启动只聚焦既有窗口并退出。持有执行权后按以下顺序运行：

1. 若本地没有该模块 epoch，省略 `after` 参数发起 bootstrap pull，禁止发送空字符串 cursor，并声明客户端可读取的 payload schema 版本；持续拉取到 `hasMore=false`，在每页事务中应用 changes、顶层 epoch 和 cursor。首次 bootstrap 完成前不得 push。
2. 从最旧 pending 中冻结一个有界批次；private sync beta 每批最多 5 条，不同 payload schema 版本分别成批，已冻结旧版本 mutation 不升级。
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

Core 身份失效或原生 token vault 锁定暂停全部远程同步；sync adapter、wire payload、协议或模块服务端错误只暂停对应模块的同步。本地数据库基础设施错误按第 7.1 节停止全部持久化模块。模块本地仓储仍健康时，本地 CRUD 不依赖任何同步状态；若一次本地写入无法同时编码或提交必要 outbox，该次操作整体回滚并保留用户输入，但不能把模块永久置为 `unavailable`。自动同步只承诺应用运行且原生 vault 已解锁，或应用恢复前台后的最终追平，不承诺进程终止后的后台执行。

服务端结果的客户端处理由下表唯一规定：

| 服务端结果 | 客户端动作 |
| --- | --- |
| 401 | 身份转为 `reauthenticationRequired`，暂停全部远程同步并保留所有 intent；重新登录或设备授权不得重建 intent |
| 404 `module_not_found` | 暂停对应模块，保留 intent，等待服务端配置修复 |
| 409 `cursor_reset_required` | 进入第 8.6 节 cursor/epoch recovery，不直接重试 push |
| 409 `module_version_not_accepted` / `module_version_unsupported_by_server` | 仅暂停对应模块，保留 intent，并提示等待服务端完成版本部署；按服务端 `Retry-After` 自动探测，应用持续处于前台也不能无限暂停，不提示升级客户端 |
| 413 | 多 mutation 批次减小后重试；单条仍超限则暂停模块并保留 intent |
| 400/422 请求级错误 | 视为客户端或数据缺陷，暂停模块且不自动重试，保留冻结 mutation 供修复 |
| push 逐项 `applied` | 提交 revision、移除已确认 mutation，并按第 8.2 节重建 successor |
| push 逐项 `conflict` 或 `rejected` | 把服务端结果和本地 intent 写入模块冲突；不以同一 mutation 自动重试 |
| 426 `client_upgrade_required` | 暂停全部远程同步并提示升级，保留 intent |
| 426 `module_upgrade_required` | 只暂停对应模块并提示升级，保留 intent |
| 429 | 有可信 `Retry-After` 时遵守；前置 WAF 响应没有该 header 或 Hako JSON 信封时至少等待服务端规定的十秒，再进入退避 |
| 503 `auth_maintenance` | 暂停全部远程同步并保留 intent，遵守 `Retry-After` 后重新探测身份状态 |
| 503 `module_maintenance` | 仅暂停对应模块并保留 intent，遵守 `Retry-After` 后原样重试 |
| `retryable=true` 的 5xx 或网络错误 | 保留原冻结 mutation，按退避原样重试 |
| `retryable=false` 的其他请求错误 | 暂停相应范围，不自动重试并保留 intent |

### 8.5 Web 多标签页

共享 IndexedDB 的 `sync_leases` object store 按 `moduleKey` 保存一条 lease。acquisition 原子增加该模块的单调 fencing generation，写入随机 owner 和 30 秒过期时间；持有者每 10 秒续租。应用 push/pull 响应、cursor 或 outbox 变化前，必须在同一 IndexedDB transaction 中验证相同 `moduleKey` 的 owner、generation 且 lease 未过期；验证失败即丢弃响应并由新持有者依赖幂等协议接管。

每个 IndexedDB 连接必须监听 `versionchange`：停止全部模块的新 CRUD 和同步，等待当前 transaction 结束后关闭共享连接，并提示刷新页面。升级端收到 `blocked` 时通知其他 Hako 标签页关闭连接，向用户显示关闭或刷新旧标签页的操作提示；`blocked` 不是 migration 失败，升级完成前也不能继续使用旧 schema。

### 8.6 cursor/epoch reset

服务端报告 `cursor_reset_required` 时（包括 cursor 无效、MAC key 轮换或模块 epoch 不匹配）：

1. 只暂停该模块 push，保留实体、tombstone、outbox 和冲突。
2. 省略 `after` 参数，从 seq `0` 拉取该模块完整日志到独立 recovery shadow，不覆盖当前实体；首次响应确定候选新 epoch，每条记录保存该 `sourceEpoch` 和 change seq。
3. 核对必须同时读取 recovery shadow、实体最后确认的服务端 revision、tombstone 是否已确认以及既有 outbox，不能只比较当前 active 投影。既有 conflict 和模块专用 shadow 保留原 `sourceEpoch`，与旧 epoch revision 一起降级为历史证据，禁止和候选新 epoch 按 revision 大小合并。
4. 双方内容相同则接受新 revision。仅服务端存在且本地从未保存该 ID 时导入；本地存在 tombstone 或历史确认记录时不能按新实体导入，差异进入 `epoch_reset_reconciliation` 冲突。
5. 仅本地 active 且从未取得服务端 revision 时，复用尚未发送的 create intent；只有不存在该 intent 时才生成一条 create。曾取得服务端 revision 的 active 在服务端缺失时进入 `server_missing_after_epoch_reset` 冲突，不能自动用原 ID create。仅本地 tombstone 原样保留。
6. 旧 epoch 的 in-flight mutation 只有能由候选新 epoch recovery shadow 中的相同实体内容或 tombstone 确认终态时，才按该服务端 revision 收敛；否则连同 successor 保留为冲突证据并停止调度。恢复过程不得改写冻结 mutation，也不得为同一 intent 再生成第二条 mutation。
7. 全部核对完成后，才提交新 epoch/cursor，并把模块专用 current shadow 切换到该 epoch。用户解决冲突或恢复 successor 时，epoch 与 base revision 必须来自同一个当前 epoch snapshot；服务端缺失也要保存显式 missing marker，不能从旧 epoch shadow 补值。

HTTP 路径、信封、revision、cursor 编码和请求级错误由[服务端同步协议](./hako-server-foundation.md#7-模块同步协议-v1)唯一维护。

## 9. 全局身份与凭据

Hako 首版仍可完全无账号离线使用；只有用户在设置中启用远端同步时才进入单 owner 账户认证。OAuth、Passkey、session、Device Authorization 与设备 API 的服务端格式由[服务端身份认证](./hako-server-foundation.md#6-身份认证passkey-与设备管理)唯一维护。客户端只持有脱敏会话/设备状态和已认证传输能力，不知道、不保存、不发送远端 `accountId`。

- 初次启动直接进入工具首页，状态为 `localOnly`。选择“启用同步”后转为 `signedOut` 并显示登录动作，不把工具页变成登录墙。
- Web 在同源 `/auth/sign-in` 使用[服务端固定的 GitHub OAuth](./hako-server-foundation.md#61-owner-与账户边界)或已经登记的 Passkey；成功 session 只存在 HttpOnly Cookie。Vue 通过会话状态 API 判断是否登录，不能读取 Cookie 或把 token 复制到 localStorage、IndexedDB、Pinia 或本地数据库。
- Passkey 登记前必须重新完成 owner GitHub OAuth 身份确认；服务端只有在 callback 后签发、有效期不超过十分钟并绑定同一 session 与 ceremony 的一次性 action proof 仍有效时，才允许开始和完成 ceremony。GitHub OAuth 只确认固定 owner subject，不表示密码、2FA 或 UV 在最近十分钟内重新执行。客户端不持久化或自行伪造 proof，过期或已消费时重新发起 GitHub owner 身份确认。Passkey 私钥由系统 authenticator 保存，Hako 客户端、Stronghold、本地数据库和导出文件都不得保存或导出私钥。WebAuthn ceremony 只在固定认证 origin 执行。operator recovery 会撤销该稳定账户历次身份留下的全部 Passkey；恢复后必须以当前 GitHub 身份重新登录并重新登记，旧 Passkey 不得再次成为登录候选。
- 五个原生平台统一由 Rust identity service 请求 Hako RFC 8628 device/user code，经 Tauri Opener 打开系统浏览器。批准页只有在当前 owner 会话取得服务端要求、十分钟内签发且绑定当前 attempt 的一次性 action proof 后才可确认；proof 缺失或过期时，浏览器先重新完成 GitHub owner 身份确认，阶段二之后也可使用 UV Passkey，再返回同一 `user_code` 的批准页。只有 UV Passkey 提供近期强认证；有可用 Passkey 时界面默认使用它，GitHub OAuth 仍是个人版 fallback。批准浏览器不需要先绑定为 Hako 同步设备。Rust 在此期间保留易失 `device_code` 并继续按服务端 interval 轮询，不因浏览器确认身份生成第二个本地授权流程。`authorization_pending` 继续等待，`slow_down` 增加间隔，retryable 503 遵守 `Retry-After` 并在当前进程的易失内存中保留 `device_code` 后重试。收到 429 时同样保留本次易失 `device_code`：有可信 `Retry-After` 就遵守，没有时至少等待服务端 WAF 规定的 10 秒，再在原十分钟 expiry 内继续轮询。`expired_token`、`access_denied` 或 `invalid_grant` 结束本次流程并保留本地数据；进程退出后不持久化 `device_code`，只能重新发起。
- 原生登录不在 Tauri WebView 执行，也不依赖 deep link。系统浏览器页面完成身份验证和批准，opaque access/session token 只返回 Rust identity service。
- Rust identity service 使用 Stronghold 保存 `{ environmentId, canonicalOrigin, opaqueAccessToken }`。vault 文件和 record key 都包含编译期环境 ID；Rust HTTP client 每次请求前用编译期环境与 origin 精确读取，任一不匹配即 fail closed，token 不得离开 service。首个原生认证切片仍使用用户创建的至少 12 字符 vault passphrase 和 Stronghold Argon2；每次冷启动解锁后才自动同步。以后若要免输入解锁，必须另写各平台系统安全存储封装规格，不能把 vault key 明文写入本地数据库。
- passphrase 不写入本地数据库、日志或 Pinia。Vue 只能调用开始设备授权、查询脱敏状态、解锁、锁定、退出和同步等窄 command；只有 `user_code` 与 verification URL 可短暂返回给 Vue，秘密 `device_code` 仅保存在 Rust 易失内存中，不进入 IPC、WebView、URL、日志、本地数据库或 Stronghold。access token、Stronghold 内容和解锁后的认证 header 永不返回 WebView。
- 忘记 passphrase 时可以删除本地 vault 并重新进行 Device Authorization；不得删除任一模块实体、outbox、cursor 或冲突。重新认证后沿用原 `installationId` 并调用服务端绑定接口，不能改写既有 mutation ID。
- Web 登录完成或原生取得 token 后，客户端调用设备绑定 API，把本地数据库 Core 逻辑区域的非秘密 `installationId`、用户确认的设备名和平台关联到服务端生成的 `deviceId`。首次收到 `device_rebind_confirmation_required` 时显示该安装曾被撤销并取得用户明确确认，再以 `confirmRebind=true` 重试；已确认的重试仍得到同一错误，表示当前 session 早于最近撤销，必须重新认证并在新 session 中再次确认，不能无限重放旧 session。收到 `device_limit_reached` 时保持未绑定，展示 16 台上限并引导用户先撤销已有设备；原生 Device Authorization 的未绑定 session 成功撤销任一设备后会随服务端 generation 一同失效，Rust 必须删除这枚 bearer、保留 `installationId` 与全部本地数据，重新完成 Device Authorization 后再绑定，不能用旧 token 直接重试；Web 未绑定 session 仅在会话状态仍有效时可直接重试。收到 `session_device_mismatch` 时退出这次远端 session 并重新认证，不能替换本地 `installationId` 规避守卫。未绑定设备不启动同步；`installationId` 本身不能当 token。
- Device Authorization 或 OAuth 初始化收到 `auth_capacity_limited` 时保持 `signedOut`，遵守 `Retry-After` 后才允许重新发起并提示服务暂时繁忙；不得清除本地业务数据、outbox 或已有 vault。
- 设备设置允许撤销当前或其他设备。logout 只在服务端 204 确认无有效 session 或撤销已提交后才过期 Web Cookie/删除 Stronghold token；retryable 503、网络错误或结果无法确定时保留凭据并提示重试，不宣称已退出。当前 session 已确认退出或设备被撤销后，本机进入 `signedOut` 或 `reauthenticationRequired`，停止远程同步但保留全部本地模块数据和 intent；重新登录不是新建本地工作区。
- 模块只能调用 `AuthenticatedTransport`，不能读取 OAuth provider token、Better Auth session、Cookie、Bearer、Stronghold 或认证 header。

## 10. 平台、安全与构建

- `build:web` 输出 `dist/web`，使用 Web adapter、HTML5 history 和同源 `fetch`。
- `build:native` 输出 `dist/native`，使用 Tauri adapter、hash history 和窄 Rust command。
- Web bundle 不得导入或条件包含可执行的 `@tauri-apps/*` 调用；平台差异通过构建 alias 选择。
- 构建期 `HAKO_BUILD_ENVIRONMENT` 只允许 `production`、`preview` 或 `local`，并与 Tauri identifier、应用数据目录、Stronghold namespace、Device Authorization client ID 和 `HAKO_SYNC_BASE_URL` 组成不可拆分的受测映射：production 使用 `com.ayingott.hako`，preview 使用 `com.ayingott.hako.preview`，local 使用 `com.ayingott.hako.local`。构建脚本发现任一值不匹配时失败，运行时不能由 Vue、用户设置或远端配置切换环境。
- 原生已认证传输由 Rust HTTP client 实现，只从上述环境映射构造固定 API 地址，不接受 Vue 传入完整 origin；production 和 preview 只允许各自固定的 HTTPS origin，local 只允许服务端环境映射规定的 `http://localhost:8787`，并拒绝跨源重定向。production 值必须等于服务端的 canonical origin；更换该 origin 需要保留旧兼容入口或发布显式客户端迁移，不能静默替换。
- Web 的 origin 天然隔离 Cookie、Passkey ceremony 与 IndexedDB；原生依靠不同 identifier、应用数据目录、Device Authorization client ID 和 Stronghold namespace 隔离。preview/local 构建不得打开 production 的 `hako.db`、读取 production token 或把 production bearer 发往非 production origin；跨环境移动数据只能通过用户确认的模块归档导出和导入。
- Tauri capability 只开放已注册的业务、archive、identity、sync command 和当前构建环境的固定 canonical origin；Opener 在 production/preview 只允许对应 HTTPS URL，在 local 只允许精确的 `http://localhost:8787`，不开放其他 HTTP URL、shell、通用 SQL、通用 HTTP、任意 URL 或任意文件系统范围。首版 Device Authorization 不需要 Deep Link capability。
- production 必须把当前 `csp: null` 替换为仅允许本地资源、Tauri IPC 和明确网络目标的 CSP；不加载远程脚本或 frame。
- PWA 只预缓存版本化应用壳和静态资源；`/api/`、认证和同步响应永不进入 Service Worker cache。
- Web 首次成功持久化业务数据后申请 `navigator.storage.persist()`；拒绝不阻塞使用，但设置页提示模块导出备份。
- 开启云同步前必须说明：首版不是端到端加密，服务提供方能够读取业务数据；服务端 tombstone、幂等 receipt 和 change log 会按服务端规格长期保留，本地“删除”不等于立即物理擦除云端历史。

## 11. 计划文件边界

```text
src/
  app/                         # App.vue、layouts、routes、工具首页
  core/
    identity/                  # Pinia identity store、OAuth/Passkey 状态与设备授权用例
    settings/                  # 应用设置用例与 Core repository port
    sync/                      # 调度器、通用状态机、信封客户端
    modules/                   # ToolModuleDefinition 与静态注册表
  features/<moduleKey>/        # 具体工具拥有的 domain/application/ui/ports
  platform/
    native/                    # Tauri adapter
    web/                       # Browser adapter 与单一 IndexedDB persistence
src-tauri/
  src/persistence/             # 唯一 SQLite pool 与全局 migration runner
  src/core/                    # identity/Stronghold、transport、archive command
  src/modules/<moduleKey>/     # 模块专属 repository command
  migrations/                 # 客户端唯一 SQLite migration 序列
  capabilities/               # 最小权限
shared/
  auth/                        # 不含 Better Auth 类型的 Hako auth/device DTO
  sync/                        # 客户端与服务端共用的通用 wire contract
  modules/<moduleKey>/         # 模块拥有的 wire schema 与纯 validator
```

客户端继续使用根 `package.json`；仓库 workspace、服务端 package 和 lockfile 边界由[服务端技术栈与部署边界](./hako-server-foundation.md#4-服务端技术栈与部署边界)维护。客户端计划新增 Vue Router、Pinia、Better Auth Web client/Passkey client、Tauri Stronghold/Opener/Dialog/Single Instance 的 Rust 侧能力、Rust `sqlx` 与 HTTP client、`idb`、PWA、Vitest、Vue Test Utils 和 IndexedDB 测试实现，实际版本由根 lockfile 固定。Vue 侧不新增 SQL、任意 HTTP 或 Stronghold 的通用 guest API。

## 12. 可独立合并的实施阶段

### 阶段零：应用壳与本地模块平台

交付 Router、Pinia、工具首页、设置页、静态模块注册表、每环境单一本地数据库、Core/模块逻辑仓储契约、全局 migration runner、Web/native 构建分流、PWA 和失败隔离。阶段零只创建当前离线功能需要的 Core 与业务对象，不创建 outbox、cursor、lease 或其他同步对象。合并后 Hako 已是可离线运行的工具箱壳，Fuel 等模块可独立接入。

### 阶段一：认证客户端纵向切片

交付 Web GitHub OAuth session adapter、原生 Hako Device Authorization + Stronghold、系统浏览器 Opener、“GitHub owner 身份确认 → 明确批准原生设备”流程、`IdentityPort`、设备绑定/撤销、同步设置与状态。GitHub OAuth 不标记为近期强认证。缺少服务端地址时同步入口明确显示“未配置”，本地工具仍完整可用；只有在[服务端认证纵向切片](./hako-server-foundation.md#阶段一认证纵向切片)部署后才开放登录。

### 阶段二：Passkey

交付 Web 端“十分钟内签发的一次性 GitHub owner 身份确认 proof → Passkey 登记”的完整流程与 Passkey 删除/登录；经服务端确认 UV 的 Passkey 可作为原生设备批准的近期强认证，并在可用时作为默认批准方法。Passkey 失败或 GitHub 不可用时不得影响本地工具。

### 阶段三：同步客户端 Core

客户端第一次打开阶段三版本时，以全局 migration 在既有本地数据库中加入 `sync_` 逻辑对象，并把可同步模块初始化为 `localOnly`；该 schema migration 不等待用户开启同步。随后按第 7.2 节交付持久 bootstrap 状态机，以及 `AuthenticatedTransport`、outbox contract、最多 5 条的 private beta batch、调度器、Web lease、epoch recovery 和模块同步状态。只有服务端 Fuel private sync beta 可用后才开放远程开关。

阶段零不依赖后续阶段；认证、Passkey 和同步阶段都不得迁移或删除既有模块业务数据。preview、后台免解锁、跨模块通用化和完整发布 hardening 属后续独立阶段。

## 13. 验证与验收

自动化测试按已进入的实施阶段递增；阶段三固定 Fuel payload v1，不要求提前通过下列多版本测试，两个版本 409、旧 payload 重放和混合版本 change 只在首次真实 payload v2 前成为门禁。最终目标自动化测试必须覆盖：

- 注册表在构建期和开库前拒绝重复 key、route、非法或重复 persistence namespace，以及 `core`、`sync`、`sqlite` 保留值；SQLite 与 IndexedDB 物理对象名只从 canonical namespace 派生。一个模块仓储初始化失败不阻止 Router、设置和其他模块。
- App 启动不等待网络、登录或 vault 解锁；打开一次本地数据库后按需初始化模块，不为每个模块等待独立数据库。
- Web/native 使用相同 route name；Web 深链接刷新成功，原生 hash 路由重启成功。
- Core、Identity、Sync Pinia Store 不保存业务实体或 secret，Store action 无循环依赖。
- SQLite 与 IndexedDB 的类型化仓储 contract 一致；阶段零无需同步对象即可完整 CRUD，阶段三的每次 CRUD 都在同一事务读取持久 bootstrap 状态，启用同步后业务写入和 outbox 同时提交或回滚。
- 桌面第二实例不能打开 `hako.db` 或启动第二轮同步；Web 旧标签收到 `versionchange` 后停止全部本地写入并关闭共享连接，升级端从 `blocked` 恢复。
- 未冻结 create→delete 取消远端 mutation，已同步 update→delete 合并为正确 base revision 的 delete；成功回执正确重建 successor。
- 一个模块的仓储初始化或本地业务数据解码失败不停止 Router、设置和其他模块；422/426、wire payload、协议或同步失败只暂停对应模块同步，该模块本地 CRUD 继续可用。全局 migration 故障则保持最近一个完整 schema、停止全部持久化模块和同步，并让应用壳显示可诊断的降级状态。
- 从阶段零升级到阶段三时，新增同步对象的 schema migration 全有或全无。模块 bootstrap 按实体数和 payload 字节数分批；应用在任一 batch 提交前或提交后终止，重启后都无需用户操作即可从唯一已提交 checkpoint 继续。checkpoint 前后的新增、编辑、删除，两个 bootstrap worker 的条件提交，以及 `bootstrapping` 到 `enabled` 边界两侧的 CRUD，都不能漏掉 active 实体、改变已有 mutation ID、为已删除实体保留 create intent、重复生成 intent 或覆盖较新的 payload；`enabled` 前远端 pull、push 均为零。
- 两个受 coordinator 管理的 native Fuel command 并发修改同一里程序列时，任一时刻只能有一个进入第一次读取；后进入者必须等待前一个提交，再按最新序列得到领域拒绝或合法提交，不能形成非法序列或向 UI 暴露 `SQLITE_BUSY`。
- 使用 coordinator 外的独立 SQLite connection 或确定性故障注入，分别在 `BEGIN IMMEDIATE`、业务 DML 和 `COMMIT` 产生 `SQLITE_BUSY`/`SQLITE_LOCKED`；测试必须核验每个连接的固定 `busy_timeout`、失败事务先回滚、整个 use case 从第一次读取重跑，以及重试耗尽后返回 retryable persistence error 且零部分写入。只重试失败 statement 或 `COMMIT` 的实现不得通过。
- 应用持续处于前台时，两个服务端版本 409 都按 `Retry-After` 自动探测并在服务端开放后恢复；`auth_maintenance` 暂停全部远程同步，`module_maintenance` 只暂停目标模块。
- 多标签 lease 过期后，旧 fencing generation 不能提交网络响应。
- in-flight mutation 重启后原样重试，successor 不被旧回执覆盖。
- 新模块先省略 `after` 从 seq `0` 完整 pull 并取得 epoch，再 push；正常轮次 pull 到 `hasMore=false`。
- 新客户端能原样重试旧 payload 版本的冻结 mutation，按 `mutationId` 关联逐项结果，并读取混合版本 change/conflict snapshot；纯本地模块不伪造 payload 版本。
- epoch reset 不重复 create intent，不自动重交曾被服务端确认但在回档后缺失的实体；旧设备不能复活其他设备已确认删除的数据。
- 回档前后两个 epoch 出现相同 entity revision 但不同 payload 时，旧 shadow 只保留为证据；当前投影、冲突决策和 successor 只使用新 epoch snapshot 或 missing marker。
- vault 锁定、401、GitHub OAuth/Worker 不可用和离线时本地工具正常使用。
- Web OAuth callback 重放或响应丢失后能通过 session 状态收敛；`identity_not_allowed` 返回 `signedOut` 并显示身份不被允许，不进入同步重试。原生 Device Authorization 正确处理 pending、slow-down、WAF/binding 429、过期、拒绝和 token 交付失败；429 在原 expiry 内保留易失 `device_code` 并按 header 或十秒 fallback 重试，其他终态失败后可重新发起且不重复生成本地 intent。
- 原生设备批准缺少十分钟内签发的 action proof，或 proof 已过期、消费过、属于其他 session/purpose/attempt 时，不改变 code/attempt；没有 Hako Cookie 的全新浏览器也能从同一 `user_code` 完成 GitHub owner 身份确认，阶段二后已有 owner Passkey 时也可完成 UV Passkey，再返回同一批准页。两种方法在界面与状态中不得都标为强认证。Rust 沿用同一份易失 `device_code` 继续轮询，不创建第二个授权流程。
- Passkey 登记只在十分钟内签发的 `github_oauth_identity` action proof 后进行；该 proof 不宣称 GitHub credential 刚刚重新验证。普通 Passkey session、原生 Bearer、过期或已消费 proof、错误 origin/RP ID/challenge 全部失败，Passkey 私钥从不进入本地数据库。operator recovery 后历史 subject 的全部 Passkey 都失效，只能由当前 GitHub owner 重新登记。
- `AuthenticatedTransport` 和模块 wire DTO 均没有可写的 `applicationId`、`accountId` 或当前会话 `deviceId`；Web Cookie 与原生 Bearer 得到的账户身份只能由服务端会话推导，客户端伪造同名 JSON 字段也不能改变远端账户作用域。`IdentityPort` 只允许把服务端 `DeviceSummary.id` 用作设备列表或撤销的资源 ID，并验证它从不进入同步 DTO 或 principal 派生。
- 原生秘密 `device_code` 和 access token 在授权、解锁和同步过程中从不返回 WebView，Vue 只取得 `user_code` 与 verification URL；除 Rust 轮询的 `/device/token` 标准 JSON 外，Web 认证响应的 header/body 既不暴露 Cookie 内容、`set-auth-token`、顶层 `token` 或 `session.token`，Vue 只从 Hako 会话摘要取得脱敏状态。
- PWA 离线冷启动成功，API/认证响应不在 Cache Storage 中。
- production bundle 不包含错误平台 adapter，Tauri capability 与 CSP 不开放通用特权。
- production、preview 和 local 构建的 identifier、数据目录、Device Authorization client ID、Stronghold record 与固定 origin 精确匹配；local Opener 必须端到端打开服务端映射中的 `http://localhost:8787` Device Authorization verification URL，`127.0.0.1`、其他 HTTP URL 或任意跨环境 origin/RP ID 组合必须在打开前失败。把 production vault 放到 preview 路径时，preview 不能读取或发送其中的 token；把带有 production 标记、业务数据和 outbox 的 `hako.db` 放到 preview 路径时，preview 必须在 migration 和任何 Core/模块读取前拒绝打开，不显示其中数据、不修改文件且不发送 intent。构建参数混搭必须失败。

实施后至少提供并通过：

```text
pnpm test
pnpm build:web
pnpm build:native
cargo check --manifest-path src-tauri/Cargo.toml
```

macOS、iOS 模拟器和 Android 模拟器在本机 smoke test；Windows 与 Linux 由对应系统 CI runner 构建。未实际运行的平台必须明确标注，不能以交叉编译代替验证。

## 14. 回滚与最脆弱假设

- 应用壳可以隐藏新模块入口回滚，但不得自动删除本地 Hako 数据库中的 Core 或模块逻辑数据。
- 同步客户端可以关闭全局入口回滚，但必须保留 outbox、冲突和模块实体。
- migration 只向前修复；旧版本遇到新 schema 进入只读或拒绝打开，不自动 down migration。

本地单库方案的最脆弱假设是各模块规模仍适合共享同一 SQLite/IndexedDB 生命周期。只有出现可测量的文件级恢复隔离、不同清理生命周期或单模块数据规模压力时，才另写物理拆库迁移规格；“以后可能有更多模块”本身不构成拆库理由。

本方案假设 Hako 保持单 owner 个人工具，[服务端定义的 GitHub owner identity](./hako-server-foundation.md#61-owner-与账户边界)、production canonical origin 和 Passkey RP ID 能长期保持稳定。若未来需要公开注册、多账号或共享工作区，必须先重写身份上下文、所有服务端表、cursor 和模块数据所有权规格，不能只开放注册页面；是否拆仓仍只按[服务端拆分门禁](./hako-server-foundation.md#1-决策需要服务端但暂不拆仓)判断。

## 15. 参考资料

- [Vue Router](https://router.vuejs.org/)
- [Pinia](https://pinia.vuejs.org/)
- [Tauri Stronghold 插件](https://v2.tauri.app/plugin/stronghold/)
- [Tauri Opener 插件](https://v2.tauri.app/plugin/opener/)
- [Tauri Dialog 插件](https://v2.tauri.app/plugin/dialog/)
- [Tauri Single Instance 插件](https://v2.tauri.app/plugin/single-instance/)
- [Indexed Database API 3.0](https://www.w3.org/TR/IndexedDB/)
- [Better Auth Passkey](https://better-auth.com/docs/plugins/passkey)
- [Better Auth Device Authorization](https://better-auth.com/docs/plugins/device-authorization)
- [RFC 8628 OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628)
- [Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)
