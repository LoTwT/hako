# 本地最小验证进展

更新：2026-10-02。设计文档已通过 [PR #4](https://github.com/LoTwT/hako/pull/4) 合入；本地验证版已通过 [PR #5](https://github.com/LoTwT/hako/pull/5) 合入。2026-10-01 完成 PR1：同源 Hako Worker 与运行配置（cf CLI + Cloudflare Vite 插件 beta），验证记录见[PR1 验证](#2026-10-01-pr1-同源-worker-与运行配置验证)。2026-10-02 完成 PR2：完整 OIDC 登录事务、SQLite Durable Object 会话与 eruoo 出站接线，见[PR2 验证](#2026-10-02-pr2-oidc-登录事务do-会话与-eruoo-出站接线验证)。同日完成 PR3（本地工作区，未提交）：登录 UI、草稿保护与返回恢复，见[PR3 验证](#2026-10-02-pr3-登录-ui草稿保护与返回恢复验证)。本文件维护实现进度和运行证据，产品规则仍以[重新设计记录](./specs/redesign.md)为准。

当前状态：本地手填验证版加同源 Worker，`/api` 命名空间由 Worker 承载；登录后端（发起、回调、会话读取、退出）与登录页面、草稿保护/返回恢复（PR3，本地工作区）已按[登录接入规格](./specs/eruoo-login-integration.md)实现并本地验证，真实 eruoo 登录、部署与 iPhone 真机仍未完成。eruoo 的客户端支持已上线，10 月 1 日接收的[服务端只读复核记录](./specs/eruoo-login-integration.md#2026-10-01-服务端只读复核)确认发布状态未变。

## 已实现的范围

- 一页手填表单与记录列表：新增、编辑、是否加满、可选油灯及账单补充字段；金额联动、人工修正保护、精度与必填校验、金额差异确认和里程异常提示。
- Loro 字段级 Map 与完整历史快照；同源窗口使用 Web Locks 串行读取最新快照并写入字段变更。IndexedDB 快照、版本向量和待同步标记在同一严格持久性事务中保存，事务完成后才显示成功。
- 写入失败保留当前输入，不把失败修改留在可继续保存的共享文档中；重试复用记录 ID。BroadcastChannel 通知其他窗口重新读取，重新聚焦时也会读取最新版本。
- PWA 静态资源预缓存包含 Loro Wasm，可在首次准备成功后离线重开。提供持久存储申请和更新提示；新版本等待旧窗口全部关闭，不从某个窗口强制刷新其他窗口的未保存表单。
- 同源 Hako Worker（PR1，原生 `fetch`，无 Web 框架）：`/api` 与 `/api/*`（含页面导航请求）一律进入 Worker；`GET`/`HEAD /api/health` 返回简单健康状态，未支持方法返回 405 与 `Allow`，未知 API 返回 JSON 404，API 响应统一 `Cache-Control: no-store`；`/api/auth/callback` 得到 API 404 而非首页。非 API 请求由静态资产承载，SPA 回退仅作用于未命中资产的非 API 路径。
- [cloudflare.config.ts](../cloudflare.config.ts) 是唯一 Cloudflare 配置入口（PR1）：单个 `hako` Worker、正式域名 `hako.eruoo.me`（关闭 workers.dev）、兼容日期 2026-10-01、`assets.runWorkerFirst` 固定 `/api` 与 `/api/*`、observability 开启日志与 traces 并对 query 脱敏。工具链采用 cf CLI（`cf@1.0.0-beta.10`）与 `@cloudflare/vite-plugin@2.0.0-beta.sha-ad79608dd` beta 组合。
- 登录配置合同（PR1）：固定 origin、issuer、client、resource 以 `HAKO_LOGIN` JSON 绑定声明；owner 主体由 `HAKO_OWNER_SUBJECT` 后端 Secret 输入。Worker 在读取登录配置时执行校验（HTTPS origin 形态、拒绝本地/内网地址、非空 owner），回调由固定配置组装为 `${origin}/api/auth/callback`，不从请求 Host/Origin 推导。缺少 owner 无法取得有效登录配置，但类型生成、构建、健康检查与静态页面不依赖真实 owner；真实 owner 不进入前端、日志、公共配置或文档。
- 登录后端（PR2）：`POST /api/auth/login`、`GET /api/auth/callback`、`GET /api/auth/session`、`POST /api/auth/logout`。登录事务短期（10 分钟）、绑定发起浏览器环境（`__Host-hako_login`），回调到达时原子消费、OIDC 兑换完成后在同一 SQLite 事务里删除事务并插入会话；退出或同环境重新发起会删除事务，因此在途登录不会建立会话。回调使用 oauth4webapi 完成 state/iss 校验、PKCE S256 兑换、ID token 签名与 claims（nonce/aud/azp/期限/at_hash）验证、UserInfo `sub` 核对与固定 owner 比对；成功后才建立 Hako 自己的会话（`__Host-hako_session`，仅保存凭据哈希）。会话在服务端绑定固定 issuer 与 owner `sub`，状态读取与续期都要求身份匹配（缺少有效登录配置时带 Cookie 的读取返回配置错误）。凭证不进入响应体、日志或缓存；回调收尾返回最小静态 HTML（no-store、`Referrer-Policy: no-referrer`、不加载第三方资源），不回退首页。
- 账号级 SQLite Durable Object（PR2）：登录事务与会话状态在 `cloudflare.config.ts` 声明的 `HakoAccountDurableObject` 中原子处理（消费、过期、撤销、续期）；续期能力（24 小时间隔、180 天有效期、365 天绝对上限）已在 DO 内实现并由测试覆盖，但本 PR 没有会触发它的前台同步端点，不新造保活接口。
- 出站接线（PR2）：discovery、JWKS、token 与 UserInfo 使用普通公开 HTTPS，出站只允许固定 issuer origin 与既定端点路径；未采用 Service Binding（绑定目标未经核实，不做猜测）。
- 登录 UI 与草稿保护（PR3，本地工作区）：[AuthStatus.vue](../src/components/auth/AuthStatus.vue) 显示登录状态、登录/退出与可读错误；账号面板与草稿提示分区显示，登录状态只由 `GET /api/auth/session` 决定。未保存输入写入独立草稿库（严格持久性），页面线索命中自动恢复、无线索时只提供恢复/放弃选择；新建草稿的页面立即占住草稿（Web Locks），其他窗口与复制标签页不能抢占。登录跳转只发生在草稿 `flush()` 成功之后，写失败或草稿库不可用时阻止跳转并提示；返回后恢复编辑现场，恢复的金额差异必须重新确认，退出不影响本机记录与未保存输入。
- Worker 与前端的产物与类型隔离（PR1）：client 构建输出与预缓存固定在 Build Output 的 Worker 资源目录（官方 `getWorkerAssetsDir` 路径函数对齐），Worker bundle 只含 Worker 代码；Service Worker 每次构建只生成一次，`navigateFallbackDenylist` 覆盖裸 `/api` 与 `/api/*`。

验证数据使用独立的 `hako-local-validation-v1` IndexedDB。当前只供测试，不自动当作未来已登录账号的数据。记录列表日常金额只显示实付。

## 2026-09-23 首轮验证

环境：Node 24.18.0、pnpm 11.25.0、本机 Chrome 153.0.8010.53。浏览器检查通过 Playwright CLI 操作实际生产构建；仅使用合成记录。

| 检查 | 结果 |
| --- | --- |
| `pnpm run typecheck` | 通过，包含应用与测试 TypeScript |
| `pnpm run test` | 15 个用例通过：表单规则、金额显示精度、真实 Loro 多副本合并、重复/乱序更新、完整历史和损坏快照拒绝 |
| `pnpm run build` | 通过；Wasm 约 3.27 MB，gzip 约 1.09 MB；预缓存约 3.4 MiB。这是浏览器构建，不是 Worker 包体或 CPU 验收 |
| 保存与重开 | 账单样例 7.94 × 43、优惠 300，实付 41.42；保存后刷新仍可读取 |
| 离线页面与写入 | 断网后重新打开已缓存页面，新增未加满记录，保存并再次刷新后仍存在 |
| 存储故障 | 注入 `QuotaExceededError`，界面不报成功、列表不新增、输入保留；解除故障后重试仅新增一笔 |
| 提交确认边界 | 在 IndexedDB put 成功事件后主动中止事务，仍不报保存成功，保留输入且不新增记录；解除故障后重试并刷新成功 |
| 同源双窗口 | 同时编辑同一记录的加油站与油品，保存并重开后两个修改均保留，记录数量不变 |
| 响应式布局 | 已查看 1440 px 和 390 px 宽度截图，390 px 无横向溢出；这不是 iPhone 真机验收 |

## 2026-09-26 操作流程复测

针对当前工作区重新运行测试与生产构建，并使用 Playwright CLI 的独立 Chrome 会话操作页面。环境：Node 24.19.0、pnpm 11.25.0、Chrome 153.0.8010.54（无界面模式）。仅录入合成数据，没有操作用户日常浏览器中的记录，也没有修改应用代码。

| 检查 | 本轮结果 |
| --- | --- |
| 自动化与构建 | `pnpm run test` 的 2 个文件、15 个用例全部通过；`pnpm run build` 通过，包含 `vue-tsc --noEmit` 类型检查 |
| 表单与加满记录 | 空必填项阻止保存；43 升 × 7.94 元自动得到应付 341.42 元，抵扣 300 元后实付 41.42 元；订单号、可开票金额保存后可重新读取 |
| 编辑与没加满记录 | 修改加油站不改变金额、不增加记录数；第二笔 20 升 × 8 元、优惠 0、没加满，实付 160 元；刷新后两笔记录均保留 |
| 双窗口同时编辑 | 两个窗口先打开同一笔记录，一个改加油站、另一个改油品，同时保存；两边列表自动显示两项修改，刷新后仍保留且不重复 |
| 离线保存与重开 | 浏览器网络设为离线并确认 `navigator.onLine === false`；刷新后新增一笔实付 60 元的记录，保存、再次刷新、关闭该标签页并离线重新打开，三笔记录均可读取 |
| 人工修正与金额差异 | 人工将实付改为 40 元，再改优惠，实付保持 40 元；有金额差异时必须勾选核对确认才能保存 |
| 存储失败与重试 | 注入 IndexedDB `QuotaExceededError` 后显示保存失败，输入保留、列表不新增；撤销注入后重试仅新增一笔，刷新后仍为四笔记录，实付保留为 40 元 |
| 持久存储申请 | 点击申请后，本次独立浏览器返回未授予；页面继续提示数据可能被清理，已有四笔记录保留，不误报已获得保护 |
| 浏览器控制台 | 本轮检查的两个标签页均无控制台错误或警告 |

本轮未发现阻塞上述操作的问题。首轮的 IndexedDB put 成功后中止事务注入和响应式截图检查未重复执行；iPhone 真机、跨设备同步与云端恢复仍未验证。测试会话内的四笔记录只用于验收，不会自动出现在用户日常浏览器中。

## 2026-09-26 合并前审查

审查范围为 `codex/local-first-validation` 相对设计文档合入后的 `main`：表单及数值规则、Loro 字段变更、IndexedDB 事务确认、多窗口协调、PWA 缓存与更新、依赖及相关文档。未发现需要阻止本地验证版合并的缺陷；这不代表完整首版或真机验收已经通过。

审查未修改应用代码，复用同日上节的 15 个自动化用例、类型检查、生产构建和浏览器操作结果。未保存草稿仅在页面内存中、重新编辑已保存记录时保留全部账单值，以及尚未接入登录和云端恢复，均作为本验证版的明确边界保留；本地验证数据不自动迁移为正式账号数据。

## 2026-09-26 登录接入准备

eruoo 的 Hako 客户端支持已合入并通过 CI；实现基线、双方合同及远端发布边界统一见[登录接入规格](./specs/eruoo-login-integration.md#2-当前实现与接入状态)。这完成了身份服务的源码前置，不代表 Hako 已有登录能力。

当时确定的下一步是按[最小登录切片](./specs/eruoo-login-integration.md#63-下一步-hako-最小实现范围)实现 Hako Worker、OIDC 回调与本应用会话；本地实现可与 eruoo 发布准备并行，真实联调等待对应环境就绪。同步、备份与 AI 不作为该切片的前置。

本次本地准备更新了文档并核对合同及引用。Hako 应用代码、依赖和构建输入未变，继续复用同日的测试、构建及浏览器证据，未重复运行应用检查或调用线上身份服务。

## 2026-09-27 身份服务上线

eruoo 任务已回传 staging 和 production 的发布与服务端验收结果，证据及未验证范围统一见[登录接入规格](./specs/eruoo-login-integration.md#2-当前实现与接入状态)。服务端发布前置已完成；下一步仍是实现 Hako 最小登录切片，再接正式服务验证完整登录与 iPhone PWA 行为。

本次只更新文档；Hako 运行代码、依赖和构建输入未变，复用 2026-09-26 的本地验证证据，未重复运行应用检查或执行部署。

## 2026-10-01 PR1 同源 Worker 与运行配置验证

PR1 在本地验证版之上引入 cf CLI + Cloudflare Vite 插件（beta）组合，交付同源 Worker、运行配置与登录配置合同。环境：Node 24.18.0、pnpm 11.25.0、Chrome 154.0.8037.59（无界面独立会话，仅合成数据）；锁文件新增 cf@1.0.0-beta.10、@cloudflare/vite-plugin@2.0.0-beta.sha-ad79608dd、@cloudflare/build-output-utils@0.8.2（workerd 构建脚本经 pnpm 供应链策略批准）。协议合同仍以[登录接入规格](./specs/eruoo-login-integration.md)为权威来源，未做真实登录或远端操作。

| 检查 | 结果 |
| --- | --- |
| `pnpm run test` | 4 个文件 73 个用例通过：既有 15 个表单/Loro 用例不变，新增 worker-api 23 个（方法、404、405、no-store、Host 无关）与 worker-login-config 35 个（缺 owner、非法 origin、本地与映射 IPv6 地址混入、回调不依赖请求） |
| `pnpm run typecheck` | 通过：`cf workers types` 生成 `.cloudflare/types`，vue-tsc（前端+测试）、`tsc -p tsconfig.worker.json`（Worker+配置）与 `tsc -p tsconfig.node.json`（vite.config.ts）分开检查 |
| `pnpm run build` | 通过（含类型检查后 `cf build --mode production`）；client 资产输出到 `.cloudflare/output/v0/workers/default/assets`，Worker bundle 仅 `index.js`（1.81 kB）与插件构建清单；SW 恰好生成一次，预缓存 8 项约 3.4 MiB 含 Wasm |
| 干净环境 | 删除 `.cloudflare/` 后完整 `pnpm run build` 通过（先生成类型再构建） |
| `cf deploy --prebuilt --dry-run --mode production` | 通过，无需凭据：读取 10 个资产文件，Worker 上传 1.77 KiB，绑定 ASSETS 与 HAKO_LOGIN 正确呈现 |
| `pnpm dev`（cf dev，1420） | 首页 200；`/api/health` 200 JSON no-store；HEAD 200；POST 405+Allow；`/api`、`/api/`、`/api/auth/callback`（含 `Sec-Fetch-Mode: navigate` 与 query）、未知深层 API 均 404 JSON no-store；`/unknown-spa-route` 回退首页 200 |
| `pnpm preview`（vite preview，4173，完整 Workers 产物） | 与 dev 相同的 API 分流结论全部复现；`manifest.webmanifest`、`sw.js`、workbox 与带哈希资产均 200 |
| 浏览器（SW 控制后） | `/api/health` 仍 200 no-store；`/api/auth/callback` 与裸 `/api` 仍 404 JSON（denylist 生效）；页面导航 `/api/auth/callback` 得到 JSON 404 而非首页 |
| 预缓存内容 | 仅 7 个唯一 client 资源（index.html、icon.svg、wasm、css、两个 js、manifest）；无 API 路径、无服务端 `config.json`/`worker.config.json`、无 Worker bundle 文件 |
| 离线 | 独立无头会话断网重开页面成功；离线录入 43 升 × 7.94 元/升（实付 ¥341.42）保存成功；离线再次刷新、恢复在线刷新后记录均为 1 笔且金额保留 |
| 控制台 | 除本验证脚本故意请求 404 端点产生的 3 条资源加载记录外，无其他错误或警告 |

已知边界：vite dev/preview 的 CORS 中间件会对所有路径的裸 `OPTIONS` 直接返回 204，不进入 Worker；生产边缘无此层，`OPTIONS /api/health` 的 405 行为由 worker-api 单测覆盖，未在本地端到端复现。这是本地预览工具行为，不是 Worker 路由差异。

## 2026-10-02 PR2 OIDC 登录事务、DO 会话与 eruoo 出站接线验证

PR2 实现登录后端：短期登录事务 + 标准 OIDC code flow（none + PKCE S256、openid profile、既定 resource、query 响应模式）、Hako 自己的持久会话与退出、SQLite Durable Object 原子状态，以及 eruoo 出站接线。协议合同仍以[登录接入规格](./specs/eruoo-login-integration.md)为权威来源；本 PR 不含登录 UI、草稿保护（PR3）、同步、备份或 AI。

本轮采用[规格第 6.1、6.2 节](./specs/eruoo-login-integration.md#61-本应用会话与-owner-配置)的建议值作为本地实施参数（事务 10 分钟、会话 180 天、续期间隔 24 小时、绝对上限 365 天），集中在 [session-policy.ts](../src/worker/auth/session-policy.ts) 定义并用可控时钟验证；这些仍是待产品/真机确认的建议值，不是已完成的产品确认。

环境：Node 24.18.0、pnpm 11.25.0；本地 workerd 由 cf CLI（1.0.0-beta.10）提供；使用合成 owner 与受控 OIDC 响应，没有真实 eruoo 登录、部署、远端 Secret 或域名操作。

| 检查 | 结果 |
| --- | --- |
| `pnpm run test` | 6 个文件 137 个用例通过：既有 15 个表单/Loro、worker-api 30、worker-login-config 35、worker-account-state 16、worker-auth-flow 41 |
| `pnpm run typecheck` | 通过 4 段：`cf workers types` 生成含 DO 导出与 RPC 类型的 Env；vue-tsc（前端+测试）；`tsc -p tsconfig.worker.json`（Worker+配置）；`tsc -p tsconfig.node.json` |
| `pnpm run build`（删除 `.cloudflare/` 后干净重建） | 通过；Worker bundle 含 DO 类，client 资产与预缓存范围与 PR1 一致；SW 恰好生成一次 |
| `cf deploy --prebuilt --dry-run --mode production` | 通过且无需凭据：`env.HAKO_ACCOUNT`（Durable Object，定义于 hako）、`env.ASSETS`、`env.HAKO_LOGIN`；Worker 上传 87.60 KiB（gzip 22.63 KiB） |
| 预缓存与 SW 分流 | 8 项/7 个唯一 client 资源（约 3.4 MiB，含 Wasm），无 API 路径、无服务端配置或 Worker bundle；`NavigationRoute` denylist 仍为 `^/api(?:\/|$)`，新认证端点同样不进预缓存与导航回退（PR1 的浏览器级 SW 证据继续适用，规则未变） |
| 产物秘密检查 | Worker bundle 与 client 资源中不含 owner 主体值；`worker.config.json` 中 `HAKO_OWNER_SUBJECT` 仅以 `secret` 类型出现，无值 |

协议与失败路径（worker-auth-flow，41 用例，真实 oauth4webapi + 受控提供方，真实 SQLite 状态）：

- 正常往返：发起登录 → 顶层授权 → 回调兑换 → 建立会话 → 读取状态 → 退出；校验授权地址参数、token 请求形状（none、PKCE、resource、无 client secret）、UserInfo Bearer 传递，并断言出站请求不带浏览器 `Cookie`/`Origin`/`Referer`。
- 失败路径均不建立会话：缺/错事务 Cookie、state 不匹配或缺失、其他环境 Cookie、回调重放、并发完成（仅一个成功）、事务过期、重复 `code`/`state`、错误或缺失 `iss`、取消（access_denied）、错误 nonce/aud/azp/at_hash/过期 ID token、不受信任签名、错误 PKCE、UserInfo sub 不一致、UserInfo 或令牌端点不可用。
- 等待 OIDC 兑换期间退出登录或同环境重新发起：旧回调返回 `invalid_login_transaction` 且不建立会话（受控出站闸门构造确定性的在途窗口）。
- 会话身份：固定 owner 变化后旧会话读取为未登录并清除 Cookie；缺少 owner 配置时带 Cookie 的读取返回配置错误。
- Cookie 属性：`__Host-hako_session` 与 `__Host-hako_login` 均为 `Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age` 且无 `Domain`；会话 Cookie Max-Age 为剩余有效期；退出清除两个 Cookie。
- 响应边界：回调最小 HTML 只含静态文本（无脚本、无第三方资源、不含 code/state/token），`no-store` 与 `Referrer-Policy: no-referrer`；API 失败不回退首页。

会话与事务语义（worker-account-state，16 用例，真实 SQLite + 可控时钟）：

- 事务消费一次；重复消费、未消费即完成、凭据/环境不匹配、过期都失败；失败尝试不消耗原事务；重新发起使同一环境旧事务与在途事务失效；退出使该环境未完成与在途事务都不能建立会话；创建新事务时清理过期事务行。
- 会话 180 天内有效、到期即失效；续期需距上次成功续期满 24 小时，取“当前时间加 180 天”与“创建时间加 365 天”中较早者，绝不缩短已保存有效期，也不越过 365 天上限；已撤销/过期会话不能续期，退出后到达的续期不会复活会话。
- 会话必须匹配固定 issuer 与 owner 主体：主体或 issuer 变化后读取与续期都失败。
- 重开同一 SQLite 文件（模拟进程重启）后事务与会话仍可读取，到期与身份判断不变；旧 schema（缺少 `issuer`/`consumed_at`）自动补列，旧会话按身份不匹配失效而新事务仍可完成。

真实 workerd + SQLite Durable Object 本地端到端（临时探针，未提交）：

- 用 `cf dev` 运行真实 Worker 与 Durable Object，出站经受控 OIDC 提供方（本地 HTTP，保持正式 issuer 与端点路径）：启动阶段 12 项检查、重启后 8 项检查全部通过。
- 重启持久化：会话在 dev server 重启后仍有效；重启前创建的未完成事务重启后仍能消费一次，重复完成被拒；退出后会话失效。
- DO 语义（同一真实 DO 的临时探针，14 项）：消费/重复消费、完成/重复完成、身份匹配与不匹配的读取、未到 24 小时不续期、到期续期、身份不符不续期、在途登录被退出取消、撤销后不可读且不续期，全部在 workerd + SQLite 上得到预期结果。
- schema 补列在 workerd 中复核：预置旧 schema 后重启 dev，`sessions.issuer` 与 `login_transactions.consumed_at` 被补上，旧会话行 `issuer` 为空而不可用，新会话正常写入。
- 持久化内容：DO SQLite 中只保存会话哈希、state 哈希与事务凭据哈希，明文 Cookie 与令牌不出现在 `.cloudflare/state`；会话时长落库为 180 天、绝对上限 365 天；退出写入 `revoked_at`。

只读核实（2026-10-02）：`GET https://auth.eruoo.me/.well-known/openid-configuration` 返回 200，包含 `userinfo_endpoint`、`code_challenge_methods_supported: [S256]`、`authorization_response_iss_parameter_supported: true`、`id_token_signing_alg_values_supported: [EdDSA, RS256]`、`subject_types_supported: [public]`，与 Hako 校验的 metadata 合同一致。Hako 采用普通公开 HTTPS 出站；未采用同账号 Service Binding，因为绑定目标未经核实，不做猜测。

未验证与保留边界：

- 真实 eruoo 登录、真实 owner 主体、线上 Worker 间可达性（含 Service Binding 方案）与真实 ID token 匹配仍未联调；本地只证明协议与受控响应正确。
- 登录 UI、草稿保护与返回恢复、跨 Cookie 环境的完成码后备交互（规格第 6.2 节的建议交互）均不在本 PR；`/api/auth/complete` 不存在，未知 API 返回 JSON 404，缺匹配事务 Cookie 一律安全失败。
- 未部署、未写远端 Secret、未绑定域名；未做浏览器/PWA 与 iPhone 真机验证。首次真实部署时 cf 应依据 `exports` 生成 SQLite Durable Object 类迁移，这一步没有真实部署证据。
- `cf dev` 的 `--persist-to` 未作用于 Vite dev server 实现，本地 DO 状态落在项目 `.cloudflare/state`（已被 Git 忽略）；清理 `.cloudflare/` 会清除本地合成会话与事务。

### 2026-10-02 PR2 审查修复（会话身份绑定与在途登录取消）

对 PR2 未提交差异做了独立内容审查，核对 OIDC 验证是否落在真实代码路径、事务单次消费与并发行为、DO 持久化与原子性、Env/绑定/响应边界。确认并修复两个问题，其余检查未发现阻塞项。

1. 会话未绑定固定身份（授权缺口）：会话行只按凭据哈希与有效期读取，配置的 owner `sub` 或 issuer 变化后，旧会话在最长 180 天内仍返回已登录，与“以固定 `(iss, sub)` 作为身份键”和“缺少配置时不能启用云端身份访问”不符。修复：`sessions` 增加 `issuer` 列，`readSession`/`renewSessionIfDue` 按固定 issuer 与 owner 主体过滤；带会话 Cookie 的状态读取在缺少有效登录配置时返回配置错误。回归覆盖见 worker-account-state 的身份用例与 worker-auth-flow 的“固定 owner 变化/缺少 owner 配置”用例。
2. 退出或重新发起与在途回调的竞态（会话复活）：原实现在回调开始时删除事务，OIDC 兑换期间执行的退出只删除“未消费”事务，因此竞态下兑换完成后仍会建立会话。修复：事务改为两阶段——消费时标记 `consumed_at`，身份验证成功后在同一个 SQLite 事务里删除事务并插入会话；退出与同环境重新发起都会删除事务，使在途登录无法完成。回归覆盖：worker-auth-flow 用受控出站闸门构造确定性的在途窗口，验证退出/重新发起后旧回调返回 `invalid_login_transaction` 且不产生会话。

其余核对结论：授权响应 state/iss 与重复参数、PKCE、ID token 签名与 claims、UserInfo `sub`、出站 origin/端点白名单、不转发浏览器 `Cookie`/`Origin`/`Referer`、方法/精确 Origin/no-store、回调安全页与 SW 边界均符合合同，并有对应用例；一度怀疑的“JWT 头部 base64url 长度导致解码失败”经实测不成立（合法 base64url 长度不可能 ≡ 1 mod 4）。

复核证据：`pnpm run test` 137 用例、`pnpm run typecheck` 4 段、删除 `.cloudflare/` 后干净 `pnpm run build`、`cf deploy --prebuilt --dry-run --mode production`（87.60 KiB / gzip 22.63 KiB），以及真实 workerd + DO 的 14 项探针与旧 schema 补列复核（见上）。审查未发现其它合入阻塞项；真实 eruoo 登录、线上可达性与真机验证仍按上方边界保留。

## 2026-10-02 PR3 登录 UI、草稿保护与返回恢复验证

PR3 把登录页面接到 PR2 的认证端点，并在跳转前保护未保存输入：登录状态区、登录/退出按钮与可读错误，草稿独立存储与恢复决策，写失败时阻止跳转，返回（成功、取消、失败）后恢复编辑现场。行为约定与完成边界以[登录接入规格第 6.2、6.3 节](./specs/eruoo-login-integration.md#62-浏览器--pwa-发起环境绑定)为权威来源；本 PR 不含同步、备份、AI 与完成码后备交互。

环境：Node 24.18.0、pnpm 11.25.0；`pnpm preview`（4173，Workers 运行时 + 生产构建）配合本机 Chrome（Playwright 1.63.0，临时脚本未提交）；`.dev.vars` 使用本地合成 owner 主体（按 [.dev.vars.example](../.dev.vars.example) 生成），登录流程用受控发起页与受控会话响应，没有真实 eruoo 登录、部署、远端 Secret 或域名操作。

| 检查 | 结果 |
| --- | --- |
| `pnpm run test` | 10 个文件 191 个用例通过；新增 auth-session-client 20、refueling-draft-session 25、refueling-draft-store 7、use-refueling-drafts 2，既有 worker-api 30（含回调返回入口）、worker-auth-flow 41 保持通过 |
| `pnpm run typecheck` | 通过 4 段：`cf workers types`、vue-tsc（前端+测试）、`tsc -p tsconfig.worker.json`、`tsc -p tsconfig.node.json` |
| `pnpm run build` | 通过；预缓存范围与 SW 分流未变（`^/api(?:\/|$)` denylist 仍生效） |
| `cf deploy --prebuilt --dry-run --mode production` | 通过且无需凭据：`env.HAKO_ACCOUNT`（Durable Object）、`env.ASSETS`、`env.HAKO_LOGIN`；Worker 上传 87.68 KiB（gzip 22.69 KiB） |
| 浏览器端到端（临时脚本，合成数据） | 74 项检查全部通过（分组见下） |

覆盖范围分期：本节最初报告的 170 用例 / 42 项浏览器检查只覆盖首轮实现；随后本地自审、父会话只读复核（第一轮 4 项 + 1 项风险，第二轮 2 项）又发现并修复 8 个缺陷，现行数字为 191 用例 / 74 项检查。首轮的“全部检查通过”不代表验收完成，以下缺陷均由后续复核推翻并回归。

草稿可靠性设计（实现与测试的对应关系）：

- 草稿存放在独立数据库 `hako-refueling-drafts-v1`，与 `hako-local-validation-v1` 业务数据分离；严格持久性写入并等待事务完成，其他窗口通知与业务文档互不影响。
- 恢复决策集中在 [draft-recovery.ts](../src/domain/refueling/draft-recovery.ts)：页面线索命中则直接恢复；无线索但有草稿时只提供“恢复/放弃”选择，绝不静默覆盖；新建草稿对应的记录已存在（保存已完成但清理失败）按幽灵草稿静默清理，避免重复新增；编辑草稿对应的记录已消失时保留数据但不提供恢复，并计数提示。
- 页面占用用 Web Locks 表达：新建草稿的页面立即占住该草稿，其他窗口与复制标签页（沿用了 sessionStorage 线索）无法抢占，只能看到“正被其他窗口使用”；浏览器在页面关闭或崩溃时自动释放。
- 登录跳转只在草稿 `flush()` 成功后执行；写失败或草稿库不可用时阻止跳转并给出可读提示，输入留在页面内，不用失败换一次导航。
- 登录状态只由 `GET /api/auth/session` 决定：回调结果页与返回后的页面都不把“URL 里出现过成功”当作已登录；退出保留本机记录与未保存输入。

浏览器检查分组（全部通过）：

- 登录 UI 与状态：初始未登录；回调成功结果页后按 session 响应显示已登录；退出后回到未登录且本机记录仍在。
- 草稿保护与恢复：新建草稿在跳转前落盘，离页不再弹确认；返回后恢复半成品数值、人工修正的实付与“计算来源”标记；恢复后的金额差异确认不被带入，必须由用户重新确认。
- 编辑模式与取消：编辑草稿经取消回调返回后仍处于编辑模式，保存后记录数不增加且提交的是本窗口修改；草稿写失败时未发生跳转并给出可读提示。
- 多窗口与复制标签页：新窗口只提供选择、不自动填充他人输入、不覆盖窗口 A 的输入；复制标签页（带同一线索）不领取正在使用的草稿。
- 服务不可用与错误态：会话接口不可用时显示“暂不可确认”，本机表单仍可用，服务恢复后可重新确认状态。
- 过期回调：回调结果为过期/失败时仍保持未登录，草稿与金额输入照常恢复，不因回调页出现过就把页面当作已登录。
- 离线：断网重开由 Service Worker 缓存承载，状态显示“暂时无法确认登录状态”，草稿已恢复；点击登录不跳转、不谎报结果，输入不丢。
- 多窗口占用：其他窗口正在编辑的草稿不出现在本窗口恢复列表，也没有被删除；窗口关闭释放占用后，新窗口才提供恢复/放弃选择并能恢复内容；复制标签页既不领取也不删除原草稿。
- 交接保护：本页还有未落盘内容的草稿保持占用，其他窗口既看不到也不能恢复；补写成功后才释放，随后其他窗口恢复到的正是本页最后写下的内容。
- 慢登录与写入失败：准备登录期间表单冻结、按钮显示忙碌、重复点击只发起一次请求，禁止再改输入；注入一次草稿写入失败后仍可继续编辑，重试成功才允许跳转，落库内容是最新版本而不是失败时的旧版本。
- Service Worker 与真实 Worker：SW 接管页面后 `/api` 请求仍走网络（未命中缓存）；真实 Worker 对非法回调返回安全结果页（`invalid_login_transaction`、固定同源返回入口、`no-store`）。
- 窄屏与可访问性：窄视口无横向溢出；登录按钮可获得键盘焦点；无控制台错误（受控 4xx 除外）。

独立内容审查（未提交差异，含新文件）：

- 审查范围：草稿存储与恢复决策、页面占用、跳转前落盘、登录状态来源、回调返回入口，以及上述行为对应的用例；对照[登录接入规格第 6.2、6.3 节](./specs/eruoo-login-integration.md#63-下一步-hako-最小实现范围)与数据边界（登录不认领既有验证数据、退出不删记录与草稿）。
- 发现 1（已修）：草稿库打开完成前（页面已可编辑）收到的输入只存在内存，`flush()` 会直接放行登录跳转，极端时序下跳转前的最后几次输入不会落盘。修复：接线层先缓存最新草稿，会话就绪且未采用既有草稿时补写一次；`flush()` 在未补写前返回 false，阻止跳转而不是跳过。
- 发现 2（已修）：草稿条目只校验外层结构，字段缺失或类型不符（以及编辑草稿缺少匹配基线）时会渲染成错误表单，并在保存时把损坏内容写成记录、甚至把编辑退化成新增。修复：草稿库按字段校验表单值与编辑基线，不合格条目按不可用处理、保留并计数（沿用“只统计不删除”的既有策略）。
- 其余核对结论：恢复决策（线索恢复/显式选择/幽灵清理/孤儿保留）、跳转前 `flush()` 顺序、回调结果页固定同源入口与 `no-store`、登录状态只由会话接口决定、退出不触碰本机数据，均符合约定且有对应用例；未发现其它合入阻塞项。
- 这一轮的两项修复随后被父会话复核证明仍不充分（写入队列的失败路径、占用探测本身），见下节。

父会话只读复核（用实际源码在内存中转译加载，无仓库改动）复现 4 项缺陷，均已修复并回归：

1. 旧写入失败覆盖新输入（P1）：`drainWrites` 的 catch 直接把失败版本放回待写槽，用户在写入在途期间的新输入会被较旧版本覆盖，`flush()` 却返回成功。修复：待写内容改为按草稿 id 合并的队列，失败时只在没有更新版本的前提下保留旧版本，`flush()` 只有在待写队列清空且无写入错误时才成功；切换表单不会挤掉另一份尚未落盘的草稿。回归：refueling-draft-session 新增“写入在途期间的旧版本失败不覆盖新输入”“切换表单时不会挤掉另一份仍未落盘的草稿”，浏览器新增 S12（注入一次写失败后落库的是最新版本）。
2. 占用探测误判并允许删除他人草稿（P1）：`isHeldByAnotherPage` 没有检查 `ifAvailable` 拿不到锁时回调收到 `null`，两个分支都判定“无人持有”。修复：探测按 `lock === null` 判定，锁 API 出错时按“可能被占用”处理；恢复、放弃、清理等危险操作在操作时重新原子占用，不再依赖列表快照。回归：refueling-draft-session 用 Node 真实 `navigator.locks` 覆盖探测/接管/出错保守判断与“他人持有的草稿不被列出也不会被放弃删除”，浏览器 S4 改为“其他窗口正在编辑的草稿不出现在恢复列表、没有被删除”，释放占用后才提供恢复选择。
3. 可见性刷新丢弃在途登录/退出且 busy 不复位（P2）：`runRefresh` 用同一个自增序号，刷新会取消在途命令，命令提前返回却不复位 `loggingIn`/`loggingOut`。修复：只读刷新与命令分开排序，刷新不递增命令序号，且只在“仍是最新刷新、期间没有命令、当前没有命令在途”时应用结果；命令的成功、失败与 `response.json()` 异步边界都带序号检查。回归：auth-session-client 新增在途登录/退出期间的刷新用例与登录失败用例。
4. 编辑保存成功后清理失败仍会提示恢复（P2）：`clearAfterSave` 清理失败时只有新建草稿的“记录已存在”路径能识别，编辑草稿仍被当成未保存候选。修复：保存成功后先写入草稿“已保存”标记再删除；标记或删除失败时消息不再承诺自动清理。恢复决策改用正面证据：有标记，或草稿的每处改动都已经体现在当前记录里（覆盖保存响应丢失/进程结束与“别的窗口改了其他字段”）；无法确认时保留草稿且不猜测。回归：refueling-draft-session 新增标记、改动已应用、其他字段被改、改动未应用四类用例。

父会话第二轮只读复核（同一源码定向回放，第一轮 4 项全部通过）在相邻时序上又复现 2 项，均已修复并回归：

5. 切换表单释放占用后旧页面补写覆盖新接管页面（P1）：`attachForm` 无条件释放旧 `currentDraftId`，而该草稿的待写/在途写入仍在队列里，drainWrites 稍后仍会写入——其他页面接管后会被旧版本覆盖。修复：待写/在途写入与页面占用同生命周期，只要本页还可能补写就继续持有占用，写完最后一份内容后才释放（`hasUnwrittenContent` / `releaseSettledClaim`）；`attach`/`adopt`/`discard`/`clearAfterSave`/`close` 的终止或等待路径同步核对（丢弃待写项时不写回）。回归：refueling-draft-session 新增“切换表单后仍持有占用，其他页面不能在补写完成前接管”（真实 Web Locks + 实际 session）与“在途写入结算前不释放占用”；浏览器 S14 覆盖“有待写内容的草稿不被其他窗口列出 / 没有被删除 / 补写成功后才允许恢复且恢复到最后写下的内容”。
6. 退出期间启动的状态查询在退出完成后恢复已登录显示（P2）：`runRefresh` 只记 `commandAtStart`，若刷新在 logout 开始之后发起、在 logout 完成后返回（读到退出生效前的旧会话），仍会被采纳。修复：刷新额外记录“启动时是否有命令在途”，命令执行期间启动的观察永不覆盖命令结果；JSON 解析边界同样检查。回归：auth-session-client 新增“退出期间启动的刷新不能在退出完成后恢复已登录显示”与“退出期间刷新所读到的 JSON 延迟返回时同样不覆盖结果”；浏览器 S13 用受控挂起的 logout + 延迟会话响应核对最终仍为未登录态。

父会话同时指出的源码可见风险（未在父侧复现，本侧浏览器定向核实并修复）：`login()` 只在请求登录前 flush 一次，登录等待期间表单仍可编辑，跳转前也没有再次确认，双击还可能并发发起登录。修复：登录流程加阶段门控（准备中冻结表单、记录列表与新增按钮，按钮显示忙碌），请求返回后再次 flush 确认，失败保留当前输入并解冻；重复点击不再是第二次请求。浏览器 S11 覆盖冻结、忙碌文案、重复点击只发起一次、期间无法改输入、返回后草稿仍是最新版本。

文档更正：`locks.query()` 提供的是锁管理器快照，问题不在于“只能看到当前上下文”，而在于快照不是原子判据，不能支撑恢复/删除/清理决定；占用判断必须用 `request(..., { ifAvailable: true })` 的原子结果并检查 `lock === null`（见 MDN 的 [LockManager.request](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request) 与 [LockManager.query](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/query)）。

修复记录（浏览器验证发现，均已回归）：

1. 自动恢复在存储层采用草稿但未回填表单：补 `adoptedDraft` 与 `applyAdoptedDraft`，页面在恢复后显式套用表单内容。
2. 首次挂载未绑定表单上下文，导致输入不写草稿：改为挂载时 `attachForm(ctx, { keepLocator: true })`，等 `initialize()` 读完线索后再清理由它清除的过期线索。
3. 恢复决策把“记录已存在的编辑草稿”误判为不可恢复：修正为只对 `create` 且记录已存在者按幽灵草稿清理，`edit` 且记录存在者正常恢复；新增回归用例。
4. 新建草稿的页面没有占住草稿：`updateDraft` 生成新草稿 id 后立即 `tryClaim`，复制标签页不再能领取正在编辑的草稿。
5. 页面占用探测原先依赖 `locks.query()`：快照不是原子依据（当时的说明误写成“只能看到当前上下文”，已在下方更正）；改为用 `ifAvailable` 原子获取探测并立即释放——但这次修改本身仍有缺陷，见第 7 项。
6. 本地自审发现：草稿库打开完成前的输入没有落盘路径，`flush()` 却会放行跳转；改为接线层缓存并补写，`flush()` 在补写完成前返回 false。
7. 父会话复核发现：上面第 5 项的探测实现漏判 `callback(null)`（探测恒为无人持有），且放弃/清理没有在操作时重新占用；改为按 `lock === null` 判定并要求危险操作重新原子占用。
8. 父会话复核发现：待写槽的失败路径会用旧版本覆盖新输入；改为按 id 合并的待写队列 + 队列清空才算 flush 成功。
9. 父会话复核发现：只读刷新会取消在途登录/退出并让 busy 永不复位；改为刷新与命令分开排序。
10. 父会话复核发现：编辑草稿保存成功后清理失败仍会出现在恢复列表；改为写入“已保存”标记 + “改动已体现在记录中”的正面判据。
11. 父会话指出的风险：登录等待期间页面未冻结、跳转前未复核落盘版本、双击可并发发起登录；改为阶段门控 + 二次 flush 确认 + 单飞。
12. 父会话第二轮发现：切换表单后旧页面仍可补写并覆盖新接管页面；改为占用与待写/在途写入同生命周期，写完才释放。
13. 父会话第二轮发现：退出期间启动的只读刷新会在退出完成后恢复已登录显示；改为命令执行期间启动的观察一律不采纳。

下一步的部署与联调执行清单（候选 SHA、域名、owner Secret、首次 DO 迁移、冒烟、出站联调、iPhone 与回退）见[登录接入规格第 8.1 节](./specs/eruoo-login-integration.md#81-hako-部署与联调执行清单本地准备未执行)，本轮只准备清单，未执行其中任何一步。

未验证与保留边界：

- 真实 eruoo 在线登录、真实 owner 主体、线上 Worker 间可达性（含 Service Binding 方案）与 iPhone Cookie 隔离下的完成码后备交互都未联调；本地只用合成身份与受控响应证明链路正确。
- 占用与删除保护用本机 Chrome 与 Node 真实 Web Locks 验证；跨浏览器/跨设备的锁与存储配额行为、以及父会话指出的“保存响应真正丢失”（网络响应而非本地事务）场景仍未经真机验证。
- 浏览器验证使用受控发起页替代 eruoo 授权页，回调结果页与非法事务页是真实 Worker 响应；这不等于真实登录已验证。
- PR3 差异只在本地工作区，未提交、未推送、未建 PR、未部署、未写远端 Secret、未绑定域名。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| [cloudflare.config.ts](../cloudflare.config.ts) | 唯一 Cloudflare 配置入口：Worker 名称/兼容日期、正式域名、`runWorkerFirst` API 分流、observability、登录配置绑定，以及 `HakoAccountDurableObject` 导出（sqlite）与 `HAKO_ACCOUNT` 绑定。 |
| [src/worker/index.ts](../src/worker/index.ts)、[api.ts](../src/worker/api.ts)、[http.ts](../src/worker/http.ts) | Worker 入口与 API 路由：健康检查（GET/HEAD）、`/api/auth` 命名空间分发、未知 API JSON 404（不回退首页）与统一 `no-store`。 |
| [login-config.ts](../src/worker/login-config.ts) | 登录配置合同：固定值与 owner Secret 的读取、校验、回调组装。 |
| [src/worker/auth/routes.ts](../src/worker/auth/routes.ts) | 认证端点：login/callback/session/logout 的 Origin 与会话校验、Cookie 设置与回调最小响应。 |
| [src/worker/auth/oidc.ts](../src/worker/auth/oidc.ts) | eruoo 出站接线：固定 issuer discovery 与端点半白名单、授权地址组装、code 兑换、ID token 签名与 claims、UserInfo。 |
| [src/worker/auth/account-state.ts](../src/worker/auth/account-state.ts)、[account-durable-object.ts](../src/worker/account-durable-object.ts) | 登录事务与会话的 SQLite 原子语义（消费、完成、过期、身份校验、续期、撤销）及 Durable Object 运行时包装。 |
| [src/worker/auth/account-rpc.ts](../src/worker/auth/account-rpc.ts)、[cookies.ts](../src/worker/auth/cookies.ts)、[secrets.ts](../src/worker/auth/secrets.ts)、[session-policy.ts](../src/worker/auth/session-policy.ts) | DO RPC 合同、Cookie 读写与属性、随机凭据与哈希、会话与事务时间参数（集中定义）。 |
| [App.vue](../src/App.vue)、[RefuelingWorkspace.vue](../src/components/refueling/RefuelingWorkspace.vue) | 页面组合、新增和编辑流程、保存结果衔接，以及草稿恢复横幅、登录后返回提示与登录跳转前的落盘等待。 |
| [AuthStatus.vue](../src/components/auth/AuthStatus.vue)、[useAuthSession.ts](../src/composables/useAuthSession.ts)、[session-client.ts](../src/domain/auth/session-client.ts) | 登录状态区（登录/退出/可读错误）、状态读取与跳转编排；发起地址只接受 https（本机 http 例外），网络失败不谎报成功。 |
| [useRefuelingDrafts.ts](../src/composables/useRefuelingDrafts.ts)、[refueling-draft-session.ts](../src/data/refueling-draft-session.ts)、[refueling-draft-store.ts](../src/data/refueling-draft-store.ts)、[draft-environment.ts](../src/data/draft-environment.ts)、[draft-recovery.ts](../src/domain/refueling/draft-recovery.ts) | 草稿会话（绑定表单、flush、采用/放弃、保存后清理）、独立草稿库（严格持久性）、sessionStorage 线索与 Web Locks 页面占用、恢复决策（线索恢复/选择/幽灵清理/孤儿保留）。 |
| [RefuelingForm.vue](../src/components/refueling/RefuelingForm.vue)、[form.ts](../src/domain/refueling/form.ts) | 录入、校验与核对确认；确定性表单规则、十进制计算和定点金额。 |
| [refueling-document.ts](../src/data/refueling-document.ts) | Loro 文档读写、字段级变更与完整历史快照。 |
| [local-refueling.ts](../src/data/local-refueling.ts) | Web Locks、最新快照读取、候选文档和 IndexedDB 严格事务。 |
| [useLocalRefueling.ts](../src/composables/useLocalRefueling.ts) | 页面状态、保存结果、窗口通知与聚焦刷新。 |
| [StorageStatus.vue](../src/components/refueling/StorageStatus.vue)、[vite.config.ts](../vite.config.ts) | 离线准备、持久存储申请、更新提示；cf/Vite/PWA 组合与预缓存范围。 |
| [refueling-form.test.ts](../tests/refueling-form.test.ts)、[refueling-document.test.ts](../tests/refueling-document.test.ts)、[refueling-draft-store.test.ts](../tests/refueling-draft-store.test.ts)、[refueling-draft-session.test.ts](../tests/refueling-draft-session.test.ts)、[auth-session-client.test.ts](../tests/auth-session-client.test.ts)、[worker-api.test.ts](../tests/worker-api.test.ts)、[worker-login-config.test.ts](../tests/worker-login-config.test.ts)、[worker-auth-flow.test.ts](../tests/worker-auth-flow.test.ts)、[worker-account-state.test.ts](../tests/worker-account-state.test.ts) | 表单规则、Loro 文档、草稿库与恢复/占用语义、认证客户端与跳转安全、Worker 路由/配置合同、登录协议与失败路径、DO 会话语义；受控 OIDC 提供方与 SQLite 账号状态见 [tests/helpers/](../tests/helpers)。 |
| [.dev.vars.example](../.dev.vars.example) | 本地合成 owner 主体示例；复制为 `.dev.vars` 使用（已被 Git 忽略）。 |

`src-tauri/` 保留早期原生骨架，当前交付方向是浏览器和 PWA，原生分发不作为前置。

## 本地查看

Node、pnpm 版本与运行命令以 [package.json](../package.json) 为准，依赖版本以[锁文件](../pnpm-lock.yaml)为准。`pnpm dev` 经 cf CLI 委派给 Vite（端口 1420）；`pnpm preview` 在 4173 端口以 Workers 运行时承载完整构建产物（先构建再预览）。

```sh
pnpm install --frozen-lockfile
pnpm run test
pnpm run build
pnpm preview
```

打开 `http://localhost:4173`，先联网等待离线页面准备成功，再测试断网。开发用 `pnpm dev`（当前端口为 `1420`，vite 仅监听 IPv6 `localhost`，`127.0.0.1` 可能不可达）；Service Worker 验证应使用生产构建预览。对已构建产物做无凭据部署演练：

```sh
pnpm exec cf deploy --prebuilt --dry-run --mode production
```

正式部署命令为 `cf deploy --prebuilt --mode production`（需在构建后执行，并完成域名绑定与 `HAKO_OWNER_SUBJECT` Secret 写入；本 PR 未执行部署、未写远端 Secret、未做 DNS 绑定）。

配置责任：`HAKO_LOGIN` 中的固定 origin、issuer、client、resource 是公开部署值，由 [cloudflare.config.ts](../cloudflare.config.ts) 声明并与[登录接入规格](./specs/eruoo-login-integration.md#3-客户端登记合同)保持一致；真实 owner 主体只能通过部署 Secret（本地用 `.dev.vars`，示例见 [.dev.vars.example](../.dev.vars.example)）输入，不进入前端、日志、公共配置或文档。`.cloudflare/`（类型与构建产物、本地 DO 状态）与 `.dev.vars` 均被 Git 忽略，类型由 `pnpm run typecheck` 先生成再检查。

登录后端与登录页面已随 `pnpm dev`/`pnpm preview` 提供：页面可读取登录状态、发起登录与退出。点击登录会跳转 eruoo 授权页，因此真实登录需要 eruoo 实际服务与真实 owner Secret；本地协议验证使用测试内的受控 OIDC 提供方（见 [worker-auth-flow.test.ts](../tests/worker-auth-flow.test.ts) 与 [tests/helpers/oidc-provider-mock.ts](../tests/helpers/oidc-provider-mock.ts)）。`GET /api/auth/session` 在未登录时返回 `{"authenticated":false}`，用于确认 Worker/DO 接线；`POST /api/auth/login` 与 `POST /api/auth/logout` 要求精确 `Origin: https://hako.eruoo.me`。

手工复核可先保存一条合成记录，再打开两个同源窗口编辑不同字段并依次或同时保存，刷新后检查两项都在；未保存的输入会在刷新或登录往返后从独立草稿库恢复，金额差异需要重新确认，另一个窗口正在编辑的草稿不会被静默接管。草稿写入使用严格持久性事务；草稿库不可用（例如浏览器禁用站点数据）时会阻止登录跳转而不是丢掉输入。

## 尚未完成

这不是可正式使用的首版：尚未真实 eruoo 登录与线上联调、跨设备同步、云端备份与恢复、历史查看/恢复界面、完整统计、历史导入和 AI 识图，隔离环境完成码后备交互（规格第 6.2 节建议）也未实现。同源 Worker、API 边界（PR1）、登录后端、DO 会话与 eruoo 出站接线（PR2）已就绪；登录 UI、草稿保护与返回恢复（PR3）已在本地工作区完成并验证，尚未提交。清除站点数据会丢失本验证版记录，当前不能从云端恢复。

真实登录、线上 Worker 间可达性（含 Service Binding 方案）、iPhone Chrome/PWA 真机行为、1,000/10,000 条含历史的容量与延迟、Cloudflare Free CPU 和其他平台仍按[后续验证安排](./specs/architecture-validation-research.md#5-下一步最小验证)执行。会话与事务的时钟边界已在 PR2 用可控时钟验证，但不代表真机 Cookie 保存行为已验证。本轮没有创建云资源、调用付费模型或部署；真实部署需先完成域名绑定与 owner Secret 写入，且尚未验证。
