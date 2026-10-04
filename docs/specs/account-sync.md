# 账号数据隔离与最小同步

状态：同步协议 **v2（文档代次）已实现、未部署**，随[恢复设计](./restore.md)的交付 A「代次兼容基础」引入本仓库；生产仍运行 v1。v1 的首次实现已随 [PR #11](https://github.com/LoTwT/hako/pull/11) 合并并部署，首轮核心真实协作验收通过；精确候选、读回时间、观察来源及未验项统一见[同步发布与验收记录](../releases/2026-10-03-sync.md)。本文件是账号存储、旧验证记录首次接入和同步确认语义的唯一合同；登录协议引用[登录规格](./eruoo-login-integration.md)，页面门禁与业务规则引用[重新设计](./redesign.md)，文档代次与恢复流程的完整规则见[加油文档恢复设计](./restore.md)。

## 本切片范围与审阅分组

1. 服务端账号标识、文档存储与 HTTP 同步：既有 SQLite DO 内新增表，保留登录事务、会话及 DO 实例。可独立审阅授权、持久化和协议测试。
2. 账号本机副本、主动导入与前台调度：以第一组合同为基础，验证 IndexedDB、版本确认、重试和旧库保留。
3. 页面接线及双副本验收：登录门禁下装配账号副本；表单首次进入才挂载，隐藏实例保留草稿、写入与锁。附本地实际 Worker/DO 与两个浏览器存储上下文的证据。

这些是 PR #11 的依赖顺序与审阅分组；代码以一个连贯的同步切片交付，随后部署及真实协作验收由发布记录维护。真实旧记录导入未执行；统计、AI 与完成码不在本切片范围。独立 R2 备份已于 2026-10-04 实现、部署并完成首份真实备份读回（见[发布记录](../releases/2026-10-04-independent-backup.md)），技术合同见[独立备份合同](./backup.md)。本次文档收尾不修改产品规则或执行远端操作。

## 账号与授权

- 服务端仍只接受配置的 owner，身份键为固定 `(issuer, subject)`。继续使用 `HAKO_ACCOUNT`、`HakoAccountDurableObject` 和固定实例 `owner-account`；不重命名或新建 namespace。
- 有效会话第一次读取时，在独立 `account_data_ids` 表中为身份生成随机 UUID v4。`GET /api/auth/session` 返回 `{ authenticated: true, accountId }`；匿名响应保持 `{ authenticated: false }`。账号标识不从 subject 哈希或编码得到，不是凭证。
- 映射由服务端有效会话建立；客户端不能指定身份或认领 owner。配置 owner 改变后，旧会话失效，新身份得到独立账号标识与文档，旧数据保留。映射表属于身份存储，真实 subject 不进入浏览器、Loro 业务文档或日志。
- 同步只在有效 Cookie、精确 Origin 和协议校验通过后处理。Worker 初验会话，DO 在合并点再次检查期限、撤销及身份，随后在没有异步让出执行权的段内合并和续期。读取正文期间退出的请求不能继续写入。
- `X-Hako-Account` 是客户端副本匹配条件。它必须与会话解析出的账号一致，否则返回 409；它不能取得对应账号的权限。这样旧页面在 Cookie 已切换时不会把 A 的副本上传到 B。
- 客户端缺少合法 `accountId` 时不放行。账号切换保留各自隐藏实例，账号匹配才显示；退出、失效、登录准备、bfcache 重查、离线和后台暂停同步。取消请求并更换世代，迟到的响应不应用、不更新当前状态。已开始的本机事务只会写原账号库，不跨账号。

## 本机存储与首次接入

正式记录库 v2（协议 2 客户端）：`hako-account-v2:<accountId>:refueling`，`documents` 按文档代次保存完整快照、确认向量、待传标记与导入映射，`control` 保存活动代次、待确认恢复请求与终态（B 写入、A 保留）及迁移来源指纹；草稿库与写锁按账号+代次隔离：`hako-account-v2:<accountId>:<generation>:drafts`。统一锁顺序为「旧 v1 文档锁（仅迁移读取）→ v2 账号控制锁 → v2 代次文档锁」，读活动代次与写 documents/control 在同一 IndexedDB 事务内。旧 v1 库 `hako-account-v1:<accountId>:refueling` 与草稿库原样保留：迁移在旧文档锁内读取，目标 G0 尚不存在时才复制旧副本及其确认信息，已存在时只合并旧库新发现的历史（保留 G0 确认向量、按合并后向量重算待传状态、导入映射合并不覆盖新增条目），迁移指纹只在合并落盘成功时推进；失败保留两份原数据。代次切换保留旧副本、不上传旧 CRDT 历史、legacy 导入映射只继承目标记录仍存在于新快照的条目——完整规则由[恢复设计 §6](./restore.md#6-本机记录草稿与旧设备)维护，本文不重复。

`hako-local-validation-v1` 和 `hako-refueling-drafts-v1` 原样保留，不改写、删除或自动打开。登录不会关联或上传旧记录。加油页提供“查看可导入的旧记录”：

1. 用户主动打开后只读旧库；没有旧库时不创建它。展示旧记录供逐条选择，默认全部不选。
2. 用户可以“保留原样，关闭”，也可以点击“导入选中的 N 条并同步”。按钮明确说明选中数据将复制到当前账号并在联网时上传。
3. 只复制本次预览中选中记录的当前字段值。读取原始 Map 条目和标量值，不以 JSON 投影把嵌套容器当成字段；导入先拒绝未知字段，再按统一字段清单构造新记录。每条生成新的正式记录 ID，账号库中保留本机来源 ID 到正式 ID 的导入映射；映射和记录同一严格事务提交。所有本机写入在提交前使用与加载/同步相同的文档校验；选中记录含不支持的额外字段时整批拒绝，原账号文档、确认版本、导入映射和旧库不变。重复操作或写失败重试不新增重复记录，也不覆盖已导入后的编辑。
4. 不导入整份旧 Loro 快照，避免未选记录及其历史被带入账号。旧库中的全部历史继续保留；正式记录历史从这次主动导入开始，此后同步始终保留完整历史。旧草稿保留原库，不将其转换为正式记录。
5. 去重范围是此浏览器的此账号与旧验证来源；其他独立设备手动提供的相似记录仍是独立创建，不按金额/日期猜测合并。不涉及小熊格式、通用导入、截图或批量线上写入。

本机所有正式修改和远端合并在账号控制锁内读最新快照，再用同一 IndexedDB 严格事务保存完整 Loro 快照、版本向量、服务端确认版本、待传标记及导入映射；仅事务完成后报告成功。锁内不等待网络。业务记录是 Loro 投影，没有第二套可写业务表。

## 同步接口（协议 v2）

`POST /api/sync/refueling`、`GET /api/sync/refueling` 与 `POST /api/sync/refueling/bootstrap`，同源 Cookie；请求与成功响应都使用 `Content-Type: application/octet-stream`（bootstrap 为 `application/json` 空对象）、`X-Hako-Sync-Protocol: 2`、`X-Hako-Account: <accountId>`；业务上传必填 `X-Hako-Document-Generation: <UUID v4>`，成功响应回传同一代次与已持久 revision（`X-Hako-Revision`）。所有响应 `Cache-Control: no-store`，Service Worker 不缓存 API。

文档代次由服务端生成（UUID v4，初次升级为已有文档生成 G0 并永久记录 `legacyGeneration`）；每次整文档恢复创建新值，永不重新启用旧值。完整代次规则、受控 G0 初始化与 `generation_state_unavailable` 语义由[恢复设计 §4/§5](./restore.md#4-身份版本与持久状态)维护。最小实现继续交换完整快照，避免另行维护缺失增量、批次日志与压缩整理：

- **bootstrap**：幂等初始化/读取 G0 和当前代次，不接受业务快照、不执行恢复、不等待 R2、不续期；并发调用复用已提交的同一个 G0。返回 `accountId`、`documentGeneration`、`legacyGeneration`、`generationOrigin`、`snapshotAvailable` 与 `restoreWritesAvailable`（A 恒为 false；不新增运行时开关）。
- **GET 只读当前快照**：重验会话但不续期、不创建映射、不初始化。头部含账号、协议、当前代次及 revision（备份游标未初始化时为 0）；没有主文档时返回 204，bootstrap 的代次信息仍有效。全新浏览器可 GET 当前快照建立本机副本；204 时在已知 G0 下创建合法空 Loro 文档。
- **POST 业务上传**：代次与会话账号、DO 当前代次在同一个 `storage.transaction()` 内一起匹配后，才校验、合并和持久化快照；合并、revision/备份责任更新与续期仍同事务提交，提交后 `await storage.sync()`。
- 协议 1 或缺少代次的业务上传一律 `426 protocol_upgrade_required`（旧客户端保留本机数据，显示通用同步失败，不进入副本保护页）；格式错误代次为 400；合法但非当前代次为 `409 document_generation_changed`，附当前代次元数据（`currentGeneration`/`legacyGeneration`/`revision`），不附业务快照；账号不匹配仍为 `409 account_changed`。不得把请求头改成新代次后重发旧正文。
- 客户端先 bootstrap 再决定打开同代次本机副本或进入副本保护流程；一次交换绑定账号、文档代次和请求 epoch，检查响应协议、账号、代次及已发送版本覆盖后才进入对应代次的本机写锁；每次本机提交再次读取持久的活动代次，已失活代次的迟到响应不能写入新代次或更新其确认游标。401/`account_changed` 继续重查会话；`document_generation_changed` 进入副本保护流程；426 进入更新提示；代次不匹配不触发登录循环。
- 空客户端也是完整空快照；服务端做 CRDT 合并，不把空库解释为清空，也不按客户端时钟或上传先后覆盖整份文档。
- 独立校验传入副本，再与 SQLite 最新副本合并。只接受完整 snapshot，拒绝浅快照、增量、待依赖操作、未知根容器、未知字段及无效字段类型/数值。根检查使用原始容器句柄和 ContainerID，当前可见根以及完整历史中写入过的根只能是 `cid:root-records:Map`；后者也覆盖同名异型根被遮挡、非法根已清空的情况。每条记录必须是 LoroMap，字段只能是合同中的字符串、布尔值、定点整数或允许的 null；Text、Counter 等嵌套容器不能靠投影成标量通过。Map 条目逐项读取，`__proto__` 不会绕过未知根/字段或记录必填与数值检查。不解析或迁移不受支持的快照，也不修改原副本来修复它。金额关系和跨记录里程异常使用现有“待核对”提示，正常并发异常不拒绝合并。
- 单次请求与合并后快照上限均为 4 MiB，流式读取逐块计数，不信任 Content-Length；超限保留本机数据并提示。
- SQLite 的 `refueling_snapshots` 按账号与分块序号保存并携带 `document_generation` 标签（每块最多 512 KiB）；分块切换在同步的外层事务中完成，重复版本不重写分块。读取时核对每块代次与 head 一致；head 已存在时全 NULL 标签（部署回退窗口旧版本写入）接受为当前文档，NULL 与代次混排或整批异代为残缺状态。没有内存中的权威文档，每次从 SQLite 恢复候选，写失败不能污染后续请求。同一事务还持久化独立备份的 revision 与待备责任并安排必要 alarm（与 SQL 联合提交或回滚），边界由[独立备份合同](./backup.md)维护。**协议 v1（已部署版本）**：请求与响应不带代次头，其余校验、合并与确认语义同上；A 起服务端统一拒绝其上传（426）。
- DO 保留 output gate，并 `await storage.sync()` 后才返回成功快照。返回快照的版本向量就是已持久保存的确认范围，不是“已收到请求”或后台稍后写入的确认。
- 客户端验证响应账号/协议/代次、快照及其版本确实覆盖本次发出的版本，再在写锁内合并本机最新版本。合并结果和确认版本一起落盘后才显示同步状态；发送后新产生的修改仍为待传。客户端合并/落盘失败不确认成功。
- 服务端保存后响应丢失时，本机仍待传；再次提交相同 Loro 历史为幂等合并。中断、重启和乱序旧副本均不重新创建业务记录，也不抹掉较新的已保存操作。

错误：401 会话不可用，409 账号不匹配或代次变化，400 正文或协议格式错误，405 方法不支持，403 Origin 不匹配，413 容量上限，422 文档不受支持，426 需要升级客户端，503 配置/存储/服务暂不可用或代次状态不可解释。错误响应只返回固定错误码，不回显文档、身份或底层异常。

同步端点在有效请求持久保存后调用既有服务端续期规则。Cookie 保存期限与服务端授权期限分离，具体参数和既有 Cookie 兼容边界只由[登录规格](./eruoo-login-integration.md#61-本应用会话与-owner-配置)维护。同步与 session 读取均不写会话 Cookie，避免迟到响应覆盖或清除另一窗口的新登录，也不依赖同步响应交付来延长浏览器保存期限；读取 session 和失败请求不续期，撤销后不能靠迟到响应复活服务端会话。

## 调度与状态

账号已由 session 确认、页面前台且联网时：首次打开、恢复前台/联网及本机保存触发；每 30 秒检查其他副本变化。同一实例只允许一个交换请求，期间新请求合并调度；网络不占本机文档写锁。20 秒超时，失败按 2、5、15、30 秒退避，后续最多每 30 秒重试。后台或离线停止定时器并取消请求；401/409 立即关门禁并重查 session。

“已保存到本机”“有待上传修改”“正在同步”“同步失败/暂停”“本机版本已由服务端持久保存”分别表示真实阶段。最后一项只说明已确认的本机版本，不承诺此刻没有另一设备尚未到达的新改动。UI 明示同步成功不代表独立备份已完成；独立备份已部署并完成首份真实备份读回（见[发布记录](../releases/2026-10-04-independent-backup.md)），相关静态提示已随发布对齐。

已打开且仍被确认的页面可断网编辑；离线重开或会话不可确认时按最新登录门禁留在 `/#login`，联网确认后恢复。正式草稿仍不参与同步；登录双次 flush、隐藏实例、Web Locks 和重载后金额差异重新确认继续生效。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| `src/shared/sync-protocol.ts` | 协议版本、账号/代次标识格式、正文限额与流读取；不含身份密钥 |
| `src/shared/document-generation.ts`、`src/shared/restore-protocol.ts` | 代次来源模型、恢复固定正文/指纹与结果分类（恢复规则见[恢复设计](./restore.md)） |
| `src/worker/sync/` | HTTP 校验（bootstrap/GET/POST v2）、同步原子段、SQLite 分块代次标签、head 与受控 G0 初始化 |
| `src/worker/restore/` | 恢复回执存储/服务/路由：A 只查重 POST 与回执 GET（切换由 B 实现） |
| `src/data/sync-document.ts` | 两端共用的完整快照/结构校验 |
| `src/data/refueling-document.ts` | 原始 Map 条目读取、统一字段清单及既有业务字段校验 |
| `src/data/account-storage.ts`、`local-refueling-v2.ts` | v2 账号名称空间与严格事务（documents/control）、v1→G0 迁移合并、代次切换与待确认恢复结构 |
| `src/data/refueling-server-api.ts`、`refueling-sync.ts` | bootstrap/只读快照客户端、协议 2 串行交换与代次变化处理 |
| `src/data/legacy-refueling.ts`、`LegacyImport.vue` | 显式只读预览、逐条选择和导入交互 |
| `AccountWorkspace.vue`、`RefuelingWorkspace.vue`、`RetainedRefuelingCopy.vue`、`useLocalRefueling.ts`、`App.vue` | 首页副本同步、按代次挂载工作区、代次变化保护流程、保留副本只读与逐项带回、账号匹配展示、延迟挂载表单及保留各账号实例 |

Cloudflare Vite 插件把 Worker Wasm 作为编译模块打包，浏览器继续使用自身预缓存 Wasm；未变更部署配置、命名空间、依赖或锁文件。依据：[非 JavaScript 模块](https://developers.cloudflare.com/workers/vite-plugin/reference/non-javascript-modules/)、[SQLite DO 持久化](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Loro 同步](https://www.loro.dev/docs/tutorial/sync)与 [ContainerID / 原始查询 API](https://loro.dev/docs/api/js)。结构检查另以锁定的 Loro 1.16.3 实际接口及回归验证，不能仅凭返回 JSON 的外观判断类型。实际验证回执与未验证项由[本地验证进展](../local-validation.md)引用维护。
