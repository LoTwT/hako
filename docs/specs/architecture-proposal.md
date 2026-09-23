# Hako 首版技术方案

日期：2026-09-16  
更新：2026-09-23  
状态：整体建议，待用户审阅；尚未实施或部署。

已确认需求与业务计算规则以[重新设计记录](./redesign.md)为准。用户已接受 PWA 在同步前仍存在本机唯一副本丢失风险；这不等于持久化和恢复已经实现。本文件只维护本轮推荐的技术方案、取舍和验收要求。

2026-09-23 范围更新：用户已恢复[AI 截图识别辅助填表](./redesign.md#ai-截图识别)，并保留完全手填；已确认由 Hako Worker 使用服务端配置的应用调用 Key 访问 eruoo/server。[AI 接入规格](./ai-refueling-recognition.md)已补齐请求合同、字段与表单衔接、运行限制、费用边界和验收要求。下文整合该接入方向；整体选型和接入稿新增技术参数仍待审阅，真实调用与费用尚未验证。

## 1. 推荐组合

推荐一个同源的 Vue PWA，使用 Loro 管理结构化记录、IndexedDB 保存本机副本；Hako 自己的 Cloudflare Worker 提供登录接入、HTTP 同步和截图识别的服务端调用，SQLite Durable Object 保存服务端副本，私有 R2 保存独立备份。eruoo/server 承担身份服务，并通过其现有 DeepSeek 接入提供 AI 调用能力。

| 层次 | 推荐选择 | 理由与维护工作 |
| --- | --- | --- |
| 客户端 | Vue 3、TypeScript、Vite、Vue Router | 复用现有 Vue 骨架；响应式表单和统计页面共用一套代码。采用 Composition API；无需为个人应用增加 SSR。 |
| 安装与离线资源 | vite-plugin-pwa，提示更新模式 | 缓存应用界面、必要 JS/CSS 和 Loro Wasm；避免填写表单时自动刷新。 |
| 记录与合并 | Loro | 用 Map 表达记录和字段，支持原生更新导入导出及历史查看；小规模单人多端不需要协同编辑房间管理。 |
| 本机存储 | IndexedDB + idb | 只保存 Loro 文档、必要同步元数据与本机草稿；不另外维护可独立写入的业务数据库。 |
| 业务计算 | 独立 TypeScript 模块 + decimal.js | 原始数量采用定点整数，派生计算使用十进制运算；统计可在本机完成，便于独立验证。 |
| 服务端 | Workers Static Assets + 一个 Hako Worker | 前端与 API 同源，减少 CORS、Cookie 和部署配置。内部代码按身份、同步、备份职责分开。 |
| 服务端副本 | 一个本人账号对应一个 SQLite Durable Object | 合并并持久保存 CRDT，保存会话和备份任务状态；账号内操作集中处理，无需再加 D1、Workers KV 或独立队列。 |
| 独立备份 | R2 Standard 私有桶 + Durable Object Alarm | 按已确认的变化触发与最近 30 版本策略执行；应用关闭后也能完成已同步数据的备份。 |
| 身份接入 | eruoo/server OIDC + oauth4webapi + Hako 后端会话 | 协议校验由成熟库承担；令牌不交给浏览器 JavaScript。需要为 Hako 新增静态 Web 客户端。 |
| AI 接入 | Hako Worker 校验本人会话后调用 eruoo/server；应用调用 Key 使用 Worker Secret | 产品规则见[AI 截图识别](./redesign.md#ai-截图识别)，接口与验收由[AI 接入规格](./ai-refueling-recognition.md)维护；复用现有 Worker，不新增独立 AI 部署。 |

上表的 AI 接入方向已确认，其余技术组合仍为推荐；不把 npm 上存在这些库当成组合已通过验证。当前脚手架的 Vue/Vite 版本较旧，实施时统一升级并锁定依赖；本次没有修改依赖或生成应用代码。

## 2. 成本与替代方案

最小满足当前要求的路径就是同源 PWA、单份逻辑文档和前台 HTTP 同步。保留一个 Hako 部署单元；Durable Object 与 R2 是该部署使用的托管存储，不拆成独立微服务。

| 对照 | 本方案的取舍 |
| --- | --- |
| Automerge + Automerge Repo | 这是最接近的替代方案：自带并发安全的 IndexedDB 存储和网络适配。Loro 在结构化字段、显式版本导入导出和“持久保存后确认”上便于做小范围集成；代价是 Hako 必须维护本机写入协调、HTTP 同步和恢复边界。当前选择依据是 API、源码和部署适配评估，不是已经测出的工时优势。若实际适配显著扩大，应重新比较 Repo，不能仅凭 Loro 性能指标坚持选择。 |
| Tauri / Flutter 等原生客户端 | 已确认首版采用 PWA，当前不承担各系统安装包、原生存储桥接与 iOS 分发的维护成本。仓库中的 Tauri 文件不是首版运行依赖；本次不删除它们。 |
| Nuxt / SSR | 首版页面依赖本人本地记录，没有公开内容检索需求；增加服务端渲染不能解决离线保存与 CRDT 集成。 |
| WebSocket 常驻同步 | 低频加油记录采用前台 HTTP 交换即可；后续确有即时协作需求再评估。 |

核查过两个已有实现：Loro Protocol 的 [SimpleServer](https://github.com/loro-dev/protocol/blob/1f8a0fa07bab5320ae154ae7cfa4add8b3b8c4fc/packages/loro-websocket/src/server/simple-server.ts) 将更新确认与定时保存分别处理，不能直接把其 Ack 当作 Hako 的持久保存凭据；Automerge Repo 的 [StorageSubsystem](https://github.com/automerge/automerge-repo/blob/b54e7a3f1da78769e4caa3f3f0d57a8840fcd983/packages/automerge-repo/src/storage/StorageSubsystem.ts) 维护快照、增量与已保存版本，说明存储版本必须独立追踪。本方案采用其“按实际保存版本确认”的原则，低频表单先使用完整快照，避免增加后台整理增量日志的机制。

## 3. 数据流与代码边界

```text
iPhone / Android / macOS / Windows / Linux
          浏览器或安装的 PWA
                 |
       Vue 界面、表单、统计模块
                 |
         Loro <-> IndexedDB
                 |
       前台 HTTPS 同源同步请求
                 |
          Hako Worker API <----> eruoo/server（登录）
                 |
        本人账号 Durable Object
           |              |
       SQLite 副本     Alarm -> 私有 R2 备份
```

AI 识别请求独立于上图的记录同步路径：浏览器/PWA → Hako Worker（校验本人会话）→ eruoo/server → DeepSeek。截图仅作为识别输入，核对后的表单数据才按既有记录保存与同步流程处理；具体边界见[AI 截图识别](./redesign.md#ai-截图识别)。

推荐目录职责：

| 位置 | 职责 |
| --- | --- |
| `src/pages/`、`src/components/` | 页面和表单交互，仅读取数据投影、提交明确的修改命令。 |
| `src/domain/refueling/` | 字段校验、行程与阶段推导、汇总；不依赖 Vue、网络或 Cloudflare。 |
| `src/data/` | Loro 数据模型、本机持久保存、历史查询与同步控制；应用记录的唯一写入入口。 |
| `src/auth/` | 本机身份状态与登录页面衔接；不保存 OAuth 令牌。 |
| `worker/` | 同源 HTTP 接口、OIDC 接入、Durable Object、备份与恢复。 |
| `shared/` | 协议版本和可跨运行时复用的类型/校验；不导出服务端凭证。 |
| `tests/` | 业务算例、存储故障、多副本一致性与浏览器验收。 |

预计实施会涉及超过 8 个应用、配置及测试文件；当前仍是一个仓库、一个前端和一个 Hako Worker。不先搭建通用插件系统、跨项目 SDK 或多业务模块平台。

## 4. 文档与本机持久化

- 本人账号的一辆车及全部加油记录使用一份逻辑 Loro 文档，包含模式版本、车辆信息和按稳定记录 ID 索引的记录。每条记录使用字段级 Map；只修改用户实际编辑及明确联动计算的字段，不用整个旧表单覆盖记录。
- 金额按分、加油量按千分之一升、原始单价按万分之一元/升、总里程按十分之一公里存储为安全整数。派生结果不回写为第二套可编辑事实。具体业务规则引用重新设计记录。
- 每个运行中的标签页/应用实例使用 Loro 自动生成的独立 PeerID；同一账号不共用一个 PeerID。记录 ID 在一次新建操作开始时生成并复用到保存完成，避免重复点击产生两笔数据。[Loro PeerID 说明](https://www.loro.dev/docs/concepts/peerid_management)。
- 每次确认保存、删除、历史恢复或接收远端修改时，在当前账号的 Web Lock 内读取 IndexedDB 最新快照、合并变更，再用同一 IndexedDB 事务保存完整快照和同步元数据；请求严格持久性并以事务完成为“已保存到本机”。锁内不等待网络；存储失败保留表单内容并报错，不发布保存成功。目标浏览器须验证 Web Locks 和事务持久性行为，不提供绕过写入协调的静默降级。
- 用 BroadcastChannel 通知同源窗口重新读取已保存版本；通知不承担持久存储职责。即使通知丢失，下次读取仍从数据库合并。浏览器与安装的 PWA 若使用隔离存储，按两个副本通过服务端同步，不假定共享 Cookie 或 IndexedDB。
- 保存的是含修改历史的完整 Loro 快照，不在首版使用丢弃旧历史的浅快照。每次提交表单是一组业务修改；输入中的草稿单独存放，不逐键创建正式加油记录。
- 请求浏览器持久存储，并提供本机保存/待同步/同步中/已同步/同步失败状态；持久存储未获授予不伪装成持久保障，基础离线能力仍可使用。

选择完整快照是针对单车、低频表单的成本取舍，依据 [Loro 持久化说明](https://www.loro.dev/docs/tutorial/persistence)。本机多窗口协调是 Hako 自己的实现责任，不能因 CRDT 能合并就允许相互覆盖存储文件。若万条记录的保存预算无法满足，再更换为已验证的增量存储方案，不能放宽保存成功的定义。

## 5. 同步与服务端保存

同步触发：本机正式记录保存成功、启动应用、回到前台、恢复联网，以及前台可见时每 30 秒检查一次。后台不轮询；正在执行的请求合并调度，同一实例不并行上传多个批次。网络失败按 2、5、15、30 秒退避，之后最多每 30 秒重试；切回前台可立即重试，登录失效则等待重新登录。

HTTP 同步使用 Loro 原生版本向量及增量导入导出，不自己实现 CRDT 算法。请求正文携带协议版本、文档代次、客户端版本和更新数据；二进制在 JSON 正文中以 Base64 表达，避免把不断增长的版本信息塞入 HTTP 请求头。服务端返回缺失更新、已持久保存的版本及备份状态。

关键约束：

1. 新设备先获取服务端现有文档；本地空库表示缺少副本，不表示删除全部云端记录。首次登录建立本人身份与本机文档关联；已有副本在离线或会话过期时仍可工作，待登录恢复后同步。
2. 同步服务先验证本人身份与文档代次，使用候选 Loro 文档导入、检查结构，再在 SQLite 事务中保存快照与版本。非法结构不能污染当前文档；正常并发产生的业务关系异常沿用“待核对”规则，不用拒绝同步制造两端永久分歧。
3. 服务端用 SQLite 事务更新快照及元数据，等待存储确认后才响应“已同步”。保留 Durable Object 的 output gate；不启用跳过写入确认的选项。[Cloudflare 持久化语义](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。
4. SQLite 的单行/BLOB 有大小限制；完整快照按 512 KiB 分块，分块与版本元数据在同一事务切换。分块属于存储实现，不改变逻辑上只有一份文档。[平台限制](https://developers.cloudflare.com/durable-objects/platform/limits/)。
5. 客户端只把服务端实际确认覆盖的版本标为已同步。请求发出后又新增的本机修改继续待同步；响应丢失可以重复发送相同 CRDT 更新，不能重新创建业务记录。
6. 服务端进程重启必须从 SQLite 恢复。备份是独立后续状态，不以 R2 备份完成代替服务端副本保存，也不因备份暂时失败撤销已经成功的同步。
7. 每次远端合并后重新运行字段及跨记录校验，再计算统计。浏览器设备时间不决定合并胜负。

## 6. 登录接入

登录保持按[产品决策](./redesign.md#已确认的产品需求)优先满足自有设备长期保持登录；原先每 30 天重新登录的建议已撤下，续期与到期参数由[登录规格第 6.1 节](./eruoo-login-integration.md#61-本应用会话与-owner-配置)统一维护，现已补齐候选机制与验收边界，尚待审阅及实测。

登录的客户端登记、协议参数、会话建议与双方实施责任统一维护在[Hako × eruoo/server 登录接入规格](./eruoo-login-integration.md)。该交接稿沿用既有 OIDC 服务，由 Hako 后端处理授权并建立自己的应用会话；尚未实施或部署。

PWA 登录必须验证发起环境绑定。此前“外部浏览器授权后，原 PWA 自动领取会话”的简略描述缺少跨环境的持有证明；本轮已在[登录规格第 6.2 节](./eruoo-login-integration.md#62-浏览器--pwa-发起环境绑定)补充同环境验证与隔离时的完成码建议。该交互仍待技术方案审阅和 iPhone 真机验证，不能只根据公开 state 或回调成功自动完成原 PWA 登录。

## 7. 备份与恢复

- Durable Object 在首次出现尚未备份的新版本后安排 30 秒 Alarm；窗口内合并后续变化，不持续后移导致备份无限推迟。无数据变化时不创建新版本。
- Alarm 读取一个确定版本的完整快照，写入私有 R2 Standard 桶，附模式版本、文档代次、服务端版本和 SHA-256。成功读取核验、确认快照可导入后再登记为可恢复备份；失败保留任务和已有备份。
- 重试使用持久任务状态和 Alarm，依次间隔 1、5、15、60 分钟，后续每小时重试；下次前台同步同时返回备份失败状态。相同版本使用确定的对象键，重试不增加重复备份。备份执行期间出现更新时，再安排下一轮。
- 按已确认策略保留最近 30 份已验证备份，新备份确认后才清理超出的旧版。清理失败可能暂时超过 30 份，但不能为凑数量删除唯一可用版本；不设置按天到期的生命周期规则。
- R2 不开放公共访问，只经 Hako 身份校验后查看清单或下载。快照不包含 OAuth 登录事务、会话 Cookie 或部署凭证。Cloudflare 的存储加密不等于端到端加密。
- 单字段/单记录的历史恢复：读取旧值并生成新的正常编辑，同步到各端；不把 Loro 的历史浏览模式直接当成恢复完成。
- 整份备份恢复：先预览版本与记录数量，再保存当前状态的恢复前备份；校验选定备份后切换到新的文档代次。老设备上传旧代次时拒绝静默合并，保留其本地数据供导出/核对，然后重新取得当前文档，防止恢复后被旧副本重新覆盖。
- 服务端副本损坏或被误清理时，按同样的备份导入与新代次流程恢复；没有任何服务端副本或独立备份的本机未同步数据不在恢复承诺内。

这里保留的是“最近 30 个有变化版本”，不是 Durable Objects 自带的按天 PITR 窗口；两者不互相替代。R2 和主存储属于同一 Cloudflare 账号，独立备份解决主副本误操作/损坏，首版不承诺 Cloudflare 账号整体丢失后的跨服务商恢复。

## 8. 平台、离线资源与升级

| 平台 | 推荐首版范围 | 验收边界 |
| --- | --- | --- |
| iPhone | 优先验证[用户当前设备](./redesign.md#已确认的产品需求)；此前 iOS 17 最低版本仍只是候选，未实测；Chrome 访问及添加主屏幕，独立 PWA 使用 | 浏览器与 PWA 分别验证登录返回、会话保持、保存、重开、清理后恢复；不能用桌面 WebKit 自动化代替真机。 |
| Android | 能运行验收范围内 Chrome 的系统；浏览器 + 安装 PWA | 同步、进程终止后重开、离线表单、文件导入。 |
| macOS / Windows | Chrome 浏览器 + 安装 PWA | 两窗口并发写入、网络切换、升级与恢复。 |
| Linux | 建议首版一并支持 Chrome 浏览器 + 安装 PWA，不增加原生安装包 | 选一台受 Chrome 支持的 Linux 环境验收相同流程。 |

Chrome 的正式验收范围为发布时稳定版及前一个大版本；以上是支持目标，不是本次已经测试通过的清单。Chrome 官方确认 iPhone 可通过分享菜单添加主屏幕；应用是否具备离线等能力仍取决于 Hako 的实现。[Chrome 帮助](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DiOS&hl=en)。

Service Worker 仅缓存应用自身静态资源，包含 Loro Wasm、表单与统计所需代码；登录、同步、备份接口不进离线响应缓存。已有版本可离线打开，首次加载/首次登录/本机副本丢失后的恢复需要网络。

升级使用提示模式：表单草稿先可靠保存，再让用户刷新；不用自动刷新打断录入。数据格式有独立版本号，旧客户端不认识新格式时停止写入并提示升级，保留现有副本。部署保留上一版静态资源与 Worker 版本；常规回滚只换程序，不清空数据。数据迁移需先备份，破坏性迁移不能用简单回退旧前端替代恢复。

## 9. 免费额度与实际费用

以下为 2026-09-23 复核的公开额度，按账号共享使用量计；不是 Hako 的实测账单。

| 服务 | 相关免费额度 | 对本项目的判断 |
| --- | --- | --- |
| Workers | 每天 100,000 动态请求；Free 每次调用 10 ms CPU | 单人访问量低；路由和身份接入仍须验证实际 CPU，不以请求数低代替 CPU 验证。[定价](https://developers.cloudflare.com/workers/platform/pricing/)。 |
| SQLite Durable Objects | Free 可用；每天 100,000 请求、13,000 GB-s，读 500 万行、写 10 万行，账号总存储 5 GB、单个对象 1 GB | CRDT 合并与主副本在这里处理；不要求为了使用 DO 先开 Workers Paid。[定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[限制](https://developers.cloudflare.com/durable-objects/platform/limits/)。 |
| R2 Standard | 每月 10 GB-month、100 万次 A 类、1,000 万次 B 类操作，直接出站流量免费 | 单车文本记录与 30 份快照预计远低于额度。[定价](https://developers.cloudflare.com/r2/pricing/)。 |

估算例：5 个副本各每天前台使用 20 分钟，30 秒检查一次，约 200 次周期请求/天；若单个备份为 1 MiB，30 份约 30 MiB。这些是测算假设，不是对用户实际使用量或文档大小的断言。预计新增托管使用费可为 0；域名续费、账号其他应用占用和超额用量另计。本节仅估算基础托管资源，不包含恢复识图后的 DeepSeek 模型调用费用；该费用需按实际请求与服务计费单独核对。

R2 需要先在 Cloudflare 完成服务开通/结算流程，即使预计在免费额度内也不能跳过该步骤；本次未开通或更改计费。[R2 开始使用](https://developers.cloudflare.com/r2/get-started/)。若现有账号未开通，届时按实际账户条件办理；不自动升级付费套餐。

当前 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)已列明 Free/Paid 的未压缩包体上限均为 64 MiB，不再限制 gzip 后体积；全局启动代码仍须在 1 秒内完成。验收应检查实际构建产物与启动时间，不用旧包体额度或单个 Wasm 文件大小判定通过。入口 Worker 的 10 ms CPU 与 Durable Object 的执行预算应分别测量；会话及 CRDT 合并在既定 DO 中完成，图片解码在浏览器完成。AI 出站等待放在入口 Worker，不让保存记录的 DO 为整段识图等待保持活动。[DO 限制](https://developers.cloudflare.com/durable-objects/platform/limits/)、[DO 时长计量](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

## 10. 验证、实施顺序与交付

这是一个完整首版交付，下面是内部实施顺序，不把尚无同步/备份的中间状态当作可正式使用的发布版本：

1. 在现有 Vue 项目中整理业务模型、统计模块与表单，按重新设计记录建立算例。
2. 接入 Loro 和 IndexedDB，完成离线保存、修改历史、多窗口合并和故障语义。
3. 实施同源 Worker、Durable Object 与 HTTP 同步，同时完成 eruoo/server 新客户端的协议接入。
4. 实施独立备份、单记录与整份恢复、文档代次保护和升级策略。
5. 按[AI 接入规格](./ai-refueling-recognition.md)接入截图识别与服务端调用，完成字段校验、预填与失败处理；真实图片和结构化输出组合、Worker 间请求及 CPU 预算作为上线前验收项。
6. 完成四端与 Linux 的浏览器/PWA 验收，再按明确的发布授权部署正式资源。历史数据格式适配只在用户提供文件后进行，不重新调查来源 App 的导出方法。

| 验证面 | 必须证明的结果 |
| --- | --- |
| 业务算例 | 满箱/未满/亮灯、里程异常、零实付、历史价格不足、跨月、补录重算和金额舍入符合已确认规则。 |
| 本机可靠性 | 保存后立即关闭再打开仍在；事务失败/配额不足不报成功；两个同源窗口修改不会覆盖丢失。 |
| CRDT 与网络 | 两台设备离线改同字段/不同字段；更新乱序、重复、断线、响应丢失均收敛；重试不重复新增记录。 |
| 确认边界 | 服务端在保存前失败不能返回已同步；保存后断线可安全重试；在途又新增的数据继续显示待同步。 |
| PWA 清理 | 清空本机副本后联网恢复已同步记录；完全离线且本机已被清理时如实显示无法取得数据。 |
| 身份 | 错误 issuer/subject、过期会话、重放回调被拒绝；Chrome 与独立 PWA 授权返回各自完成会话。 |
| AI 录入 | 单张截图预填后人工核对保存；部分识别按既有规则计算并提示缺失项；失败或超时保留表单、不自动再次调用，由本人重试或转手填。应用调用 Key 不下发前端，截图不作为记录附件持久保存或进入同步、备份。 |
| 备份 | 无变化不新增；连续操作合并；写入/校验失败不删旧备份；长期不用仍保留；正常保留 30 份。 |
| 恢复 | 历史值恢复产生新编辑；整份恢复后旧代次设备不静默回写；恢复失败保留当前有效副本。 |
| 升级 | 离线冷启动、Wasm 预缓存、表单未完成时有更新、旧客户端遇到新格式均不丢本机数据。 |
| 容量与费用 | 1,000 条和 10,000 条合成记录含修改历史分别验证；记录初始化/保存延迟、Worker CPU、Wasm 包体、DO 内存和备份尺寸。超限保留数据并明确报错。 |

实施时建立并运行 `pnpm run typecheck`、`pnpm run test`、`pnpm run test:worker`、`pnpm run test:e2e`、`pnpm run build`。目前仓库只有 `dev/build/preview/tauri`，其余命令是本方案要求新增的验证入口，不是假称当前已存在或运行通过。发布前检查 Wrangler dry-run 产物；浏览器自动化不能替代 iPhone 真机与跨设备恢复测试。

## 11. 配置、前提与当前证据

| 配置/资源 | 用途与处理责任 |
| --- | --- |
| Hako 正式 HTTPS origin | 决定 Cookie 作用域和精确 OIDC 回调。部署接线时由用户确认已有域名或 Cloudflare 默认域名；本次不占用或购买域名。 |
| eruoo 的 `hako-web` 注册 | 由对应仓库实施静态配置、持久配置及协议校验；当前仅完成源代码核查。 |
| 固定 issuer 与本人 subject | Hako 只接受同一身份；subject 在接入时从本人已验证身份取得，不用邮箱或客户端提交的用户 ID 替代。 |
| Cloudflare 账号与部署凭据 | 使用账号内受限部署权限；仅部署端需要，不进入前端或业务备份。 |
| DO binding 与私有 R2 binding | 同一 Hako 部署内配置；无需给浏览器或 Worker 再提供 R2 S3 API Key。 |
| eruoo/server AI 服务地址、精确模型 ID 与应用调用 Key | 服务端统一配置；变量、权限和部署条件只在[AI 接入规格](./ai-refueling-recognition.md#4-配置与部署接线)维护，应用 Key 使用 Worker Secret。 |

基础架构不要求 Apple 付费开发者会员或第三方同步订阅。AI 调用与凭证配置方式已确认；具体服务地址、凭证签发与实际调用费用仍需在接入时核对，不能沿用此前不含 AI 时的费用前提。

最脆弱的前提是目标 iPhone 的 PWA 保存/授权流程，以及 Loro Wasm 在实际 Cloudflare 构建中的运行成本。当前已核查包的 Web 入口支持预编译 Wasm 初始化，`loro-crdt@1.16.1` 的 Wasm 原文件约 3.24 MB、gzip 约 1.07 MB；这不是完整 Worker 构建体积，也不证明冷启动和 CPU 已通过。若真机或 Cloudflare 运行验证失败，应先调整接入/存储实现并复测，不能以“已采用 CRDT”跳过失败；若必须改变客户端形态或付费方案，再把具体差异集中交给用户取舍。

外部依赖不可用时，本机已有数据与操作继续可用，云端状态明确待同步；备份失败保留主副本并重试。若不选 Loro，保留业务模块和规范化记录导出，替换存储层时从旧文档迁移；不能承诺两种 CRDT 的原生历史可以无损互转。服务端代码回滚不删除 DO 或 R2。

本次只完成仓库、官方文档、发布包与部分源码核查。npm 当日 stable 标签包括 Vue 3.5.42、Vite 8.3.0、Loro 1.16.1、idb 8.0.3、vite-plugin-pwa 1.3.0、oauth4webapi 3.8.8；它们是版本调查快照，不是已联调的锁文件。尚未执行应用构建、五端测试、Cloudflare 部署、账户配额检查或真实登录。

官方依据补充：[Automerge Repo 存储](https://automerge.org/docs/reference/repositories/storage/)、[idb](https://github.com/jakearchibald/idb)、[Vite PWA Vue 接入](https://vite-pwa-org.netlify.app/frameworks/vue)、[Cloudflare Wasm](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)。
