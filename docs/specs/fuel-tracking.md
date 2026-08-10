# 临时规格：加油统计模块

> 状态：待确认
>
> 创建日期：2026-08-10
>
> 适用版本：Hako `0.0.0` 之后的首个业务模块
>
> 前置规格：[客户端共享基建](./hako-client-foundation.md)与[共享同步服务端](./hako-sync-server.md)
>
> 单一事实来源：本文只定义 Fuel 业务、模块 UI、模块数据、归档和 Fuel 同步适配器；平台、本地同步算法、认证、HTTP 和 Cloudflare 运维不在本文重复定义。
>
> 临时性：属于同一临时规格组，统一清理门禁见[文档索引](../index.md#临时规格)。

## 1. 目标

在 Hako 工具箱中增加“加油统计”模块：管理多辆燃油车和加油记录，使用“加满到加满”方法计算真实油耗，并在六个平台离线可用、联网后通过共享同步基建最终收敛。

成功标准：

- 多辆车的数据、统计和操作互相隔离。
- 相同记录在六端得到完全相同的统计结果。
- 没有网络或同步身份时，车辆及记录 CRUD 完整可用。
- 同步不同记录可自动合并，同一记录并发修改不静默覆盖。
- Fuel 失败、停用或清空不登出 Hako，也不影响其他工具。

## 2. 模块注册

Fuel 向客户端静态注册表提供：

| 字段 | 固定值 |
| --- | --- |
| `moduleKey` | `fuel` |
| `displayName` | `加油统计` |
| `routePath` | `/tools/fuel` |
| `persistence` | 原生 `hako-fuel.db`；Web IndexedDB `hako-fuel` |
| `syncAdapter` | 阶段一为 `null`；阶段二注册 `FuelSyncAdapter` |
| `archiveAdapter` | `FuelArchiveCodecV1` |

Fuel 首页是工具内部入口，不替代 Hako 工具首页。注册、初始化和路由规则以[客户端模块契约](./hako-client-foundation.md#5-编译期工具注册表)为准。

## 3. 产品范围

### 3.1 首版包含

- 车辆新增、编辑、删除和切换。
- 加油记录新增、编辑、删除和倒序列表。
- 单车累计加油量、累计支出、加油次数、加权平均油价、有效区间里程、综合油耗、最近油耗和综合百公里费用。
- 固定单位：公里（km）、升（L）、人民币（CNY）、升/百公里（L/100 km）。
- Fuel 模块 JSON 导入导出。
- Fuel 待同步数量、冲突 badge 和 Fuel 冲突对比界面。

### 3.2 首版不包含

- 充电、保养、保险、提醒、OCR、照片、油站地图、联网油价、图表或预测。
- 英里、加仑、MPG、多币种或汇率换算。
- CSV 导入导出或向非空 Fuel store 覆盖导入。
- 已删除车辆或记录的恢复；需要时使用新 ID 重新创建。
- 共享车辆、协作编辑和用户权限。
- 内置二维码、Deep Link 或设备管理。
- Fuel 自己实现 credential、网络 transport、同步调度或云端部署。

## 4. 领域模型与校验

所有实体 ID 使用客户端生成的 UUID v4，使用后不得复用。持久化数值使用整数，权威计算不得使用二进制浮点数。`serverRevision`、tombstone、outbox 状态等属于同步投影，不进入纯领域对象或归档。

### 4.1 `Vehicle`

| 字段 | 类型与约束 |
| --- | --- |
| `id` | UUID v4，必填 |
| `name` | 去除首尾空白后 1 至 80 个 Unicode 字符，不要求唯一 |
| `plateNumber` | `null` 或去除首尾空白后的 1 至 32 个字符 |
| `createdAt` | RFC 3339 UTC 时间，创建后不变 |
| `updatedAt` | RFC 3339 UTC 时间 |

删除车辆必须二次确认并立即完成本地事务，不等待网络。从未冻结 create 的车辆及其从未冻结子记录直接取消 intent 并移除 active 投影，不生成远端 tombstone；已经同步或存在 in-flight 的车辆按第 7 节建立删除快照、车辆及已同步子记录 tombstone。首版不提供面向用户的常规恢复入口。

### 4.2 `FuelEntry`

| 字段 | 类型与约束 |
| --- | --- |
| `id` | UUID v4，必填 |
| `vehicleId` | 指向未删除车辆的 UUID，创建后不可修改；移动车辆需删除后重新创建 |
| `fueledAtEpochMs` | `0` 至 `253402300799999` 的整数 UTC 毫秒 |
| `fueledAtOffsetMinutes` | `-720` 至 `840` 的整数，保留录入时区偏移 |
| `odometerMeters` | `1` 至 `9999999999` 的整数；界面以 km 输入，最多 3 位小数 |
| `fuelMilliliters` | `1` 至 `1000000` 的整数；界面以 L 输入，最多 3 位小数 |
| `totalCostCents` | `0` 至 `100000000` 的整数；优惠后实际支付金额，界面最多 2 位小数 |
| `tankFilled` | 布尔值；油箱确实加满时为 `true` |
| `resetsConsumptionChain` | 布尔值；此前存在漏记、里程表重置或其他断链时为 `true` |
| `note` | `null` 或去除首尾空白后的 1 至 500 个字符 |
| `createdAt` | RFC 3339 UTC 时间，创建后不变 |
| `updatedAt` | RFC 3339 UTC 时间 |

同一车辆按 `fueledAtEpochMs`、`createdAt` 解析后的 UTC instant、`id` 升序处理，禁止按带时区偏移的 RFC 3339 字符串做字典序排序。

相邻 active 记录未被 `resetsConsumptionChain` 隔开时，里程不得下降；历史插入、编辑和删除必须模拟变更后的完整相邻序列。里程相同的部分加油允许保存；与当前未断开的加满基线里程相同的新加满记录在 `resetsConsumptionChain=false` 时拒绝，在 `true` 时成为新基线。

保存请求未结束前禁用重复提交，数据库主键约束作为最终防线。

## 5. 油耗与费用计算

### 5.1 有效区间

设前一次有效加满记录为 `F0`，后一次加满记录为 `F1`。如果两者之间没有重置且 `F1.odometerMeters > F0.odometerMeters`：

```text
区间里程 = F1 里程 - F0 里程
区间耗油 = F0 之后、F1 及之前所有记录的加油量之和
区间油耗 = 区间耗油 / 区间里程 × 100
区间费用 = F0 之后、F1 及之前所有记录的实际支付金额之和
区间百公里费用 = 区间费用 / 区间里程 × 100
```

`F0` 自身油量和费用不进入该区间。第一条加满记录只建立基线；中间部分加油全部累计到下一条加满。

处理 `resetsConsumptionChain` 时先清除旧基线，再处理当前记录：当前记录若加满则成为新基线，未加满则等待之后第一条加满建立基线。没有有效区间时显示“暂无有效油耗”，不能显示 `0`。

删除 `resetsConsumptionChain=true` 的记录会删除断链边界并完整重算。删除前模拟剩余序列：若失去边界造成里程下降则拒绝删除，要求先把 reset 设置到下一条记录或删除受影响记录；其余情况允许删除并提示区间可能重新连接。首版不自动转移 reset。

### 5.2 汇总

- 累计加油量：全部未删除记录的油量之和。
- 累计支出：全部未删除记录的实际支付金额之和。
- 加油次数：全部未删除记录数量。
- 加权平均油价：累计支出 ÷ 累计加油量。
- 有效区间里程：全部有效区间里程之和。
- 综合油耗：全部有效区间耗油之和 ÷ 全部有效区间里程之和 × 100。
- 最近油耗：结束时间最晚的有效区间油耗。
- 综合百公里费用：全部有效区间费用之和 ÷ 全部有效区间里程之和 × 100。

综合油耗禁止对各区间油耗做算术平均。累计加油量为零时平均油价显示“暂无”；有效区间里程为零时，综合油耗、最近油耗和综合百公里费用均显示“暂无”，不得产生 `0`、`NaN` 或 `Infinity`。

统计结果永不持久化、归档或同步，始终从当前 active 车辆和记录的稳定排序快照重新计算。

聚合与比例把整数存储值转为 `bigint` 分子和分母；展示使用十进制 `ROUND_HALF_UP`：油耗和百公里费用 2 位、平均油价 3 位、油量 3 位、金额 2 位。舍入中点：33.300 L / 400 km 的 8.325 显示 8.33；¥1.00 / 16.000 L 的 ¥0.0625/L 显示 ¥0.063/L。

### 5.3 固定样例

车辆 A：

1. 10,000 km，加满 40 L，支付 ¥320：只建立基线。
2. 10,300 km，部分加油 20 L，支付 ¥164。
3. 10,600 km，加满 30 L，支付 ¥249。

结果：区间里程 600 km、区间耗油 50 L、油耗 8.33 L/100 km、区间费用 ¥413、百公里费用 ¥68.83；三次平均油价为 `¥733 ÷ 90 L = ¥8.144/L`。

再增加 11,000 km、加满 36 L、支付 ¥306 后，第二段油耗为 9.00 L/100 km；综合油耗必须为 `(50 + 36) ÷ (600 + 400) × 100 = 8.60 L/100 km`。

## 6. 模块用户界面

Fuel 路由内包含：

- 车辆选择和管理入口。
- 汇总卡片：累计支出、油量、次数、平均油价、有效区间里程、综合油耗、最近油耗和综合百公里费用。
- “添加加油记录”主操作。
- 时间倒序记录列表，显示时间、里程、油量、金额、加满/部分加油和断链状态。
- 记录编辑、删除入口。
- Fuel 待同步数量和冲突 badge；认证、配对和设备管理跳转全局设置。

桌面宽屏在模块内显示车辆侧栏，窄屏和移动端使用顶部车辆选择器；能力一致。模块 route view 只负责组合，表单、汇总和记录列表分别为聚焦组件。

表单默认：

- 车辆为当前车辆。
- 加油时间为当前本地时间。
- “已加满”默认开启。
- 里程提示上一条值但不自动填写。
- “重置油耗计算链”默认关闭，并解释漏记和里程表重置用途。
- 校验或持久化失败时保留输入且不关闭表单。

必须覆盖：无车辆、车辆无记录、只有一个加满基线、未闭合部分加油、正常统计、数据加载失败、保存失败、Fuel 待同步、Fuel 同步中、Fuel 已同步、Fuel 离线、Fuel 冲突和 Fuel 暂时失败。全局 `unpaired`、`locked`、`credentialInvalid` 由 App Shell 显示，Fuel 不复制身份状态机。

## 7. Fuel Repository 与本地数据

`FuelRepository` 由 Fuel 应用层拥有，至少提供：

- 车辆与记录的列表、按 ID 读取、新增、编辑和删除。
- 单事务车辆级联删除。
- 变更前后的相邻里程、reset 和同里程加满校验。
- 获取用于统计的稳定排序快照。
- Fuel store 是否为空、归档导入和同步 bootstrap。

每次会影响里程序列的本地写入都必须在同一个 SQLite/IndexedDB read-write transaction 中读取该车稳定序列、运行校验并提交实体与 outbox；不能在事务外预读后再写。这样同进程或 Web 多标签的两个操作也只能基于先后提交的序列裁决。

平台实现遵循[客户端本地持久化边界](./hako-client-foundation.md#7-本地持久化边界)。Fuel store 的业务表固定为：

| 表或 object store | 用途 |
| --- | --- |
| `vehicles` | 车辆 active 投影及持久化 metadata |
| `fuel_entries` | 加油记录 active 投影及持久化 metadata |
| `pending_cascade_deletions` | 车辆远端删除 barrier 完成前的快照、远端 shadow 及暂停 intent |

通用 outbox、cursor、conflict、recovery shadow 和 Web lease 由 Core contract 定义，但物理存放在 Fuel store 内。

首次启用 Fuel 同步时，按“车辆在前、加油记录在后”为全部 active 实体生成 create intent；bootstrap 和版本标记处于一个 Fuel store 事务，失败可完整重试。bootstrap version 与 module payload schema version 分开保存，不使用全局布尔值。

删除已同步或存在 in-flight 的车辆使用 Fuel 远端发送 barrier，但本地删除立即完成：

1. 在一个本地事务中保存删除前快照、把同车既有 Fuel conflict shadow 合并进远端 shadow、隐藏 active 车辆和子记录、建立必要 tombstone，并把同车未冻结 intent 移入 `pending_cascade_deletions`；此步骤不等待 in-flight 或网络。
2. 已冻结 in-flight 保持原样直到取得 `applied`、`conflict` 或 `rejected` 终态；`applied` 只更新删除快照中的已确认 revision，携带服务端 snapshot 或 tombstone 的 `conflict` 原子并入远端 shadow，`rejected` 保留原 intent 和错误证据，三者都不把实体重新显示到 UI。
3. barrier 存在期间，pull 到该车辆或其任一子记录的 change 都写入删除快照的远端 shadow，不写回 active 投影；change、shadow 和 cursor 必须在同一个 Fuel store 事务中提交。服务端车辆 tombstone 只设置 `remoteDeleteConfirmed` 并取消未冻结的 vehicle delete successor，不能提前丢弃仍需取得终态的冻结 mutation。
4. 同车全部 in-flight 已终结后，若 `remoteDeleteConfirmed=false`，才用最新 vehicle revision 冻结并发送尚未冻结的 vehicle delete successor；子记录不另发 delete，由服务端级联。
5. 本端 vehicle delete 取得 `applied`，或 `remoteDeleteConfirmed=true` 且全部冻结 mutation 已取得终态后，才丢弃远端 shadow 并清理快照；revision conflict 时继续保留。
6. 用户选择服务端版本时，在一个事务中以每个实体最高 revision 的远端 shadow 更新删除前快照，按车辆在前、子记录在后的顺序恢复仍 active 的内容，重新校验被暂停 intent，再基于最新 revision 同步。

这是通用 outbox 冲突处理的 Fuel 级联删除特例：用户已确认删除整个车辆时，既有 update/子记录终态只用于完成 barrier。若尚未确认的 vehicle create 返回 `conflict` 或 `rejected`，客户端没有权力删除碰巧使用同一 ID 的服务端车辆，必须停止 delete 并把快照转入显式冲突。

## 8. Fuel JSON 归档

归档格式：

- `format`: `hako-fuel-archive`
- `version`: `1`
- `exportedAt`: RFC 3339 UTC 时间
- `vehicles`: active 车辆完整领域字段
- `fuelEntries`: active 加油记录完整领域字段

归档不含持久化 metadata、credential、vault、outbox、cursor、冲突或服务端审计字段。导出前等待 Fuel 当前事务结束，并提示尚未同步的本地修改也包含在归档中。

导入只允许 Fuel 模块不存在 active/tombstone、待同步 intent、pending cascade 或冲突；其他 Hako 模块是否有数据不影响。先完整验证格式、版本、ID、引用和字段，全部有效后在一个 Fuel store 事务中写入；任一错误零写入。启用同步时，导入实体按正常 create intent 进入 outbox，不能直写服务端。

Fuel 只实现 `FuelArchiveCodecV1`；文件读取、保存位置和权限以客户端 `ArchiveFilePort` 为准。

## 9. Fuel 同步接入

Fuel 实现客户端 `SyncModuleAdapter` 和服务端 `FuelSyncHandler`，使用[通用模块同步协议](./hako-sync-server.md#7-模块同步协议-v1)，不自建 transport 或身份认证。

### 9.1 wire schema

- `moduleKey`: `fuel`
- `moduleSchemaVersion`: `1`
- `entityType`: `vehicle` 或 `fuelEntry`
- create/update payload：对应领域对象的完整快照。
- delete payload：`null`。
- 服务器 revision、tombstone 和 change metadata 由通用信封承载。

Fuel 服务端 registry 首版固定为 `supportedChangeSchemaVersions={1}`、`supportedPushSchemaVersions={1}`；FUEL_DB metadata 固定为 `activeChangeSchemaVersion=1`、`acceptedPushSchemaVersions={1}`、`requiredReadableChangeSchemaVersions={1}`。以后按共享服务端的版本升级契约分阶段扩展和激活。

Fuel 稳定业务错误码：

- `parent_vehicle_deleted`
- `mileage_order_violation`
- `invalid_fuel_payload`

### 9.2 Fuel D1

`FUEL_DB` 除通用 `sync_metadata`、`mutation_receipts` 和 `changes` 外包含：

| 表 | 关键数据 |
| --- | --- |
| `vehicles` | 完整车辆字段、revision、tombstone、审计时间和最后 mutation ID |
| `fuel_entries` | 完整记录字段、vehicle ID、revision、tombstone、审计时间和最后 mutation ID |
| `vehicle_constraint_versions` | 每辆车的约束 revision 和最近 write nonce，用于串行化会影响里程序列的 mutation |

纯 TypeScript validator 只负责使用同一份 fixture 做预检；D1 最终仲裁使用每车 constraint CAS：

1. handler 读取目标车辆的 constraint revision、目标实体 revision 和完整 active 记录序列，再运行共享 validator。
2. 为本次尝试生成随机 write nonce；`D1Database.batch()` 的第一条条件 DML 仅在 constraint revision 未变化时将其递增并写入 nonce。
3. 此后的实体、tombstone、change 与 receipt 语句全部以该 nonce 和预读 entity revision 为条件；CAS 未命中时这些语句必须零写入，不能留下 receipt。
4. batch 完成后检查 guard、目标实体、change 与 receipt 的 affected rows；任一不符合预期即不报告成功。CAS 竞争最多重新读取并校验三次，仍竞争则本次 HTTP push 请求返回 503 `constraint_contention`、`retryable=true`，客户端原样重试冻结批次；同批此前已提交的 mutation 不回滚，并由通用 receipt 重放保护。
5. 所有 FuelEntry create/update/delete 和 vehicle delete 都必须经过该 guard；vehicle create 在同一 batch 初始化 guard。这样两个设备修改不同记录也不能绕过跨记录里程约束。

在上述原子边界内，Fuel handler 还必须：

- 验证父车辆存在且未删除。
- 模拟 create、update 或 delete 后同车 active 序列，校验里程、reset 和同里程加满规则。
- 删除车辆时 tombstone 车辆及全部子记录，先按稳定 ID 顺序写子记录 delete change，最后写车辆 delete change。
- 使用 first-committer-wins；只有 `baseRevision == currentRevision` 的 update/delete 接受。
- 子记录先更新、车辆后删除时删除覆盖子记录；车辆先删除时后续子 mutation 返回 `parent_vehicle_deleted`。

Fuel 业务 validator 的纯规则实现放在 `shared/modules/fuel/`，客户端与服务端运行相同 fixture；D1 条件写入和约束仍是服务端最终防线。

### 9.3 Fuel 冲突

- 不同实体在不破坏父子、里程和 reset 规则时自动合并。
- 同一实体并发修改时保留本地尝试值与服务端完整值，停止该实体后续 push。
- “使用服务端版本”丢弃本地 intent 并应用服务端值。
- “保留此设备版本”基于最新 revision 使用新 mutation ID 重交本地完整值。
- 服务端已删除时删除优先；如需内容必须以新 ID 创建，不能复活 tombstone。
- pull 遇到同一实体 pending/in-flight 时不覆盖本地值，保存为 Fuel conflict shadow；子记录的父车辆存在 pending cascade 时，按第 7 节写入该删除快照的远端 shadow。
- 跨记录业务约束失败时保留 intent，并在 Fuel UI 指出具体相邻记录和修正动作。

## 10. 可独立合并的实施阶段

### 阶段一：离线 Fuel 模块

交付模块注册、车辆/记录 CRUD、计算、Fuel Repository、SQLite/IndexedDB adapter、模块 UI、JSON 归档和自动化测试。合并后六端均可完整离线使用，不依赖服务端。

### 阶段二：Fuel 同步接入

在客户端共享同步 Core 和服务端通用协议可用后，交付 Fuel adapter、Fuel handler、FUEL_DB migrations、级联删除 barrier、冲突 UI 和端到端测试。同步不可用时阶段一能力不降级。

## 11. 计划文件边界

```text
src/features/fuel/
  domain/                       # 模型、校验、计算；纯 TypeScript
  application/                  # 用例和 view model
  ports/                        # FuelRepository、FuelArchiveCodec
  persistence/                  # 模块 store schema 与 bootstrap
  sync/                         # FuelSyncAdapter、冲突 renderer
  ui/                           # route view、表单、汇总、列表
src-tauri/src/modules/fuel/     # 窄 repository command
src-tauri/migrations/fuel/      # Fuel SQLite migrations
shared/modules/fuel/            # wire schema 与共享业务 validator
server/src/modules/fuel/        # FuelSyncHandler 与 D1 repository
server/migrations/fuel/         # FUEL_DB migrations
tests/fixtures/fuel/            # 六端和服务端共享的固定样例
```

## 12. 验证与验收

领域测试：

- 第一条加满只建立基线；多次部分加油正确累计到下一次加满。
- 固定样例得到 8.33、9.00 和综合 8.60 L/100 km。
- 编辑/删除基线、中间加油和结束加满后正确重算或失效。
- reset、同里程加满和删除 reset 的合法/非法序列符合第 4、5 节。
- 多车隔离、最大整数、非法小数位、负数、零油量和无效父车辆正确处理。
- 8.325 与 0.0625 使用 `ROUND_HALF_UP` 显示 8.33 和 0.063。

仓储与 UI 测试：

- SQLite 与 IndexedDB 通过相同 Fuel Repository contract suite。
- 车辆级联删除、归档导入和同步 bootstrap 全有或全无。
- 统计只从 active 记录重算，不写入 store、归档、outbox 或 wire payload。
- 导入只检查 Fuel store；其他模块数据不阻止导入。
- 无车辆、无记录、单基线、未闭合部分加油、失败和冲突状态均可操作且无错误统计。
- App Shell 从工具首页进入 Fuel，Fuel 初始化失败时可返回首页并继续使用设置。

同步与服务端测试：

- 相同 Fuel fixtures 在客户端和服务端 validator 结论一致。
- 不同记录合并，同一记录并发产生可解决冲突。
- 车辆删除传播全部子 tombstone，stale 子更新不能复活车辆。
- 本地存在 in-flight 且离线时删除车辆立即从 UI 完成，远端 vehicle delete 只在 barrier 就绪后发送。
- 本地车辆删除处于 barrier 或 revision conflict 时，另一设备新建的子记录进入远端 shadow，cursor 正常推进；确认删除后丢弃，选择服务端版本后随快照恢复。
- 已有 Fuel conflict shadow 后删除车辆，或 vehicle delete conflict 后立即选择服务端版本时，恢复使用最新服务端 snapshot，而不是删除前的旧快照。
- 冻结 mutation 的响应丢失且先 pull 到远端 vehicle tombstone 时，保留删除快照直到重试取得全部终态，再完成清理。
- 两个并发 mutation 分别把相邻里程改成单独合法、合并非法的值时，每车 constraint CAS 最多接受一个；失败方重读后被拒绝或重试。
- 删除发生 conflict 并选择服务端版本时，快照和暂停 intent 完整恢复。
- 业务 rejected 回执丢失后重试仍返回首次终态。
- Fuel D1 epoch 轮换只触发 Fuel recovery，不影响身份和其他模块。

手工验收：

- 六端分别新增多辆车和记录，重启后数据与统计一致。
- 断网完成 CRUD，联网后无需手工点击即可同步。
- 两台设备修改不同记录自动合并；修改同一记录出现对比并能收敛。
- 一端删除车辆、另一端离线编辑子记录时车辆和子记录不复活。
- JSON 导出不含 credential，空 Fuel store 导入后统计一致。

## 13. 回滚与最脆弱假设

- 可以隐藏 Fuel 工具入口回滚，但保留 `hako-fuel` store 和归档恢复路径。
- 可以关闭 Fuel 服务端 handler 和客户端 sync adapter，但不得清空 outbox、冲突或实体。
- Fuel schema migration 只向前修复；模块移除先停止同步和提供导出，数据清理由单独授权完成。

本模块假设用户准确录入里程并正确标记“已加满”。若假设不成立，费用、加油量和平均油价仍可靠，但真实油耗无法成立；表单必须解释“已加满”用于闭合区间，并保留明确的计算链重置操作。

## 14. 参考资料

- [客户端共享基建](./hako-client-foundation.md)
- [共享同步服务端](./hako-sync-server.md)
