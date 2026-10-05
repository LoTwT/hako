# 本地最小验证进展

更新：2026-10-05。设计文档 [PR #4](https://github.com/LoTwT/hako/pull/4)、本地验证版 [PR #5](https://github.com/LoTwT/hako/pull/5)、登录切片 PR1 至 PR3（[#7](https://github.com/LoTwT/hako/pull/7)、[#8](https://github.com/LoTwT/hako/pull/8)、[#9](https://github.com/LoTwT/hako/pull/9)）、页面门禁 [PR #10](https://github.com/LoTwT/hako/pull/10) 和账号同步 [PR #11](https://github.com/LoTwT/hako/pull/11) 均已合入；独立备份切片（[PR #13](https://github.com/LoTwT/hako/pull/13)、文案对齐 [PR #14](https://github.com/LoTwT/hako/pull/14)）已于 2026-10-04 合入、部署并完成首份真实备份读回，见[发布记录](./releases/2026-10-04-independent-backup.md)；恢复交付 A（[PR #18](https://github.com/LoTwT/hako/pull/18)）与 B（[PR #19](https://github.com/LoTwT/hako/pull/19) 实现、[PR #20](https://github.com/LoTwT/hako/pull/20) 浏览器修复）已于 2026-10-05 合入并分阶段部署，A 完成两端设备接受、B 完成两端备份列表与无变化预览的用户验收，见[恢复发布记录](./releases/2026-10-05-restore.md)。本文件维护实现进度、历史本地验证和运行入口；协议 v1 首次发布的精确候选、当时的平台读回与首轮真实协作验收由[同步发布与验收记录](./releases/2026-10-03-sync.md)（2026-10-03）维护，当前协议 v2 的 A/B 发布身份、平台读回与最新验收统一见[恢复发布记录](./releases/2026-10-05-restore.md)，产品规则仍以[重新设计记录](./specs/redesign.md)和对应专项合同为准。

当前状态：同源 Worker 承载 `/api`，登录、页面门禁、账号数据隔离与最小双副本同步均已部署；独立备份（2026-10-04）与恢复功能（同步协议 v2、备份格式 v2 及「备份与恢复」面板，2026-10-05）亦已部署，设备与用户验收范围见对应发布记录。普通浏览器双向同步、不同字段离线合并、本机草稿退出重登，以及 iPhone 主屏幕 PWA 登录、同步与联网重开已在首轮真实协作验收中通过；电脑为工具观察，手机为本人回报，范围与未知项见发布记录。账号存储、导入和持久确认以[账号同步规格](./specs/account-sync.md)为准，登录及期限以[登录接入规格](./specs/eruoo-login-integration.md)为准。

下文保留各阶段当时的验证和权限快照，包括当时的“未发布”“待真机验收”和临时回执存放说明；这些不代表当前状态或新的操作授权。首次部署和 UI 阶段分别见[首次登录发布单](./releases/2026-10-02-login.md)、[UI 发布记录](./releases/2026-10-02-ui.md)。本次文档收尾未重跑下文的应用测试或验收；原同步交付工作区及原始回执的缺口见[同步发布与验收记录](./releases/2026-10-03-sync.md#证据来源与原件缺口)。

## 已实现的范围

- 一页手填表单与记录列表：新增、编辑、是否加满、可选油灯及账单补充字段；金额联动、人工修正保护、精度与必填校验、金额差异确认和里程异常提示。
- Loro 字段级 Map 与完整历史快照；同源窗口使用 Web Locks 串行读取最新快照并写入字段变更。IndexedDB 快照、版本向量和待同步标记在同一严格持久性事务中保存，事务完成后才显示成功。
- 写入失败保留当前输入，不把失败修改留在可继续保存的共享文档中；重试复用记录 ID。BroadcastChannel 通知其他窗口重新读取，重新聚焦时也会读取最新版本。
- PWA 静态资源预缓存包含 Loro Wasm，可在首次准备成功后离线重开页面外壳；功能访问遵守[当前登录门禁](./specs/redesign.md#功能首页与页面切换)。提供持久存储申请和更新提示；新版本等待旧窗口全部关闭，不从某个窗口强制刷新其他窗口的未保存表单。
- 同源 Hako Worker（PR1，原生 `fetch`，无 Web 框架）：`/api` 与 `/api/*`（含页面导航请求）一律进入 Worker；`GET`/`HEAD /api/health` 返回简单健康状态，未支持方法返回 405 与 `Allow`，未知 API 返回 JSON 404，API 响应统一 `Cache-Control: no-store`。认证回调由下述 PR2 路由处理，不回退首页。非 API 请求由静态资产承载，SPA 回退仅作用于未命中资产的非 API 路径。
- [cloudflare.config.ts](../cloudflare.config.ts) 是唯一 Cloudflare 配置入口（PR1）：单个 `hako` Worker、正式域名 `hako.eruoo.me`（关闭 workers.dev）、兼容日期 2026-10-01、`assets.runWorkerFirst` 固定 `/api` 与 `/api/*`、observability 开启日志与 traces 并对 query 脱敏。工具链采用 cf CLI（`cf@1.0.0-beta.10`）与 `@cloudflare/vite-plugin@2.0.0-beta.sha-ad79608dd` beta 组合。
- 登录配置合同（PR1）：固定 origin、issuer、client、resource 以 `HAKO_LOGIN` JSON 绑定声明；owner 主体由 `HAKO_OWNER_SUBJECT` 后端 Secret 输入。Worker 在读取登录配置时执行校验（HTTPS origin 形态、拒绝本地/内网地址、非空 owner），回调由固定配置组装为 `${origin}/api/auth/callback`，不从请求 Host/Origin 推导。缺少 owner 无法取得有效登录配置，但类型生成、构建、健康检查与静态页面不依赖真实 owner；真实 owner 不进入前端、日志、公共配置或文档。
- 登录后端（PR2）：`POST /api/auth/login`、`GET /api/auth/callback`、`GET /api/auth/session`、`POST /api/auth/logout`。登录事务短期（10 分钟）、绑定发起浏览器环境（`__Host-hako_login`），回调到达时原子消费、OIDC 兑换完成后在同一 SQLite 事务里删除事务并插入会话；退出或同环境重新发起会删除事务，因此在途登录不会建立会话。回调使用 oauth4webapi 完成 state/iss 校验、PKCE S256 兑换、ID token 签名与 claims（nonce/aud/azp/期限/at_hash）验证、UserInfo `sub` 核对与固定 owner 比对；成功后才建立 Hako 自己的会话（`__Host-hako_session`，仅保存凭据哈希）。会话在服务端绑定固定 issuer 与 owner `sub`，状态读取与续期都要求身份匹配（缺少有效登录配置时带 Cookie 的读取返回配置错误）。凭证不进入响应体、日志或缓存；回调收尾返回最小静态 HTML（no-store、`Referrer-Policy: no-referrer`、不加载第三方资源），不回退首页。
- 账号级 SQLite Durable Object（PR2）：登录事务与会话状态在 `cloudflare.config.ts` 声明的 `HakoAccountDurableObject` 中原子处理（消费、过期、撤销、续期）；续期能力（24 小时间隔、180 天有效期、365 天绝对上限）已在 DO 内实现并由测试覆盖，PR2 阶段尚未接入前台同步，后续 PR #11 已完成该接线，没有新增保活接口；参数与兼容边界见登录规格。
- 出站接线（PR2）：discovery、JWKS、token 与 UserInfo 使用普通公开 HTTPS，出站只允许固定 issuer origin 与既定端点路径；未采用 Service Binding（绑定目标未经核实，不做猜测）。
- 登录 UI 与草稿保护（PR3，已合入）：[AuthStatus.vue](../src/components/auth/AuthStatus.vue) 显示登录状态、登录/退出与可读错误；账号面板与草稿提示分区显示，登录状态只由 `GET /api/auth/session` 决定。未保存输入写入独立草稿库（严格持久性），页面线索命中自动恢复、无线索时只提供恢复/放弃选择；新建草稿的页面立即占住草稿（Web Locks），其他窗口与复制标签页不能抢占。登录跳转只发生在草稿 `flush()` 成功之后，写失败或草稿库不可用时阻止跳转并提示；返回后恢复编辑现场，恢复的金额差异必须重新确认，退出不影响本机记录与未保存输入。
- Worker 与前端的产物与类型隔离（PR1）：client 构建输出与预缓存固定在 Build Output 的 Worker 资源目录（官方 `getWorkerAssetsDir` 路径函数对齐），Worker bundle 只含 Worker 代码；Service Worker 每次构建只生成一次，`navigateFallbackDenylist` 覆盖裸 `/api` 与 `/api/*`。

原验证数据使用 `hako-local-validation-v1` IndexedDB，后续账号切片保留它，由用户显式选择已保存记录导入；正式账号存储及导入语义只在[账号同步规格](./specs/account-sync.md)维护。记录列表日常金额只显示实付。

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
- 未部署、未写远端 Secret、未绑定域名；未做浏览器/PWA 与 iPhone 真机验证。首次真实部署时 cf 会提交 `exports` 中的 SQLite Durable Object 类声明，由平台协调创建 namespace；这一步没有真实部署证据，当前发布边界见[首次登录发布单](./releases/2026-10-02-login.md)。
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

当时准备的部署与联调执行清单（候选 SHA、域名、owner Secret、首次 DO 迁移、冒烟、出站联调、iPhone 与回退）见[登录接入规格第 8.1 节](./specs/eruoo-login-integration.md#81-hako-部署与联调执行清单)，本节记录的 PR3 轮只准备清单，未执行其中任何一步。

未验证与保留边界：

- 真实 eruoo 在线登录、真实 owner 主体、线上 Worker 间可达性（含 Service Binding 方案）与 iPhone Cookie 隔离下的完成码后备交互都未联调；本地只用合成身份与受控响应证明链路正确。
- 占用与删除保护用本机 Chrome 与 Node 真实 Web Locks 验证；跨浏览器/跨设备的锁与存储配额行为、以及父会话指出的“保存响应真正丢失”（网络响应而非本地事务）场景仍未经真机验证。
- 浏览器验证使用受控发起页替代 eruoo 授权页，回调结果页与非法事务页是真实 Worker 响应；这不等于真实登录已验证。
- PR3 已通过 #9 合入；上述验证属于实施及收尾会话的证据，不代表已部署、已写远端 Secret、已绑定域名或已完成真实登录。

## 2026-10-02 发布前准备与只读核查

本轮在独立 worktree 核对 GitHub main、主检出和候选 tree；修正文档，不修改应用源码、配置或依赖。Node 已变为 24.19.0，pnpm 仍为 11.25.0，因此重新执行锁文件安装、191 个单测、包含四段类型检查的生产构建及无凭据 prebuilt dry-run，全部通过。13 个构建产物与保留的 PR3 产物逐字节一致；74 项浏览器检查及收尾会话的六项定向复验据此复用，本轮未重跑浏览器。

本轮新核查确认 Hako Worker、版本、域名绑定及 DO namespace 尚不存在；已确认 Cloudflare 账号/权限、production discovery、活动服务端版本、只读客户端登记及 owner 安全输入来源。完整结果、产物哈希、失败恢复与下一轮授权范围统一见[首次登录发布单](./releases/2026-10-02-login.md)。没有部署、远端资源写入、真实认证事务或登录；本轮文档改动保持未提交、未推送。

## 2026-10-02 首次 production 部署与线上验收

父会话转交用户对发布单整组操作的「go」授权后，本会话完成写入前漂移检查，使用相同候选和已核验 prebuilt 产物部署。Cloudflare 读回确认活动版本、SQLite namespace 与绑定、Secret 名称、Custom Domain、受管 DNS、active 证书，以及关闭的 workers.dev/preview。线上 Worker 代码及抽查的 5 个前端资产与本地产物逐字节一致；精确 ID、时间、安全输入清理和恢复边界统一由[发布单第 4、5 节](./releases/2026-10-02-login.md#4-已授权远端操作与执行结果)维护。

新增检查包括匿名 HTTP 冒烟与隔离 Chrome 的 24 项线上检查。真实 Hako UI 已创建 DO 登录事务，并经公开 HTTPS discovery 到达 eruoo 登录页；Cookie 属性、受控错误/重复/退出后迟到回调、缺少原 Cookie 的隔离环境拒绝、返回与离线重载草稿保留、SW 下 API 分流均通过。没有由 owner 完成 GitHub/通行密钥交互，未验证成功会话或 token/JWKS/UserInfo 出站；受控 `access_denied` 不等于 provider 的人工取消，桌面隔离上下文不等于 iPhone 实测。

namespace 已有真实事务 RPC 证据，10:59 UTC 的管理 API 对象枚举也确认 1 个 `hasStoredData: true` 的实例；此前空列表的时间点保留于发布单。首次浏览器探针的响应采集限制和 cf 凭据过期后的读取重试同样保留；没有改应用代码、重新部署或改变接线。191 单测、四段 typecheck、build、dry-run、PR3 的 74 项浏览器检查及收尾六项复验继续按前节证据复用，没有重跑完整本地检查。

用户随后确认真实登录成功，原始回报及截图边界见发布单第 4.3 节。待补分项回报的退出/重登、返回草稿及离线记录、iPhone 浏览器与主屏幕 PWA 操作见[发布单第 6 节](./releases/2026-10-02-login.md#6-用户参与与仍未知的验收)。文档保持未提交、未推送；本会话未修改主检出或清理分支/worktree，但收尾发现 PR3 旧目录与 worktree 登记已消失，本地/远端分支仍保留，具体差异与父会话待核实项见发布单第 7 节。完成码后备交互仍未实现。

## 2026-10-02 回调结果页本地样式修订

用户确认真实登录成功，并提供已部署版本的 completed 成功回调截图；这不是对退出/重登、返回后的草稿恢复、浏览器具体版本或 iPhone/PWA 的分项验收。截图与授权范围以[发布单第 4.3 节](./releases/2026-10-02-login.md#43-用户确认与后续本地-ui-修订)为准，本轮没有重跑部署或线上认证。

回调页已在 [routes.ts](../src/worker/auth/routes.ts) 改为 Hako 浅背景、绿色主按钮和系统字体的紧凑静态卡片。8 种结果共用品牌、标题、说明与返回按钮，通过图标、文字及配色表达成功、取消/失效和失败；身份拒绝与配置失败改用面向用户的说明。局部 CSS 直接随 HTML 返回，窄屏可用，键盘焦点明显。原 HTTP 状态码、`data-hako-callback-status`、Cookie、安全响应头及精确 `<a href="/">返回 Hako</a>` 保持不变，没有脚本、外部资源或自动跳转。

| 本轮新执行的本地检查 | 结果 |
| --- | --- |
| `pnpm run test tests/worker-auth-flow.test.ts` | 41 个现有用例通过；首次因新增链接 class 与严格标签断言不一致而失败，改用卡片内 CSS 选择器后通过，未放宽原断言或新增 CSS 字符串测试 |
| `pnpm run build` | 通过，包含四段既有类型检查；没有升级依赖或改变配置 |
| 合成回调响应 | 从实际静态生成函数取 8 种结果，不发起认证；与 HEAD 的响应逐一比较，状态码、完整响应头（含合成 Cookie）和固定返回入口一致，没有脚本、外部资源或自动刷新 |
| 浏览器布局 | 本机 Chrome `154.0.8037.95`、Playwright `1.63.0`，禁用页面 JavaScript；1280×800 与 360×780 共 16 个状态/尺寸组合通过，无横向溢出，主按钮至少 48px，Tab 焦点为 3px 清晰轮廓；另检查 320×568 的最长拒绝说明，布局及按钮可见 |
| 实际图像检查 | 查看成功/身份拒绝的桌面和窄屏截图，以及取消/依赖失败的窄屏截图；留存 5 类结果、两种尺寸共 10 张 PNG，均包含键盘焦点状态 |
| 构建对比 | 默认 output 中仅 Worker bundle 改变，12 个其余文件与已发布候选一致；旧候选的 13 文件副本哈希仍匹配原发布清单 |

截图与脱敏回执保存在当前 worktree 的 `.cloudflare/callback-style-review/`，该目录被 Git 忽略，不随克隆转移。脚本仅用于本次本地验收，未加入项目测试套件；HTML 由实际回调生成函数生成并在 loopback 上供浏览器渲染，无真实 owner、事务或认证请求。

| 合成结果 | 桌面截图 | 窄屏截图 |
| --- | --- | --- |
| 成功 | `completed-desktop.png` | `completed-narrow.png` |
| 取消 | `authorization_declined-desktop.png` | `authorization_declined-narrow.png` |
| 失效 | `invalid_login_transaction-desktop.png` | `invalid_login_transaction-narrow.png` |
| 身份拒绝 | `owner_mismatch-desktop.png` | `owner_mismatch-narrow.png` |
| 依赖失败 | `identity_service_unavailable-desktop.png` | `identity_service_unavailable-narrow.png` |

`auth-tests.json`、`build.json`、`visual-review.json` 与 `artifact-comparison.json` 保存对应回执。新本地 Worker bundle SHA-256 为 `83acc2a03e79d37dd0e27ba46b37a5f7ce87a8ef0d12e9ac7659f70b223a8474`，仅供本次审阅，不是获准部署的新候选。此前完整协议、DO、191 单测与 74 项浏览器证据仍按原适用范围复用，没有重跑线上验收。

本阶段完成时，首页结构仍等待父会话回传选择，尚未改 App.vue、RefuelingWorkspace.vue 或其登录/草稿接线。后续获准的本地首页实施与验证见下一节。

本轮改动未提交、未推送、未部署，主检出保持干净。尚无用户对退出/重登、返回后草稿恢复、具体系统/浏览器版本或 iPhone/PWA 的分项回报；本地窄屏截图不能替代真机验收。

## 2026-10-02 功能首页与工作区切换本地验证

父会话已审阅回调 diff 与成功/拒绝截图并复用上述证据，随后授权继续用户“入口不直接展示加油功能”的本地修订。当时首页选项尚无用户明确回复，按父会话已告知用户的推荐最小方案制作预览。产品规则集中在[重新设计记录](./specs/redesign.md#功能首页与页面切换)，本节只维护实施与证据。下列首轮及 header 阶段记录保留历史结果；其中匿名/离线直接进入功能、未成功返回即显示表单的行为已由后续[登录门禁验证](#登录后访问首页)替代，不作为当前门禁的通过证据。

[App.vue](../src/App.vue) 承担两页外壳、单一账号状态、PWA 注册及登录编排；[RefuelingWorkspace.vue](../src/components/refueling/RefuelingWorkspace.vue) 保留业务表单和既有草稿会话，向外暴露落盘结果与保存状态。首页初次不挂载工作区，进入后用同一实例隐藏/显示；没有复制账号 client 或改动 IndexedDB/Web Locks 底层。登录仍双次 flush，应用层冻结涵盖隐藏的表单和页面导航；进入离页阶段后等待 Vue 把状态传给工作区，再跳转，避免错误触发草稿离页提示。恢复/放弃按钮也随冻结禁用。AuthStatus 简化重复说明并保证窄屏布局与触控目标。

本轮新增验证使用本机 Chrome `154.0.8037.95`、Playwright `1.63.0`，从生产前端产物启动 loopback 静态预览与合成 session/login/logout。数据、身份状态和失败注入均为本地合成；没有调用 Worker 认证端点、production、eruoo 或真实账号，没有保存 HAR/trace。

| 验证 | 实际结果 |
| --- | --- |
| 既有相关单测 | `auth-session-client` 20、`refueling-draft-session` 25、`use-refueling-drafts` 2、`refueling-form` 11，共 58 项通过；未新写 CSS 字符串断言或重跑全套 191 项 |
| 类型与构建 | `pnpm run build` 通过，包含既有四段类型检查；配置、锁文件与依赖未变 |
| 首页与导航 | 首开没有表单或业务/草稿库打开；单账号状态区。入口与返回、浏览器前进/后退保留同一表单；首页刷新仍为首页，工作区刷新恢复原页面。初始首页登录不凭空创建草稿 |
| 新增及编辑草稿 | 切页保留原始输入与来源、当前新增/编辑上下文；首页刷新后重新进入仍可恢复。页面内隐藏/显示保留已核对状态，刷新或模拟登录返回的恢复必须重新核对金额差异 |
| 占用及在途写入 | 隐藏工作区仍持有原草稿 Web Lock，第二窗口不能接管；实际 IndexedDB 写事务被合成延迟时，切页不卸载、不释放锁，登录等到事务完成后才发起 |
| 登录与退出 | 合成成功及未成功的固定 `/` 返回均恢复发起页面；只有 session 响应改变账号显示。两次 flush 任一次失败均阻止跳转，首轮失败还阻止发起请求；隐藏草稿失败在首页账号区可见。退出保留输入、草稿和占用。合成授权页浏览器返回恢复可编辑状态；另触发 `pageshow(persisted)` 分支，不据此宣称原生 bfcache 跨浏览器兼容已验收 |
| 线索与离线 | 任意 URL 形状的导航线索不会成为跳转目标或登录依据；sessionStorage 不可用时回到首页，草稿可手动恢复。真实 Service Worker 预缓存下断网刷新首页、进入工作区、恢复并继续写草稿通过 |
| 布局与键盘 | 1280px 桌面、360px 窄屏及 320px 补充检查无横向溢出；功能链接键盘焦点清晰、Enter 可进入并将焦点移到标题，账号按钮与返回入口至少 44px。实际查看首页及工作区桌面/窄屏截图 |

定向浏览器回执汇总为 50 项去重检查。初次探针的状态选择器命中隐藏的 StorageStatus、datetime-local 秒数被 Chrome 规范化，以及 Playwright 对 fieldset 的 `isDisabled` 判定导致检查中断；改用限定账号区、规范化时间及原生 `fieldset.disabled` 后完成。窄屏首次 fullPage 截图出现捕获重复，改为固定宽度、按完整内容高度设置视口后直接截图；未修改产品代码来迁就探针，也未把这些中断记为应用通过。完成的布局/导航阶段按回执复用，只续跑受影响及剩余场景。

截图与临时脚本保存在当前 worktree 的 Git 忽略目录 `.cloudflare/home-review/`，不随克隆转移：

| 页面 | 桌面 | 窄屏 |
| --- | --- | --- |
| Hako 首页（键盘焦点） | `home-desktop.png` | `home-narrow.png` |
| 加油记录工作区 | `refueling-desktop.png` | `refueling-narrow.png` |
| 合成已登录首页 | 共用同一布局 | `home-authenticated-narrow.png` |

`browser-review.json` 汇总分段浏览器回执，`unit-tests.json`、`build.log` 和 `final-verification.json` 保存本轮验证及产物清单。已部署旧候选的 13 个文件副本仍逐项匹配原 SHA-256 清单；callback 源码与本地 Worker bundle 的哈希仍与上一节一致，因此复用 41 项认证测试和 callback 布局证据，没有重做该修订。默认 `.cloudflare/output/v0/` 现为待审 UI 产物，不能沿用旧候选的部署授权。

本轮全部代码与五份文档保持未提交、未推送、未部署；主检出干净。该阶段移交后用户继续给出页面反馈，落实见下节。真实环境的退出/重登、返回后会话与草稿、具体浏览器版本及 iPhone/PWA 分项仍未知；本轮合成返回、离线和窄屏证据不扩大既有线上验收结论，完成码后备交互仍未实现。

### Header 登录入口调整

按[重新设计记录中的最新反馈](./specs/redesign.md#功能首页与页面切换)，将同一 AuthStatus 实例移入共用 header，使用简短的真实状态、登录/退出按钮和有可访问名称的重新检查图标。App 将登录/退出命令失败反馈交给该处展示；状态不可用和草稿保存失败仍显示可读说明。其余首页、功能入口、表单和草稿生命周期保持上阶段实现。

重新执行 `pnpm run build`（含四段类型检查）通过。以新生产前端产物和 loopback 合成 API 完成 26 项定向浏览器检查：header 的单实例、键盘焦点、44px 操作目标、1280/360/320px 布局、状态刷新、登录/退出失败反馈、合成登录返回和退出保留草稿，以及隐藏草稿的双次 flush 失败/在途事务保护全部通过。复用上阶段 58 项单测与其余适用导航/草稿证据，没有重跑完整验收或真实认证。

该阶段截图和回执保存于 `.cloudflare/header-review/`：`home-desktop.png`、`home-narrow.png`、`refueling-desktop.png`、`refueling-narrow.png`、`home-authenticated-narrow.png`、`header-unavailable-narrow.png`，以及 `browser-header.json`、`build.log`、`final-verification.json`。旧 `.cloudflare/home-review/` 截图与回执作为上阶段记录保留；已部署候选快照和 callback 证据继续保留。本次未提交、未推送、未部署，真实分项验收边界不变。

### 登录后访问首页

用户随后明确要求未登录跳转登录、登录后才能看到首页。App 在原有单一会话状态上增加展示门禁和固定 `/#login` 页面；新增 LoginPage 仅接收状态、发出登录/重试事件，不创建第二个账号 client。已打开的工作区隐藏时继续保留草稿会话、在途写入和 Web Lock；登录双次 flush 与固定回调入口不变。AuthSessionClient 仅调整状态文案，协议和命令竞态处理未变。产品规则与离线访问边界仍只由[重新设计记录](./specs/redesign.md#功能首页与页面切换)维护。

本轮重新通过认证客户端 20 项既有测试与 `pnpm run build`（含四段类型检查）。使用同一 Chrome / Playwright 工具链、当前生产前端产物与 loopback 合成 API，40 项定向浏览器检查全部通过，无未预期页面错误：

| 验证 | 实际结果 |
| --- | --- |
| 首开与直接访问 | 会话请求等待期间、匿名响应及刷新均不显示首页/表单，不打开业务或草稿库；直接访问加油 URL、本机假登录标记和历史返回不能放行 |
| 合成登录返回 | 失败后留在登录页且不自动发起事务；固定 `/` 返回不足以放行，正面的 session 响应才恢复首页或原加油页；sessionStorage 不可用时安全回到首页 |
| 退出与草稿 | 退出或会话失效隐藏、冻结原工作区并保留原实例、编辑上下文和草稿锁；重新认证恢复新增/编辑草稿，重载恢复仍要求重新确认金额差异 |
| 登录前持久化 | 首次及二次 flush 失败均阻止跳转，首次失败还阻止发起登录请求；重试写入最新输入。在途 IndexedDB 写入和锁在门禁关闭后仍保留，重新认证等待其完成 |
| 离线及恢复文档 | 实际 Service Worker 预缓存下断网重载留在登录页，草稿仍在；恢复网络并确认会话后重新打开工作区。合成 `pageshow(persisted)` 等待新会话结果时隐藏旧内容，两处触发合并为一次请求；匿名结果保持门禁且未丢弃原草稿 |
| 布局与键盘 | 1280px 桌面、360px 窄屏及 320px 补充检查无横向溢出；登录按钮至少 48px，键盘焦点明显。实际查看登录页、服务不可用页与已登录首页截图 |

最新证据保存在 Git 忽略目录 `.cloudflare/login-gate-review/`：`auth-client-tests.json`、`browser-all.json`、`build.log`、`final-verification.json`；截图为 `login-desktop.png`、`login-narrow.png`、`unavailable-narrow.png`、`home-authenticated-desktop.png`、`home-authenticated-narrow.png`。此前 38 项草稿/表单测试、callback 的 41 项认证测试及布局证据按未变范围复用；未重跑全套验收。已部署候选 13 个文件的副本与原清单仍匹配，旧回执未覆盖。

本轮不调用真实认证或远端资源，不保存 HAR/trace。合成缓存文档事件不能证明原生 bfcache 的跨浏览器行为；真实退出/重登、返回会话与草稿、具体用户浏览器及 iPhone/PWA 仍待分项验收。全部本地代码和文档未提交、未推送、未部署，主检出保持干净。

## 2026-10-02 最终审阅与发布授权

用户选择执行最终审阅与提交发布。最终 diff 未发现阻塞问题；源码及产物与门禁阶段回执一致，因此复用上述适用验证，没有重跑完整测试或真实认证。GitHub main 仍为首次部署候选，eruoos 写权限已确认；目标仓库没有工作流、分支保护或规则集，不将本地结果称为 GitHub 绿色 CI。提交、合并候选和部署回执由[本轮发布记录](./releases/2026-10-02-ui.md)引用维护。保留任务分支/worktree，主检出保持不改动。

## 账号数据隔离与双副本同步本地切片

本节及其审阅修复记录保留实施时的验证结果；后续已合并、部署及真实验收的状态见[发布交接](#后续发布交接)。本节列出的临时文件是原工作区当时的回执位置；现有原件缺口见[同步发布记录](./releases/2026-10-03-sync.md#证据来源与原件缺口)，本次没有重新生成或验证这些文件。

2026-10-02，在 `lody/3f59d413-f7d` 独立 worktree 完成；基线 HEAD `e3d44d9d413d80376c9502431c72d5ea3b379138`、tree `61d1915b75656b897f6259c3daa16052cd7b9924`，进入时干净。账号、导入、同步接口与确认合同集中在[账号同步规格](./specs/account-sync.md)，不修改已发布 UI 的发布记录或借用其授权。

实现包括 session 返回随机账号标识、记录/草稿/锁/定位线索按账号隔离，保留既有 DO 内会话并新增账号文档表，完整 Loro 快照交换、前台自动同步与真实状态，以及逐条选择旧验证记录的导入入口。首页打开账号副本进行同步，表单仍首次进入加油页才挂载。新文件职责、参数及导入历史边界不在此重复定义。

验证环境：Node 24.19.0、pnpm 11.25.0、Loro 1.16.3、Chrome 154.0.8037.95、Playwright 1.63.0；本地 workerd/SQLite DO 由仓库锁定工具链中的 Miniflare 5.20260930.0-alpha 驱动。临时 loopback HTTPS 适配层加载生产构建的同一 Worker/前端产物及构建配置，仅提供合成 owner 与合成会话；以既有 DO 事务 RPC 建立测试会话，不增加产品测试端点，不访问 eruoo、不创建真实认证事务。浏览器本机 Origin 在此适配层转换为固定配置 Origin；错误/缺失 Origin 的拒绝另外由协议测试覆盖，不把该测试适配层当作生产接线。

| 检查 | 已确认结果 |
| --- | --- |
| 自动化回归 | 全套 13 个文件 207 项通过；包含新增账号协议/SQLite、IndexedDB、同步调度及账号标识校验，既有 OIDC、表单、草稿与恢复回归继续通过。另新增 1 项多分块历史原子回滚用例，Worker 同步文件共 6 项再验全部通过；去重共 208 项用例。 |
| 构建与类型 | `pnpm run build` 通过，包含四段类型检查。依赖、锁文件、Cloudflare 配置未变；Worker Wasm 作为编译模块输出，前端预缓存仍只包含自身资产。 |
| 本地打包演练 | 锁定 `cf deploy --prebuilt --dry-run --mode production` 成功；Worker 总上传大小 3588.88 KiB / gzip 1133.92 KiB，绑定名称和 DO 类不变。没有执行部署、上传 Secret 或远端迁移。 |
| 两份独立副本 | 两个独立 Chrome BrowserContext，不共享 Cookie/IndexedDB。A 新增经实际 Worker/SQLite DO 到达 B；两端离线修改不同字段后联网收敛。单元测试另覆盖同字段竞争、重复/过时提交及完整历史 checkout。 |
| 持久确认与中断 | 实际 DO 写入完成后截断 HTTP 响应，A 保持待传并自动重试，B 已能读取服务端内容，最终没有重复记录。延迟响应期间新增的记录仍待传并最终到达另一端；本机 put 成功后中止事务、SQLite 写失败均不确认成功。 |
| 离线门禁与草稿 | 实际 Service Worker 接管后断网保存，再离线重载停在登录页；恢复网络及 session 确认后恢复记录/草稿并续传。重载恢复的金额差异确认重新变为未勾选。 |
| 退出与占用 | 首页隐藏工作区、退出及同账号合成重登保留原草稿实例和 Web Lock；同源第二标签页不能接管占用。 |
| 账号切换 | 延迟 A 的成功同步响应，切换服务端合成 owner 并确认 B 后，A 响应被丢弃。B 的记录、表单和草稿独立；切回 A 恢复原记录和未保存输入。协议测试覆盖伪造账号 ID、旧会话和合并前撤销。 |
| 旧验证接入 | 正式库首次为空且不读取旧库；不存在旧库时主动预览也不创建。浏览器逐条勾选一条后只有所选记录到达 B，未选内容不上传，原旧库快照逐字节相同。重复导入不覆盖后续编辑，写失败后记录与导入映射一起回滚。 |
| 重启恢复 | 关闭并重建本地 workerd，使用既有合成会话、全新第三 BrowserContext，从 SQLite 恢复四条记录及合并字段。未清空或重建 DO 数据。 |
| 页面与布局 | 浏览器 11 组行为场景全部通过，无未预期 pageerror。新增导入选择与同步操作在 1280、390、320px 补验，无横向溢出；新操作按钮至少 44px，选项标签至少 48px。实际查看桌面与窄屏截图。 |

验证中修正：旧库不存在时中止建库产生未处理的事务拒绝；网络异常直接显示浏览器英文消息；新增导入复选框受全局 input 宽度影响。这些均已修复并按影响范围复验。测试准备还修正了合成会话的哈希编码、Node SQLite 的 ArrayBuffer 绑定适配、Miniflare 5 的配置形态及浏览器选择器；这些中断不记作应用通过。直接断开未开始的响应可能被浏览器自动重试，最终使用已发送部分正文后截断的方式确认应用层重试。账号切换后保留隐藏实例，因此检查限定当前可见工作区。

本地临时工具和脱敏回执在 Git 忽略的 `.cloudflare/sync-review/`：`browser.mjs`、`browser-result.json`、`layout.mjs`、`layout-result.json`、`unit-tests.json`、`dry-run.log`、`chunk-test.log` 及截图；构建日志为 `.cloudflare/sync-build.log`。`candidate-files.json` 固定本次未提交候选文件、最终构建产物和回执的 SHA-256，供后续审阅核对，不是发布授权。最后的生命周期防护与复选框样式调整不改变同步协议，复用 11 组行为结果，对最终产物补验启动/同步/导入预览与布局。临时工具没有加入依赖、常规构建或 CI；需要回归维护的协议、数据与调度用例保存在 `tests/`。

未验证：真实线上双物理设备、iPhone/Android/安装 PWA、原生 bfcache 跨浏览器、production CPU/大规模容量、真实账号首次导入，以及既有真实退出/重登/草稿往返的分项验收。当前没有 R2 独立备份、整库恢复、完成码、AI 或完整统计。本地服务端副本恢复测试不扩大成线上备份恢复承诺。

### 2026-10-03 审阅修复

用户要求修复审阅发现的三项问题，继续只做本地修改。旧记录额外字段能够绕过写入前校验，导致导入成功后正式库无法再加载；同步的迟到 `Set-Cookie` 会覆盖另一窗口的新登录；服务端首次续期响应丢失后，重试不补发 Cookie 期限。审阅均以合成数据复现，没有读取或导入真实旧库。

本机持久化入口现在在提交前执行与加载/同步相同的正式文档校验，不支持的导入整批失败，已保存文档与导入映射不变。服务端续期与浏览器 Cookie 保存期限分离；新登录策略及既有 Cookie 的兼容边界由[登录合同](./specs/eruoo-login-integration.md#61-本应用会话与-owner-配置)维护。所有会话 Cookie 写入点检查后，另外移除了失效 session 的只读响应清 Cookie 行为；只有成功登录和显式退出仍写会话 Cookie。未改变有效期、撤销和绝对上限的服务端授权检查，也未迁移/重建 DO 会话。

| 检查 | 已确认结果 |
| --- | --- |
| 回归红绿 | 新增/调整的导入、Cookie 顺序和期限检查在修复前实际失败，修复后相关 3 个文件 55 项通过；全套 13 个文件 211 项通过。回归用例留在既有 `local-account-storage`、`worker-sync`、`worker-auth-flow` 测试文件。 |
| 新登录期限与丢失响应 | 受控 OIDC 提供方走实际登录路由；临近原有效期时续期成功但丢失响应，重试后登录 Cookie 仍覆盖服务端新期限。越过原有效期仍可访问，服务端实际过期时即使 Cookie 仍保留也拒绝。使用可控时钟，不宣称等待了真实长期周期。 |
| 实际 Worker 与浏览器 | 最终构建的本地 Worker/SQLite DO 与 Chrome 通过 4 组补验：迟到同步响应不覆盖新登录、迟到失效读取不清除新登录、真实 IndexedDB 导入失败保留原库和选择且改选可恢复、另一独立浏览器存储上下文仅收到有效记录。无 pageerror；登录会话仍用合成 RPC 建立，没有真实认证往返。 |
| 构建与打包 | `pnpm run build`（含类型检查）及 `cf deploy --prebuilt --dry-run --mode production` 通过；本次 Worker 为 3588.66 KiB / gzip 1133.91 KiB。未执行部署。 |

本次回执在 `.cloudflare/sync-review/` 的 `fix-red.log`、`fix-cookie-red.log`、`fix-green.log`、`fix-unit-tests.json`、`fix-build.log`、`fix-dry-run.log`、`fix-browser.mjs`、`fix-browser-result.json` 和实际查看的 `fix-import-rejected.png`。浏览器补验最初两次分别因选择器误含分隔符、未等待异步预览完成而中断；修正临时脚本后四组通过，这两次中断不记作应用失败或通过。既有双副本、草稿、离线门禁与布局证据按未变范围复用，未盲目重跑全部 UI 验收。

审阅前清单保留为 `candidate-before-fixes.json`；`candidate-files.json` 更新为修复后的源文件、最终构建与回执哈希。修复仍未提交、推送或部署；真实设备及线上验收边界不变。

### 2026-10-03 父会话结构复核与修复

父会话补充复现了第四项 P2：`validateSyncDocument` 与 `readRecords` 依赖有损 JSON 投影，错误类型的根、`__proto__` 隐藏键及 Text/Counter 字段能进入权威快照。问题是文档结构和合并合同被破坏，没有发现或声称跨账号鉴权绕过。此次继续修复同一候选，前述导入与 Cookie 修复保留。

修复改用原始容器句柄、根 ContainerID 和 Map 条目。完整历史的根检查避免同名异型根被当前投影遮挡；字段仍沿用既有定点数与业务验证。正式写入前统一校验；旧记录导入按允许字段构造，失败不改变快照、确认或导入映射。具体合同由[账号同步规格](./specs/account-sync.md)维护。相同模式检索覆盖 `src/`：两处文档/记录 `toJSON()` 投影均已替换；剩余 `toJSON()` 仅为版本向量的原生 Map 枚举，不承担结构或字段校验。旧库读取复用原始记录读取，非法容器不能再被预览成合法标量。

| 检查 | 已确认结果 |
| --- | --- |
| 红绿回归 | 修复前 3 个测试文件实际有 13 项失败（含 API 错误返回 200、本机接受非法候选）；修复后相关 4 文件 33 项通过。最终全套 14 文件 **227 项通过**。新增 `sync-document.test.ts` 与既有 Worker/IndexedDB 测试覆盖空快照、普通记录、90 字符标量并发和完整历史、11 类非法结构、空异型根、SQLite 重开以及失败时既有快照/确认/映射不污染。 |
| 实际 Worker 与双副本 | 最终产物的本地 workerd/SQLite DO + Chrome 154.0.8037.95 通过 6 组补验：有效旧记录仅复制选中项；11 类非法请求全为 422；workerd 重启保留此前历史版本和两条记录；浏览器拒绝标头正确但含 Text 字段的成功响应，仍显示待传且完整本机存储对象不变；旧库含嵌套容器时预览失败并保留两库；恢复正常响应后重试，第二独立 BrowserContext 得到三条合法记录。无 pageerror，实际查看失败状态截图。 |
| 构建与打包 | `pnpm run build`（含类型检查）及 `cf deploy --prebuilt --dry-run --mode production` 通过；Worker 为 **3589.06 KiB / gzip 1134.05 KiB**。没有升级依赖、修改资源配置或执行部署。 |

新回执在 `.cloudflare/sync-review/`：`schema-red.log`、`schema-green.log`、`schema-unit-tests.json`、`schema-build.log`、`schema-dry-run.log`、`schema-browser.mjs`、`schema-browser-result.json`、`schema-browser.log`、`schema-response-rejected.png`。本轮浏览器脚本首次执行即完成六组。`candidate-before-schema-fix.json` 保存上一阶段 42 文件 / 14 产物 / 20 回执清单，原始 `candidate-before-fixes.json` 的 41 文件 / 14 产物 / 12 回执继续保留；最终 `candidate-files.json` 重新锁定本轮源文件、构建和回执，不覆盖旧回执内容。

复用范围：原 11 组中的门禁、草稿、离线与迟到响应世代行为，3 个宽度的布局证据，以及上一阶段 Cookie 交付四组证据中未改变的登录/退出路径。文档读取、导入、同步持久确认及最新 Wasm/浏览器产物由本轮结果覆盖。所有会话和记录都是合成数据；未验证真实线上双设备、真实导入、移动设备/PWA、production CPU 或大规模容量，没有远端迁移或独立备份验收。

### 后续发布交接

上述本地验证收口后，代码已通过 [PR #11](https://github.com/LoTwT/hako/pull/11) 合并，精确候选随后获另行授权并部署。桌面 Agent 与用户 iPhone 协作完成了首轮核心真实验收。精确提交、部署身份、最后读回时间、各项观察与未验边界统一见[同步发布与验收记录](./releases/2026-10-03-sync.md)；本地 227 项测试和 workerd/SQLite DO 结果仍是实现阶段证据，不是本轮重新执行或真机结果。

原同步交付会话已归档，旧 worktree 不在；发布后五份未提交文档、冻结产物及原始发布回执尚未取得。当前发布记录依据可见交付摘要、精确源码和保留的脱敏读回重建，不冒充原件，也不补造产物哈希。原本机分析稿与真实验收执行记录保留，仓库只归档脱敏摘要。

本次仅整理文档，不改变账号同步合同或追加真实账号操作。模拟记录、历史、两端草稿与专用 profile 保留；真实旧记录导入未执行。后续发布或恢复须重新核对届时的版本、资源与授权，不能沿用历史授权执行新操作，也不能以删除数据解决旧前端兼容问题。

<a id="独立备份切片2026-10-04隔离-worktree未提交未部署"></a>

## 独立备份切片（2026-10-04，隔离 worktree；已发布）

该切片已随 PR #13/#14 发布（2026-10-04）并完成首份真实备份读回；发布与读回证据见[发布记录](./releases/2026-10-04-independent-backup.md)。以下为本地实现阶段的历史记录，保留原文。

独立备份按[独立备份合同](./specs/backup.md)实现：复用账号 DO 增量建表，同步事务内一并持久化 revision、待备责任与必要 alarm（SQL 与 alarm 联合提交/回滚）；唯一冻结任务 + 单 alarm 生命周期，固定 30 秒窗口与 1/5/15/60 分钟后每小时的退避；R2 条件创建包与完成标记、全量读回验证（含全新 Loro 导入与业务校验）、最近 30 份精确裁剪（先删标记后删包、每步持久进展、重试前重新核对保留集合）；`GET /api/backups/refueling/status` 只读状态接口；格式/归属/校验冲突进入 blocked 且不阻塞同步。绑定 `HAKO_BACKUPS`（候选桶 `hako-backups-production`，`dev.remote: false`）仅为代码配置，真实桶未创建。

环境：Node 24.18.0、pnpm 11.25.0、锁文件依赖（cf 1.0.0-beta.10 / miniflare 5.20260930.0-alpha / workerd 1.20260930.2、rolldown 1.2.9、Loro 1.16.3）。验证分层（下文各复审轮记录的全量计数与构建结果均属于其所述修订时的候选，不作为后续修订的验收证据；当前最终候选的全量计数见本节末尾）：

| 层 | 内容与结果 |
| --- | --- |
| 单元（真实 SQLite + 合成 R2 + 受控时钟，`tests/backup-format.test.ts`、`tests/backup-engine.test.ts`、`tests/worker-backup-routes.test.ts`） | 61 项全部通过（引擎 50 + 格式 + 路由）：格式严格解析与版本向量摘要、窗口/合并/顺延、启用基线（含启用前文档冻结）、幂等与冻结不变性、精确退避与不重置、130 变化故障期仍同步、31 份裁剪各阶段中断与长期删除失败（含计划恢复时保留标记被外部删除即停止删除）、序列防回退/DO 回退/分页、blocked 全类别（含捕获期主文档缺失的 invalid_source_document 与同步/其他账号边界）、上传前完成标记镜像核对、未知账号前缀拒绝（映射/状态全部丢失与仅映射丢失的孤儿游标）、覆盖补登记（部署回退窗口与冻结任务在途期间旧代码写入：同步当场与确认事务内双入口、冻结历史为基准、含启用基线路径与登记失败整体回滚的原子性）、重试/清理责任持久化失败的有界重排（任务与清理两条路径，恢复后继续退避/收尾；下限持久跨引擎重建与对象重建，共享 alarm 不提前退避中的账号——任务、清理与待捕获三路径，待捕获路径含主文档恢复后仍等到下限时间才捕获不提前发布）、未准备基线由确认事务内登记兜底（登记遇 SQL 错误整体回滚、恢复后确认与登记原子完成）、到期重试不被普通编辑顺延（任务与清理两条路径）、事务原子性注入（主分块/冻结分块/游标/setAlarm/确认，重启重开 SQLite 一致）、状态各态与覆盖缺口、A/B 账号隔离、路由鉴权与零副作用、触发裁剪一份的精确调用混合（PUT 2 + LIST 4 + GET 62 + DELETE 2） |
| workerd 集成（真实进程 + 隔离持久化 + R2 模拟桶，`tests/integration/backup-workerd.test.ts`；测试入口仅在该目录，生产 DO 类无测试钩子） | 12 项全部通过：生产节奏 30 秒窗口由真实 alarm 触发完整备份；窗口合并与实际调用数（每份 PUT 2 + LIST 2 + GET 2；PUT/LIST 计 A 类、GET 计 B 类，即每份 4 A / 2 B，未触发裁剪无保留对象 GET、DELETE 为 0）；put 故障真实退避与写后丢失响应同 key 核验；上传后读回前 SIGKILL workerd 重启恢复；完成确认后/保留检查 LIST 前 SIGKILL 重启先收尾、期间不发布第 32 份、最终保留集合恰为 revision 3..32；SQLite 触发器注入的启用/确认整体回滚；A/B 账号前缀隔离；**上传前镜像守卫**（旧完成标记外部缺失时新备份先阻断、零新 PUT、冻结任务保留）；裁剪触发生命周期（retentionCount=2 加速）与同步/备份/裁剪三段实际 SQL 计量；**失败退避下限跨真实 workerd 重启**（SIGKILL 后同 persistDir 重启，普通编辑不提前持久下限，恢复后完成）；**共享 alarm 跨真实 workerd 重启**（双账号：B 的较早窗口触发唯一共享 alarm 不绕过 A 的持久下限——A 执行入口被门禁、尝试计数与下限不变、alarm 精确回到下限值，B 正常完成，恢复后 A 完成且无残留调度；第二合成身份经 syncDirect 直连 DO，路由层固定 owner 认证边界由生产路由与既有回归覆盖）；**核心门禁**——移除 DO SQLite 后仅凭本地 R2 完成标记枚举、读取、验证并导入全新 Loro，逐字段核对当前记录、checkout 历史点核对旧值（覆盖空文档、并发历史、约 3.3 MiB 完整历史） |

R2 计费分类（2026-10-04 复审更正，按[官方定价](https://developers.cloudflare.com/r2/pricing/#class-a-operations) PUT/LIST 均为 A 类、GET 为 B 类、DELETE 免费）：未触发裁剪一份 4 A / 2 B；触发裁剪一份 6 A / 62 B（PUT 2 + LIST 4；GET 62 = 2 次读回 + 30 份保留对象各 1 次标记与包核查）+ DELETE 2 免费。首轮交接的“每份 2 A / 4 B”把 LIST 误计入 B 类，已更正；原分析稿 4 A / 64 B 为实施前预算，实测差异以本记录为准。DO SQL 实际计量已按父会话复审要求补采（2026-10-04）：以测试入口的 sql 包装层捕获 workerd cursor 的 rowsRead/rowsWritten（生产 DO 类无计量钩子；包装失败会以 active=false 显式失败）。父会话复审指出初版计量器两处口径错误（rowsRead 随游标消费逐步累计、exec 返回时取数漏计行读；同步取样区间混入调试查询），已修正计量器（游标完整消费后取数、每语句只计一次、微任务兜底未消费语句；alarm 差值前先冲刷微任务；同步取样区间只含同步请求；只读观测轮询被计量抑制排除，显式测试 SQL 单列到独立调试计数器——alarm 等待期穿插的观测轮询与调试 SQL 均不进入业务差值，同一业务不随调试/轮询频率变化，含确定性校准：穿插后业务计量精确不变、固定 3 次各 2 行调试读取使调试计数器精确 +6 行读/+3 调用且业务累计不变；累计异常以 incomplete 显式标记并在测试断言为 false（业务与调试计数器分别检查）；30 行无排序全表扫描校准在调试计数器上精确等于 30——同一包装层机制，exec 时快照只会读到 1）并重测：**一次同步约 6 行读 / 4 行写**（RPC 鉴证 + 合并 + 待备责任 + 续期判定）、**首份基线的备份生命周期（alarm：启用→捕获→发布→确认→保留收尾→重排，生产节奏单备份用例实测）约 48 行读 / 18 行写（67 次 sql.exec 调用）**、**已有备份序列中的后续备份（窗口合并场景用例实测）约 51 行读 / 18 行写（68 次 sql.exec 调用，两者均为各自场景稳定采样、行读差异来自场景差异）**、**触发裁剪的生命周期（retentionCount=2 加速实测；非生产 30 份配置的计量，30 份场景未实测，不做总额线性放大——相对普通备份的增量 26 行读 / 5 行写 / 17 次调用中只有逐份保留对象核查随保留数近似增长，其余为固定开销）约 74 行读 / 23 行写 / 84 次 sql.exec 调用**、**重试路径**（put 故障重试用例内按 alarm 差值实测）失败尝试生命周期约 **27 行读 / 7 行写 / 34 次 sql.exec 调用**、成功重试生命周期约 **40 行读 / 13 行写 / 52 次 sql.exec 调用**（「语句」口径为包装层捕获的 sql.exec 调用次数）；先前记录的 13/4、46/16、60/21 已撤回；49/18/69、75/23/86、41/13/54 为覆盖登记并入确认事务之前的采样，事务合并后按连续多次全量运行稳定的重测值（48/18/67、74/23/84、40/13/52，取自生产节奏单备份/裁剪/成功重试三个集成用例的 alarm 区间；初次替换曾误用窗口合并用例的读数，分析会话按其独立采样对齐后更正）替换（父会话复审指出文档未随事务合并更新）；计量覆盖 sql.exec 且只在测试层统计（按 alarm 生命周期差值取数，调试轮询不计入；生产 DO 类无计量代码），不含 workerd 事务自身开销，单元适配器（node:sqlite）无计量能力；上述为本地 workerd 观测读数（与生产账单同一计量 API 的本地值），不是生产账单实测。表行数观察（完成缓存常态 30 行）只是存储规模证据，不等价于计量。

2026-10-04 分析会话复审（[审阅稿](./analysis/2026-10-04-independent-backup-implementation-review.md)，3 个缺陷 + 1 个计量分类问题）已在本工作区修复并通过针对性验证：裁剪计划恢复时补全应保留集合与完成缓存镜像核对（仅当前精确计划可解释的待删标记缺失可继续，其余停止删除并 blocked）；严格过期的重试/清理责任不再作为 alarm 时间重设，持久化失败走有界失败下限（任务与清理两路，收尾调度不覆盖）；待备责任的主文档缺失进入 `invalid_source_document` blocked（不造空基线、同步与其他账号不受影响）。审阅探针由 3 failed / 1 passed 转为 4 passed（1.21s，复现目录只读引用本工作区源码）。

2026-10-04 父会话对同一冻结快照的独立审阅（复现记录见其回执 `/tmp/hako-backup-parent-review-l67cr4g7/parent-review-result.json`，未修改本工作区）在分析会话三项之外追加 3 个 P2，已在本工作区修复：**新序列启用检查改为枚举同环境全部账号前缀**——本 DO 不认识的账号前缀（映射/状态丢失后重建的新 accountId）进入 `ownership_conflict`，不再把已有桶当空桶静默另起新序列、遗弃旧账号备份（同一 DO 内已知账号的多身份共存不受影响）；**已建立序列在任何新 PUT 之前核对完成标记镜像**——旧完成标记外部缺失时先阻断，不写入新包新标记（仅本任务自己的 revision 允许缺失以保留重试幂等）；**空闲同步按历史摘要补登记覆盖**——部署回退窗口由旧版本代码直接推进的主库历史在下一个合格同步事务中登记为新的服务端 revision 并开启待备窗口，不再长期停留在 coverage_mismatch 观察态（覆盖后空闲同步零新增 R2）。另按其 advisory 移除 backup-store 无调用的 `readMainSnapshot`。上述修复补 3 项引擎回归（外部删标记后上传前阻断、共享桶新账号 ownership_conflict、回退窗口覆盖补登记并完成备份）；受上传前镜像核对影响，「外部删除保留标记」既有用例的预期更新为阻断先于第 31 份上传。全量 `pnpm run test` 通过，typecheck/build/production dry-run 复跑通过；分析会话 4 探针复跑保持 4 passed。

2026-10-04 分析会话对修复版复审又发现一处调度回归（其新增 2 个跟进探针复现，任务与清理两条路径）：修复版把「重试时间已过」一律解释为失败残留并重开一档退避，导致到期后晚到 1 秒的普通同步也会把重试推后 5 分钟、持续编辑可无限顺延。已修正：到期重试/清理责任＝正当其时，alarm 设为当前时间并立即由处理器消费；立即循环防护完全交给有界失败下限（仅持久化新责任失败的善后才强制不早于下一档退避）。补 2 项引擎回归（到期后普通编辑不重开退避，任务与清理两路径，随后按既有语义完成/收尾）。分析会话全部 6 个探针（原 4 + 跟进 2）复跑通过。父会话限定复审（对第 2 轮冻结候选）确认 R1–R3 定向复验转绿、同时要求补 SQL 实际采集且不可用表行数代替：已按上述方式补采（测试入口 sql 包装层 + alarm 生命周期计量 + `/test/sql-meter` 路由 + 第 9 项集成测试），生产 DO 类仍无任何测试钩子。含计量的最终全量 `pnpm run test` 通过（typecheck/build/production dry-run 复跑通过）。父审最后一项同类路径补充（上传前镜像守卫，原快照红测 newPuts=2）已按其要求补 workerd 层证据：新增第 10 项集成测试断言旧完成标记外部缺失时新备份在任何新 PUT 之前进入 sequence_conflict blocked（PUT 计数不变、新包新标记零写入、冻结任务保留、alarm 归零）；单元级同场景回归（含 newPuts=0 断言）已在引擎套件中。父审确认的 1000 窗口/1001 次 PUT 失败长循环补验不受修复影响，未重复运行。

2026-10-04 父会话对其间冻结候选（引擎 67b8cf27，13 项定向检查全过）的进一步限定复审将其中两项确认为正式 P2 并要求补证，均为上述修复的同一问题、本轮补齐验证：①仅身份映射丢失（孤立 cursor 仍被 account_data_ids UNION backup_cursor 当合法账号）——修复同上（仅身份映射判定），另收其 parent-retry-recreation 同型对象重建场景为双路引擎回归（仅重建引擎/同步对象、同库同桶同持久 alarm，普通编辑不绕过持久下限，任务与清理两路，且断言 retry_floor_at 已持久）；②失败退避下限只在内存、引擎重建后普通编辑提前——修复同上（retry_floor_at 持久双轨），并新增**真实 workerd 重启验证**（第 11 项集成测试：触发器随 DO SQLite 持久 → 失败下限持久化 → SIGKILL workerd 后同 persistDir 重启 → 普通编辑后 alarm 保持下限值 → 移除触发器后下限时间触发、正常完成两次尝试并捕获重启后编辑）。引擎头注释中「重启后由推导规则给出同样下限」的过时表述已随持久化实现对齐。此前 3 个 P2 遗漏的修复记录（引擎 38→41 项）：①**仅身份映射丢失**（旧备份游标仍在）时旧游标仍会放行新账号序列——已知账号判定改为仅以身份映射（account_data_ids）为准，无映射的孤儿账号前缀对新序列不可解释，进入 ownership_conflict；②**有界失败下限只在内存**，引擎重建后一次普通编辑会把原定 5 分钟后的失败重试提前到立即执行——下限持久化到 backup_cursor.retry_floor_at（与失败的任务写入异表，进度写入即解除，内存下限兜底写入失败），跨重启普通同步不提前失败退避中的重试；③**冻结任务在途期间旧版本写入**的主库历史在确认后无待备责任、须等前台同步——覆盖核对增加确认后入口（对当前主文档比对最新完成摘要），完成时刻即登记待备并安排窗口。三项各补回归（孤儿游标拒绝、重启后同步不提前下限、冻结期间旧版写入确认后自动补登记并完成覆盖）；分析会话 6/6 探针复跑保持通过。父审对 67b8cf27 复审的最后补充（第 3 项 P2 窄分支）：冻结任务在途且无 pending 时，旧版写入后的合格同步因任务守卫跳过覆盖核对，责任只能等确认后入口——已修复：覆盖基准改为任务感知（冻结任务在途取其冻结历史摘要，否则取最新完成摘要；未准备任务由确认后入口兜底），成功同步当场登记新的 revision/pending 且不触碰冻结字节与重试退避，含启用基线（尚无完成版本）路径；补 2 项引擎回归（冻结 rev2 在途旧版写入当场登记并最终三段全覆盖、启用基线冻结在途同路径），父审探针的 frozen 场景由此转绿。本轮（三项 67b8cf27 复审项收束）后全量复跑通过。父会话对 399bf3bd 的复核通过 19 项定向检查后又发现两个 P2 边界，已修复（引擎 44→47 项）：①**共享 alarm 为其他账号触发时会提前执行仍在退避中的账号**——onAlarm 的任务/清理推进分支现与调度器一致受有界失败下限约束（持久+内存取大；下限到期前的提前触发不推进也不重排，不再每轮把下限顺延）；②**冻结版确认后、补登记前中断的崩溃窗口**——覆盖核对移入确认事务内原子执行（以刚完成任务的冻结历史为基准；登记写入失败则整个确认回滚重做，只吞摘要分析失败）。补 3 项引擎回归（共享 alarm 任务/清理两路径不提前且下限不变、确认与覆盖登记原子——列作用域触发器使登记失败时确认整体回滚、恢复后一并完成）。分析会话 8/8 探针复跑保持通过；两条既有 R2 持久化失败测试的断言按新语义更新（下限保持不变而非每轮重排）。该轮（399bf3bd 两项 P2 收束）后全量 `pnpm run test` 296 项通过（227 既有 + 58 备份单元[格式 + 引擎 47 + 路由] + 11 workerd 集成），typecheck/build/production dry-run 复跑通过。

399bf3bd 轮之后的收尾轮（按轮归因）。引擎 8865722f（相对 fbed8990 仅两处分析失败日志事件）：①确认事务内与同步入口的摘要分析失败 catch 增加显式 `backup_uncovered_analysis_failed` 事件（不无声结束覆盖责任，后备为同步入口与只读状态）；②未准备基线补专项回归（同步按设计跳过 → 确认内登记遇 SQL 错误整体回滚 → 恢复后确认与登记原子完成并捕获新历史，引擎 48 项）；③新增 workerd 第 12 项「共享 alarm 跨真实 workerd 重启」（双账号，B 的较早窗口不绕过 A 的持久下限，SIGKILL+同 persistDir 重启后 A 执行入口门禁、alarm 精确回到下限）；④三处采样完整性门禁补 incomplete 断言。引擎 ed77eaa7（相对 8865722f 一处逻辑变更）：⑤父会话沿同一调度入口发现的**待捕获阶段漏查退避下限**（P2）修复——onAlarm 的待捕获分支与任务/清理分支一致受每账号有效下限门禁（其他账号的较早 alarm 不提前捕获、持续故障不改写仍有效的下限、主文档恢复后仍等到下限时间才发布），其两条探针（parent-capture-floor / parent-capture-recovery-floor）修复后逐字复跑 2 passed，补 2 项引擎回归（引擎 50 项）；该候选经父会话功能复审通过、全部功能缺陷关闭。测试层（引擎无变更）：⑥计量来源隔离（worker-entry 与 harness——调试 SQL 单列独立调试计数器、执行时路由、alarm 等待期穿插与确定性校准，业务/调试 incomplete 分别检查）；⑦全部生命周期样本精确断言并补齐 active 门禁（同步 6/4、首份基线 48/18/67、后续备份 51/18/68、裁剪 74/23/84、失败尝试 27/7/34、成功重试 40/13/52）；⑧文档数值、场景澄清与 revision 递增口径对齐。当前最终候选：engine ed77eaa7…、引擎测试 e4b495bd…（50 项）、worker-entry ba6faed8…、harness 65d67df7…、backup-workerd f17f72df…（12 项）；全量 `pnpm run test` **300 项通过**（227 既有 + 61 备份单元[格式 + 引擎 50 + 路由] + 12 workerd 集成），typecheck/build/production dry-run 通过。

既有 227 项回归全部通过；本切片不改动登录、会话与同步 v1 请求/响应格式。真实 R2 桶创建、部署、恢复 UI 与 `documentGeneration` 协议不在本切片；两条“独立备份尚未接入”静态提示（[App.vue](../src/App.vue) 与 [RefuelingWorkspace.vue](../src/components/refueling/RefuelingWorkspace.vue)）按交接约定保留原样，由父会话在发布时对齐。SQL+alarm 联合回滚的 API 语义另由分析会话的独立 workerd 探针证实（见[分析稿第 10 节](./analysis/2026-10-03-independent-backup.md#10-二次审查结论2026-10-04)）。

<a id="恢复代次兼容基础a2026-10-05隔离-worktree未部署"></a>

## 恢复代次兼容基础（A，2026-10-05，隔离 worktree；已合并、已部署）

状态更新（2026-10-05）：A 已由 PR #18 squash 合并至 `main`（合并 commit `0dce2b42c0e44b7f9441471dd36a10b3128f4113`，tree `2e0a9da85ea968879b381e2e5c28cd0ca56a78dc`），并已部署到 production（version `c13b7b31-06a5-4a81-9c5c-7b45c7ead561`，2026-10-05 10:28:41Z，流量 100%）：两端原有记录保留与同步持久确认经用户验收，更新提示消失；原本无草稿，草稿保留分支未验；既有 v1 真实备份独立读回通过。A 已被接受并登记为 B 的回退候选；发布与验收事实统一见[恢复发布记录](./releases/2026-10-05-restore.md)。以下实施摘要与验证证据保持合并前记录不变。

交付 A 按[加油文档恢复设计](./specs/restore.md)的 §4/§5/§6/§7.3-7.6/§8/§12.1 实施，范围为「A：代次兼容基础」：没有恢复切换能力，日常记录/同步/备份可用，并提前交付回执表、请求指纹、三个结果分类的解释规则、结果查询、仅查重的恢复 POST 与本机待确认/终态处理。协议与格式合同的权威定义已并入[账号同步合同](./specs/account-sync.md)与[备份合同](./specs/backup.md)，本节只维护实施范围、验证证据与未验边界，不重复技术合同。

实现摘要（全部在本 worktree，未合并）：

- 服务端：`refueling_document_heads` 表与 `refueling_snapshots.document_generation` 分块标签；受控且幂等的 G0 初始化（bootstrap/同步合并点/备份捕获共用同一事务级规则，head 缺失但已有现代代次痕迹时 `generation_state_unavailable`，不随机补建）；bootstrap/GET 只读快照/POST 协议 2 路由与 DO RPC（拒绝协议 1 与缺代次 426、合法旧代次 409 附代次元数据、账号不匹配 409 分开）；`refueling_restore_receipts` 回执表、固定字段请求指纹、A 只查重的 `POST /api/restores/refueling`（同指纹回执回放 committed、冲突 409、无回执 503+unknown 零写入）与只读 `GET /api/restores/refueling/requests/{requestId}`（404 不证明未提交）。备份格式 v2（`HAKOBK2\n`、document-generation 来源、generationOrigin、restore-baseline reason）、冻结任务捕获时固定代次/格式/来源、升级前旧任务按 v1 原字节完成、覆盖判断比较有效源代次、完成缓存保存代次信息、状态接口增加当前/最近完成代次字段、新增 blocked 码 `generation_state_unavailable`。
- 本机：`hako-account-v2:<accountId>:refueling`（documents 按代次 + control），草稿库/锁/广播按账号+代次隔离；v1→G0 迁移（首次复制确认信息、再迁移合并新历史并保留 G0 确认向量/重算待传/合并不覆盖新增映射、指纹只在成功时推进、失败保留两份原数据）；代次变化保护流程（冻结保存、flush 草稿、提示本人选择、GET+原子接收切换、保留副本不上传）；保留副本只读查看与逐项字段带回普通表单；待确认恢复/终态结构（多标签页复用、终态按 requestId+指纹复核落盘、unknown/404/迟到响应不清除）；bootstrap→同步→409 代次变化→保护流程的完整客户端接线。
- 审阅修复第一轮（R1-R8，编号沿用父审报告原含义）：旧窗口的保存/导入/同步准备/迁移绑定实例原代次，control 失活时写入该代次保留副本，不清零、不冒充当前代次（R1）；`receiveGeneration` 增加控制事务内 CAS 复核——目标已是活动代次幂等读回、前置被推进拒绝迟到切换、目标副本已保留拒绝覆盖（R2）；离线打开优先读本机 control，持久 v2 工作区以 `serverConfirmed: false` 激活，bootstrap 尽力而为并在回网/前台/在线重试（R3）；保护流程的保留列表包含被保护旧副本，接收后保留入口由工作区链接提供（R4）；新增保留副本与旧草稿只读查看（只读草稿列表：不建库、不抢锁、不清理；含旧 v1 草稿库与只有草稿的代次）（R5）；同来源多目标冲突持久记录并阻止重复自动导入，映射按目标仍存在继承（R6）；服务端 bootstrap 的 G0 绑定包在存储事务内，触发器失败整体回滚并映射 `generation_state_unavailable`，不留下半完成 head（R7）；分块标签可解释性收紧为共享规则——全 NULL 只在可证明的 legacy 边界（期望代次等于 head 的 `legacyGeneration`）内接受，捕获/同步/GET/覆盖判断共用，恢复代次或未知代次下的 NULL 一律拒绝且不重新贴标签；损坏的 v2 冻结任务按 `format_conflict` blocked 不降级 v1 发布（R8）。
- 审阅修复第二轮（父审 round 2，仍未提交/未部署）：区分持久共享 activeGeneration、实例挂载工作区固定代次与已确认服务端目标三层——迟到的 bootstrap/回网重确认/CAS 失败重判在共享控制已推进时不再自动切换已挂载旧工作区，一律进入保护流程等待旧草稿 flush 与本人接收；重开/重试不先把旧实例拆成 pending（R1/R2 剩余）；`activateGeneration` 增加同事务 CAS 前置复核，决策与激活之间被推进时拒绝把共享控制改回旧代次并重新决策（R1/R2 剩余）；保留记录/草稿带回后表单重新 `attachForm` 绑定当前代次、目标记录与当前基线，新输入不再落回带回前的旧 recordId/base 草稿（R9）；待确认恢复回执的查询不再限于保护流程——active 同代次同样查询并先落盘终态，迟到响应以最新控制为准不清除更新的待确认，active 状态提供手动重查入口（R10）；导入冲突的阻断判定绑定操作代次仍存在的目标（无目标允许重新选取、唯一沿用、多目标阻断），历史证据保留；只读状态按当前代次过滤显示（R6 剩余）；保留草稿核对补全布尔原始输入（是否加满/油灯），保护流程可展开记录完整字段详情（只读、无勾选/带回）（R5 剩余）；异步 bootstrap 的 DO wrapper 先等事务完成再 `storage.sync`（与 syncRefueling 顺序一致）。
- 审阅修复第三轮（父审 round 3）：重开本机库失败（IndexedDB open/读取抛错）不再把已挂载工作区 key 改为 pending——统一异常路径按已挂载状态分流：有旧实例时保持原视图/记录/流程并显示可重试错误，repository 采用「先开新连接、成功后换绑并回收旧连接」的顺序，失败时旧连接保持可用（保存继续工作），无旧实例的首次失败仍用 failed 占位（R1/R2 剩余）；重开先脱离旧同步客户端（停用 + 置空引用，在途交换中止且不可被中途 setFlow 复活），新客户端只绑定当前有效 repository（R11）；导入冲突按本次操作代次中仍存在的目标数三态决策——零目标重新选取、唯一目标沿用映射幂等（映射缺失时补记映射、不创建第三个目标）、多目标拒绝自动导入，历史证据保留，当前 UI 同一规则过滤（R6 剩余）。
- 审阅修复第四轮（父审 round 4，异步出口收尾）：同步客户端装配保证唯一（已有运行实例不重复创建/覆盖，成功/失败出口都不会留下第二个 enabled 客户端），可选的持久性状态查询失败只表示未知（null），不进入重开异常出口、不触发工作区/同步重装（R11）；409 正文读取这一 await 出口补后置资格复核——停用/换代期间迟到的完整正文不再触发代次保护、中止正文不再触发会话拒绝，当前有效 409 行为不变，同客户端其余 await 出口逐一核对（prepareSync/响应头/200 正文/acceptSync 均已有 applies 复核）（R11）；committed 回执的本机终态落盘失败不再漏接为未处理拒绝——保留原请求/正文、不虚报 committed/not_committed、新增 receipt=failed 状态与「再次查询恢复结果」重试入口，迟到错误不污染更新请求或已卸载实例（R10）。
- 审阅修复第五轮（父审 round 5，回执状态/错误归属定点收尾）：回执查询的状态与错误归属具体 requestId + 指纹——成功、unknown、catch 全部出口先核对当前待确认是否仍归属本次查询的请求（「被另一请求取代」须仍存在新待确认，pending 清空不算取代）；本请求确认成功只清除回执查询拥有的错误文本（error 位上的无关错误原样保留）；迟到的 committed/unknown/failed 不显示给已取代它的新 pending——回位 idle 并对当前新请求自动发起跟进查询（任何持久 pending 都可独立查询/确认）；迟到的终态落盘失败同样不更新新请求界面（R10）。

验证环境：Node v24.18.0、pnpm 11.25.0、锁文件依赖不变（Loro 1.16.3、workerd 1.20260930.2、Miniflare 5.20260930.0-alpha）。全量 `pnpm run test` **395 项通过**（24 个 node 环境文件 373 项 + 组件接线 2 个文件 8 项；`pnpm run test` 串联主配置与 `vitest.components.config.ts`，后者以客户端编译真实 SFC）。v1 基线 300 项按新协议合同更新为 v2 语义后扩展：worker-sync 重写为协议 2 并新增 bootstrap/GET/426/409/503 用例；新增 `worker-restore.test.ts` 7 项、`local-account-storage` v2 迁移/切换/待确认结构共 22 项、备份引擎代次固定/覆盖代次判断/恢复基线消费 3 项、备份格式 v1/v2 双格式用例、`refueling-sync` 重写为协议 2 8 项、草稿接线代次化 3 项、新增 `refueling-restore.test.ts` 6 项与 `refueling-server-api.test.ts` 3 项（客户端响应绑定：账号头、指纹、404/unknown、网络错误）、新增 `tests/integration/restore-workerd.test.ts` 6 项。审阅修复第一轮新增回归：`local-account-storage` 代次绑定写入/接收 CAS/保留副本枚举/只读草稿列表/迁移合并（R1/R2/R4/R5/R6）、新增 `tests/use-local-refueling.test.ts` 离线打开-回网确认/漂移保护/下载期 CAS 重判/保留副本恢复编排（R3）、`worker-sync` 正文读取中途撤销会话与流取消零写入、恢复代次全 NULL 不可解释（R8）、`backup-engine` 捕获前标签不一致/恢复代次全 NULL/v2 来源损坏三类 blocked（R8）、`restore-workerd` bootstrap 触发器回滚幂等重试（R7）。审阅修复第二轮新增回归：`use-local-refueling` 迟到 bootstrap 保护已挂载旧工作区/共享控制提前推进的刷新保护与本人接收/重试失败不先卸载旧工作区/active 状态待确认回执查询与迟到响应不清除更新 pending/导入冲突按当前代次过滤（R1/R2/R10/R6）、新增 `tests/use-local-refueling-activation.test.ts` 迁移激活竞争 CAS（R1/R2）、`local-account-storage` 激活 CAS 与冲突按操作代次判定（R1/R2/R6）、`refueling-draft-session` 带回上下文落盘与重开恢复（R9）、新增 `tests/components/refueling-workspace.test.ts` 真实 SFC 带回绑定/flush 失败不切换/带回后普通保存（R9）与 `tests/components/retained-copy.test.ts` 完整字段详情与保护态只读展开（R5）；组件测试为客户端编译 SFC + 自定义 renderer 的接线验证，不冒充真实浏览器。审阅修复第三轮新增回归：`use-local-refueling` 重开失败保持已挂载工作区/失败后旧连接可保存/同步客户端替换生命周期两例/唯一存活导入目标三态（R1/R2/R11/R6）、`local-account-storage` 唯一仍存在目标沿用映射幂等（含映射缺失补记）。审阅修复第四轮新增回归：`refueling-sync` 409 正文在途停用（完成/中止均不触发回调、当前有效 409 照常保护）、`use-local-refueling` 持久性查询失败不泄漏第二客户端且卸载后全停用、committed 终态落盘失败保留原请求并可重试成功（R10/R11）。审阅修复第五轮新增回归：落盘失败重试成功清除本请求旧错误且无关重开错误保留、P1 终态写入在途被 P2 取代后迟到的配额失败不更新 P2 界面、迟到的 committed 回执不标给新 pending（回位 idle 并跟进查询新请求）（R10）。`pnpm run typecheck`（cf workers types + vue-tsc + worker/node 两段 tsc）与 `pnpm run build` 通过。备份 SQL 计量按协议 2 实现与捕获/确认事务内分块来源核对重测并更新（同步 8/4；基线生命周期 53/18/72、后续备份 56/18/73、裁剪 79/23/89、失败重试 29/7/36、成功重试 43/13/55——每轮各含一次捕获前与一次确认事务内的标签核对读数；口径与校准机制不变，见[备份合同 §10](./specs/backup.md#10-日志与计量)）。

workerd 集成（真实进程 + 隔离持久化 + R2 模拟桶，`tests/integration/restore-workerd.test.ts` 6 项）覆盖：协议 2 幂等 bootstrap/GET 204 与 200/426/400/409 附元数据/head 缺失 503；预升级冻结任务按 v1 原格式完成与升级后新捕获 v2 的混合序列；合成 B 切换状态（新代次 + 回执 + 冻结恢复基线任务）下 A 消费 restore-baseline 并在新代次后续备份沿用 restore 来源、旧代次上传 409、GET 只读返回新代次；恢复回 committed 回放/指纹冲突/无回执 503+unknown 零 R2 副作用/GET 404；head 与回执跨真实 workerd SIGKILL 重启持久且 bootstrap 返回同一 G0。既有 `backup-workerd` 12 项全部按协议 2 与新计量门禁保持通过（含真实 SIGKILL 重启、共享 alarm、触发器回滚与计量门禁）。

未验边界：未部署（production 仍运行 v1 协议/格式 Worker；A 上线前需按发布计划核实旧客户端保留数据、既有真实备份仍可读，见恢复设计 §12.3）；真实设备/双浏览器上下文的账号/代次/草稿竞争（§12.1「本机竞争」的真机部分）未执行——本机存储行为以 fake-indexeddb 单元覆盖，真实 IndexedDB/多标签页行为沿用 PR #11 阶段的浏览器证据边界；B 的恢复列表/预览/保护校验/切换 UI 与离线 CLI 不在 A；恢复请求结果确认的端到端（B 提交后回退 A）仅在合成 B 状态下验证，未做真实 B 联调。真实云端业务数据/备份对象未写入；本节测试全部使用合成数据与隔离持久目录。

<a id="恢复操作b2026-10-05隔离-worktree未合并未部署"></a>

## 恢复操作（B，2026-10-05，本地实施与内容审阅；已合并、已部署）

状态更新（2026-10-05）：B 已由 PR #19 合并至 `main`（squash `34c5fa8b5540858c8a3ea045bd554318e8a8ff03`），浏览器修复随后由 PR #20 合并（squash `4b93432f8f8e4665e3e66bc58ed064d58249dcfd`，tree `7b919073645d1a49d36399c66c5b9f63713c0d1f`），两者共同部署为当前 production（version `8d66124c-3fa1-4f20-bb85-ad42ecd9e304`，2026-10-05 14:41:49Z，读回流量 100%）。两端「备份与恢复」入口、备份列表与无变化选择结果经用户验收；生产真实恢复、有差异预览与保护门禁未执行，见[恢复发布记录](./releases/2026-10-05-restore.md)。以下实施摘要与各轮审阅记录保持原状。

交付 B 按[加油文档恢复设计](./specs/restore.md)的 §7–§10 与 §12.2 实施，范围为「B：恢复操作」：当前账号备份列表、固定预览与取消、保护门禁与唯一切换、§7.3 结果裁决与回退 A 后的结果确认、恢复基线的固定与消费、本人可用的「备份与恢复」面板，以及不联网 `backup:verify` CLI。复用 A 已验的代次/回执/本机 pending 边界，不更换存储或请求结构；协议与格式合同的权威定义仍在[账号同步合同](./specs/account-sync.md)与[备份合同](./specs/backup.md)（B 未新增协议/格式增量），本节只维护实施范围、验证证据与未验边界。

实现摘要（全部在本 worktree，未合并）：

- 服务端：`GET /api/backups/refueling` 备份列表——只在有效身份/代次/stream 映射下读取，每页 32、最多 32 页、正常最多 31 个完成标记与全 stream 最近 30 份，完整核对 R2 标记与完成缓存，不完整/未知 stream/未知序号/缓存不一致不形成可确认列表，清理中版本不可新选，不加载完整包、不初始化、不续期、不写删 R2；`POST/GET/DELETE /api/restores/refueling/previews*` 固定预览——严格三字段精确引用、拒绝任意对象键/URL/上传包、R2 读回 + 同一严格 v1/v2 验证器 + 全新 Loro 导入 + 完整历史与计数、服务端 previewId 单账号一份 15 分钟不续期、512 KiB 分块与 4 MiB 上限、事务外 I/O 与哈希、事务内重验鉴权/版本/预览替换条件、迟到请求不覆盖新预览、`storage.sync()` 成功后才返回、取消只删除匹配 ID；恢复提交——入口查回执 → 事务外完整重验目标与当前主快照 → 保护门禁（等待正常同步、30 秒备份窗口/alarm 与清理，尊重 retry_floor_at、blocked、冻结任务与待备责任）→ 保护包完整读回与字节比对 → 唯一切换事务（同一事务重新鉴权/查重/校验全部条件与主快照原字节，创建全新 UUID 代次、替换快照、revision+1、冻结 restore-baseline、写成功回执、消费预览、安排 alarm，任一写入失败整体回滚）→ `storage.sync()` 成功后确认；失败出口短裁决在事务内重新鉴权、按 requestId 查回执并执行持久资格判定（committed 优先；过期预览在同一事务删除并判 `preview_expired`；只有固定请求持久地永久失去资格才 `not_committed`，外部故障、读取失败与哈希不符但版本未推进一律保留 `unknown`，不伪造终态），不新增失败回执表/执行租约/维护写锁；`submitRestore` 在冷启动进程同样初始化 Loro 运行时。
- 本机：[refueling-restore.ts](../src/data/refueling-restore.ts) 客户端响应绑定与 pending/终态结构（发出 POST 前事务保存随机 requestId 与不可变正文；窗口复用账号现有 pending 不覆盖；仅账号+ID+指纹终态先原子落盘才解除 pending；unknown/404/取消/关闭/更新不清除、不自动换号或自动重发；迟到结果与错误绑定具体请求）；[restore-comparison.ts](../src/data/restore-comparison.ts) 独立只读 Loro 比较（稳定记录 ID、增加/移除/字段不同/相同与逐条字段、默认显示有变化记录并按需展开；当前实现不设分页，字段相同历史不同不称完全无变化）；[BackupRestore.vue](../src/components/refueling/BackupRestore.vue) 面板（列表、比较、保护等待、最终明确确认、结果待确认/已提交/本机接收失败、重试与取消）；[RefuelingWorkspace.vue](../src/components/refueling/RefuelingWorkspace.vue) 入口按钮按 `local.restoreWritesAvailable` 门禁。
- 离线 CLI：[scripts/backup-verify.ts](../scripts/backup-verify.ts)、[scripts/run-backup-verify.mjs](../scripts/run-backup-verify.mjs)（`pnpm run backup:verify`）：输入本地 marker/bundle 与显式预期 environment/account/stream/revision，复用同一严格 v1/v2 验证器与锁定 Node24/Vite/Rolldown 运行器，拒绝 URL，仅输出版本/代次/计数/字节/hash/通过失败，成功 0、失败非 0、不输出业务字段；本轮无云端执行、无通用认领/解绑/解除 blocked 接口。

验证环境：Node v24.18.0、pnpm 11.25.0、锁文件依赖不变（Loro 1.16.3、workerd 1.20260930.2、Miniflare 5.20260930.0-alpha）。全量 `pnpm run test` 通过：主配置 26 文件 **462 项**、`vitest.components.config.ts` 4 文件 **32 项**，合计 **494 项**（相对交付基线 441/12 净增 21/20；实施方最终冻结候选实跑）。B 相关：`tests/worker-restore.test.ts` **54 项**（38 + 16：列表核对与分页/标记损坏与错误归属、预览创建与替换/过期/取消、保护门禁与切换事务、结果裁决时序与 `storage.sync()` 失败、恢复基线与跨代次保留、各写入点事务回滚注入；本轮新增固定正文六字段与预览逐字段绑定、六字段任一不符/缺字段/对象键注入全部 409 且零副作用、预览与提交共用序列解释门禁对未知 stream/未知序号/游离对象的拒绝、门禁只读无副作用、过期预览同事务删除后仍按持久条件裁决、外部故障与哈希不符保留 unknown、保护门禁未就绪四分支、时钟到期）；`tests/refueling-restore.test.ts` 11 项（预览响应的保护版本字段解析并入既有用例）、`tests/restore-comparison.test.ts` 3 项、`tests/refueling-server-api.test.ts` 5 项（3 + 2：备份状态元数据客户端 200 解析（含有效可行动时间 `nextActionAtMs`）、账号头/形状/401/503/网络错误均完整拒绝且不产生部分状态）、`tests/backup-verify-cli.test.ts` 4 项（本轮起以真实 `pnpm run backup:verify -- ...` 覆盖成功 0、revision 不符非 0 与 URL 输入拒绝，另含运行器直调与分隔符严格性）；`tests/components/backup-restore.test.ts` **21 项**（4 + 17：保护未覆盖禁用确认并显示原因/版本/下次尝试、blocked/清理中提示、只读状态轮询与迟到结果归属、持久 pending 重开与回执查询/原请求重试入口、flush 后归属复验，真实编译 SFC + 忠实最小宿主 + 受控 mock 的接线验证）、`tests/components/backup-restore-flow.test.ts` 3 项（新：跨组件接线流程）；`tests/use-local-refueling.test.ts` **31 项**（含 B 的 3 项提交编排、真实 v2 仓储跨连接保存阻止首次 POST、控制锁内请求身份匹配回归）；`tests/integration/restore-workerd.test.ts` **15 项**（A 6 + B 9）：完整恢复流程与幂等回放、提交后/提交前丢响应与本人原 ID 重试、`storage.sync()` 失败确认、切换后 SIGKILL 同 persistDir 重启、跨代次累计 31 份裁剪、**近 4 MiB 快照的完整恢复主路径**（真实 workerd，35.8 s）、冷启动提交回归与分阶段 SQL 计量。

实际 SQL 计量（workerd 真实进程 + 隔离持久化；每项独立采样区间，未混入并发同步，调试 SQL 单列不计入；第二轮内容审阅修复后重采）：列表 9 读/0 写/10 语句；预览创建 20 读/4 写/32 语句；保护门禁失败出口（保护包 R2 读取故障 → unknown，零切换写入）18 读/0 写/24 语句；确认切换（保护读回 + 唯一切换事务）30 读/15 写/43 语句；切换后恢复基线 alarm 生命周期 51 读/13 写/57 语句。相对交付前（6/0/7、16/4/24、15/0/20、27/15/39、51/13/57）：第一轮修复把「有界序列解释与归属核对」门禁（§7.1/§4.3/§10.2）加到列表、预览与提交入口，各多约 3 行读、3–4 次语句；第二轮修复让预览的保护描述改用与唯一 alarm 同源的 `nextProtectionActionAtMs`（责任优先级判定额外一次游标读取与任务/清理/裁剪三处只读查询），预览再 +1 行读、+4 次语句；其余样本不含这两类路径，读数不变。

B → A → B 真实回退门禁（项目外驱动 + git archive 精确 A 源码，2026-10-05）：A 源码 commit `0dce2b42c0e44b7f9441471dd36a10b3128f4113`、tree `2e0a9da85ea968879b381e2e5c28cd0ca56a78dc`；A bundle `worker.mjs` SHA-256 `55b576a1eb2c9d81ad180a7e8c9168f53b1e45f3c94fbc1ffdbc7035664e6c97`，B bundle（修复后）`11e1b9169cb3ce0067926f5ff10e202442428230221feb0e21c35ea5aa9e2b0b`，wasm `f5e64d13866491af5cf262e1a521b7b32079cb43ee977e0b392652090b1b1fe8`。两条路径各自在同一隔离持久目录（workerd SQLite DO + R2 模拟桶）依次真实加载 B1 → A → B2：**提交后丢响应**路径（B1 提交成功、客户端丢弃响应）——A 的 bootstrap 报 `restoreWritesAvailable=false` 且读到同一新代次，A 只读回执返回 `committed`，A 的恢复 POST 仅回放同一回执且不切换，A 消费 B 冻结的 restore-baseline（`generationOrigin.kind=restore`、requestId 与切换请求一致、`sourceGeneration` 为新代次），旧完成标记与回执保留；B2 先查回执确认 `committed`、同 ID 回放不产生第二次切换。**提交前丢响应**路径（保护读取挂起、未提交）——A 回执 404、恢复 POST 返回 503+`unknown` 且零写入（无回执、无切换、预览保留）；B2 先查仍为 404，随后按本人选择以原 ID 与固定正文重试成功，唯一一次切换并完成基线。门禁在未修复版本上复现出「冷启动进程提交恢复缺少 Loro 运行时初始化」缺陷（提交入口在新进程首次分析快照时 `lorodoc_new` 未定义 → 503+unknown）：已在 `submitRestore` 入口与其它入口一致调用 `initializeWorkerLoro()`，并新增冷启动提交回归（无修复时该回归 503 红、修复后 200 绿）。

第一轮审阅修复后按同一项目外驱动重跑（A 源码再次以 `git archive 0dce2b42` 解出并与门禁目录的 A 副本逐文件比对一致，无差异）：两场景通过（提交后丢响应读回执、提交前丢响应后 A 停止恢复写入、回到 B 先查结果并按本人选择以原 requestId 与固定正文重试）；B bundle `worker.mjs` SHA-256 `90636ba692e4e3e629049dcbced3b73f249f4919e1512f53fa4b54162873f75c`，连续两次复跑一致；A bundle 本次为 `a136746f6ab0cbce527e88a4a8f7c1333fe981b9adf8a14f590968691638843e`，与首轮 `55b576a1…` 不同（同源同工具在跨时段运行间产物哈希未保持字节一致）——因此 A 的源身份以 `git archive` 逐文件比对为准（一致），bundle 哈希只作本次运行标识，不作为跨运行源指纹。

第一轮内容审阅修复记录（2026-10-05，父侧结论 CHANGES_REQUIRED；B-R1/B-R5 为 P1，B-R2/B-R3/B-R4/B-R6 为 P2，另含 B-V1/V2 补证与 B-D1/D2 文档项）：**B-R1** 提交入口此前只绑定 previewId、固定正文其余六字段未校验 → 新增 `fixedRequestMatchesPreview` 逐字段比较（本机 refresh 前的固定正文与请求体），入口、最终切换事务内的重验与失败短裁决共用，六字段任一不符、缺字段或对象键注入均按合同拒绝且不消费预览、不产生写入；**B-R5** 未知 stream 此前只在列表被拦、预览与提交仍会提交并推进代次 → 抽出共享门禁 `explainBackupSequence`：有界枚举账号文档前缀，要求每个对象都能由完成缓存、裁剪计划或在途冻结任务解释，未知 stream/序号、游离对象与读取不完整在**预览创建**即 `backup_invalid`（提交与列表同样经过），合法裁剪后的固定暂存包继续可用，门禁本身只读；**B-R2** 保护窗口/blocked/清理未禁用确认、面板不显示原因/版本/下次尝试、轮询会拖整包 → 预览响应补充只读 `protectionRevision`，面板改为轮询 `GET /api/backups/refueling/status`（只读元数据，不含快照或包正文），未覆盖时禁用确认并显示等待原因/目标版本/下次尝试时间，blocked 与清理中显示对应原因；**B-R3** 重开只按本机 pending 重置、GET 404 被当作未提交 → 面板重开先查回执并保留持久 pending 的「原请求重试」入口（unknown/404 均不解除 pending、不换号、不自动重发），丢响应从「B→A→B 退避推演」改为项目外真实 A 进程接收丢响应请求的门禁（bucket 内 B→A→B 仍作为 Worker/DO/R2 层证据，并显式区分本机 UI/IndexedDB 未覆盖）；**B-R4** flush 后未复验 → `await flushDraft` 之后重新校验本机保存代次、pendingSync 归属与请求指纹一致才 POST，异步边界后归属不符即停止并给出明确错误；**B-R6** 文档形式 `pnpm run backup:verify -- ...` 因首位 `--` 被当未知参数退出 2 → `parseBackupVerifyArguments` 明确接受首位一个 `--`（其余位置仍严格拒绝）、`process.exit` 改为 `process.exitCode` 使 `finally` 清理不被跳过，集成测试改用真实 `pnpm` 命令覆盖成功 0、revision 不符非 0 与 URL 输入拒绝。补证：**B-V1/V2** 合成 tombstone 恢复后重建与历史核对、预览时钟到期（受控时钟，不依赖真实等待）、保护门禁未就绪四分支、近 4 MiB 快照完整恢复主路径（真实 workerd）、重开与自恢复重试的可执行接线回归；**B-D1/D2** 更正本节分页错述、失败裁决描述（含同事务过期删除与持久资格判定）、[restore.md](./specs/restore.md) 头部状态与审阅记录。产品改动冻结后，父侧四个只读探针（契约/序列/CLI/面板）逐字复跑 17/17 通过；产品回归已覆盖同类路径，临时副本随后删除（四文件 SHA-256 见项目外修复回执）。

第二轮内容审阅修复记录（2026-10-05，父侧结论 CHANGES_REQUIRED；剩余 B-R4/B-R3/B-R2 三个收尾缺口，B-R1/R5/R6 与 B-D1/D2 已闭项未重开）：**B-R4** 首次发送资格此前只在 flush 返回后读一次内存 pendingSync，`beginRestoreRequest`（指纹计算 + 本机严格事务）的异步边界之后出现的保存仍会首次 POST → 仓储新增 `dispatchPendingRestore`：在账号控制锁内复核持久保存事实（当前代次文档 `pendingSync`）、持久活动代次与待确认请求归属，并与请求派发在同一临界区完成（锁内同步派发、返回后立即释放；同机其他窗口/连接的在途保存按控制锁顺序先行），未派发且仍有未同步保存时返回 `local_sync_pending` 不发送、不清除；已派发过的请求允许本人按原编号重试（requestId 幂等），派发事实 `dispatchedAtMs` 与待确认记录一并持久；面板在 begin 之后再次复核并给出「同步完成后以原请求重试」的下一步。**B-R3** 待确认结束后面板没有下一步（重开有 pending 时不加载列表且停在保护态；重试 not_committed 只置 listing 不读列表）→ 面板统一收尾：清掉绑定刚结束请求的预览/比较/保护状态、读回列表并给出可执行入口（本人重试、只读查询、其他窗口清除同样处理；服务端已切代次时提示走既有「打开恢复后数据」接收）；结果与旧失败按请求身份归属的完整规则见第三轮记录（本轮结束时 busy 期间的 pending 转移与旧结果归属仍存在缺口，第三轮修复）。**B-R2** 预览与只读状态此前只报告原始窗口/任务/清理时间，未合入持久失败下限 → 引擎新增 `nextProtectionActionAtMs`（与唯一 alarm 相同的责任优先级 冻结任务 > 清理 > 待备窗口，并对持久/内存失败下限取大；blocked 与无责任为 null），预览保护描述与状态元数据共用；只读状态快照新增 `nextActionAtMs` 字段（客户端解析并展示，不再用 `windowDueAtMs` 推算）。回归：`worker-restore` 保护下限（窗口+下限、任务+下限、blocked 预览与状态一致）、状态客户端解析、组件首发送资格与 pending 转移、真实 v2 仓储跨连接保存阻止首次 POST（同步落盘确认后同一原请求可发送）；父侧第二轮三个探针（边界/本机保存/保护下限）在冻结代码上复跑 main 2 + 组件 3 = 5/5 通过（本机保存探针实测 `durablePending=true, uiPendingBeforePost=true, posts=0`），副本随后删除。

第三轮内容审阅修复记录（2026-10-05，父侧结论 CHANGES_REQUIRED；剩余 B-R4 请求派发归属与 B-R3 busy/迟到结果归属两个 P2，各 1+2 个反例；B-R2 已闭项未重开）：**B-R4** 锁内派发此前只检查保存资格与活动代次，却把锁内读到的当前 pending 当成本次点击的请求——用户点击 P1、等锁期间他窗结束 P1 并登记 P2 时，实际会代发 P2 → `dispatchPendingRestore` 增加本次操作绑定的身份参数（requestId + 固定指纹，首次确认取 `beginRestoreRequest` 返回的同一请求，本人重试取点击时可见的请求），在**同一控制锁内**逐一匹配；锁内已清除或替换返回 `replaced`（组合层映射为 `stale_request`），不发送、不接管、不把另一笔标成已派发，界面只读刷新到最新 pending 后由本人再次选择。**B-R3** 面板 watcher 此前遇 `confirmBusy` 直接跳过、处理器又未捕获请求身份 → 重试 POST 在途时被查询/他窗结束的 pending 收尾被丢弃（迟到 unknown 留在空保护态）；P1 被 P2 替换后 P1 的迟到终态文案仍显示在 P2 的界面 → 面板引入操作身份与统一收尾 `settleOperation`：进入调用链时固定 requestId，结果/错误只在收尾时按当前 pending 归属落位——本轮终态用自身文案；pending 已结束或迟到 unknown/失败用中立提示并补出可执行入口；已被新请求取代时只做中立刷新、不清除或标注新请求；busy 期间的转移在收尾统一协调，确认与本人重试共用同一规则（该轮尚未覆盖后续列表 await 返回与列表回调自身的共享状态写入，见第四轮记录）。回归：`use-local-refueling` 新增「锁内已替换的 pending 不得被代发」（真实 v2 仓储 + 控制锁排队，返回 `stale_request`、零 POST、内存归属刷新到新 pending）、组件新增「在途 POST 时查询结束 pending 不留在空保护态」与「旧终态文案不得标到新请求」两项。父侧第三轮两个探针（派发归属/边界与 busy 收尾）在冻结代码上复跑通过（1 Node + 2 SFC），副本随后删除。

第四轮内容审阅修复记录（2026-10-05，父侧结论 CHANGES_REQUIRED；仅剩 B-R3 异步列表刷新与非 busy 换人收尾一个 P2，两个 SFC 反例）：第三轮的收尾核对只在 settleOperation 的当下比较一次，`finishPendingFlow` 与 `refreshList` 自身没有任何刷新归属——列表 GET 暂停期间的换人不会作废旧收尾（旧列表返回仍把 P1 终态文案写到 P2 界面），且非 busy 的 P1→P2 换人不清理 P1 的提示/错误 → 面板引入**刷新归属代次**（`refreshEpoch`）：待确认换人或新操作推进即 +1，`refreshList` 在成功、失败与 finally 每次写共享状态前复核代次，`finishPendingFlow` 在开始时固定本次代次、await 列表返回后复核，旧刷新/旧收尾自此不得改动当前请求的提示、错误、列表与 loading（loading 由新归属重建）；watcher 按 requestId + 固定指纹识别换人（同一请求的只读刷新不触发），非 busy 的 P1→P2 也清旧提示/错误并保留新 pending 及其本人入口；操作收尾消费 busy 期间的同一次转移（`consumedTransition` 键），避免同一转移被协调两次；未进入派发链的早退只有在认领请求被换人或消失时才改为中立协调，本请求仍准确时的提示（如未同步修改）原样保留。回归：组件新增「P1 终态收尾的列表响应迟到：旧响应不改共享状态且不写 P1 文案」与「非 busy 的 P1→P2 替换：清掉 P1 的本机失败文案并保留 P2」（按当前真实文案断言）。父侧第四轮探针在冻结代码上复跑 2/2 通过，副本随后删除。

最终内容复审（2026-10-05）：B-R1 至 B-R6 及文档/UI 完整项均已闭项。审阅方在最终代码副本独立执行 39 项组件检查（32 项产品回归 + 7 项临时边界探针），覆盖未同步保存门控、待确认结束、请求替换与迟到列表刷新；本轮未改仓储、组合层或 Worker，复用上一冻结版本的 55 项 Node 定向结果及更早的对应服务端证据。实施方最终 494 项测试、typecheck/build 结果按该方日志归因，未称审阅方重跑全量。真实浏览器/真机与生产部署仍未执行。上方各轮条目保留当时发现与验证范围，旧文档锚点保留供既有引用使用。

兼容性与测试层修复记录：B 落地时同步更新 `tests/worker-sync.test.ts` 的 bootstrap 断言（`restoreWritesAvailable` 在 B 为 true；A 回退仍 false）与 `tests/components/refueling-workspace.test.ts` 的 local mock（B 新增 `restoreWritesAvailable`）；组件测试宿主改为忠实最小宿主（维护真实父子/兄弟链），修复朴素 no-op 宿主使 Vue 卸载 fragment 的 `removeFragment` 无法收敛而死循环的问题（测试层缺陷，不涉及产品路径）。

未验边界：未合并、未部署（production 仍为已部署的 v1 协议/格式且不含 A/B）；真实浏览器/真机两个独立上下文的恢复交互（多窗口 pending/终态竞争、配额失败、旧表单保护、真实 IndexedDB/多标签页行为）未执行——本机无项目浏览器自动化工具（依赖与 PATH 均无 Playwright/Puppeteer），组件测试为真实编译 SFC + 忠实最小宿主 + 受控 mock 的接线验证，不能替代真实浏览器；真实远端 R2/生产备份对象与真实管理员 marker/bundle 未用于 `backup:verify`（仅合成 v1/v2 材料）；恢复面板未在真实浏览器中人工点击验收，设备接收（打开恢复后数据）只在单元/组件层验证。

<a id="恢复预览浏览器缺陷修复2026-10-05无绕过复验"></a>

## 恢复预览浏览器缺陷修复（2026-10-05，内容审阅通过；已合并、已部署）

状态更新（2026-10-05）：本节修复已由 PR #20 合并至 `main`（squash `4b93432f8f8e4665e3e66bc58ed064d58249dcfd`），随交付 B 一同部署为当前 production（version `8d66124c-3fa1-4f20-bb85-ad42ecd9e304`，见[恢复发布记录](./releases/2026-10-05-restore.md)）；本节其余内容保持修复完成时的记录不变。

此前的真实浏览器补验收（该轮 49 项检查、其中 4 次预览请求体三字段投影为已知缺陷绕过，范围保持原记录、不因本节改写）在已合并 A/B 的 `34c5fa8b` 上发现两个产品缺陷；本轮在同一隔离 worktree 完成最小修复、永久回归与**无绕过**浏览器复验，内容审阅已通过。本节记录修复及验证范围，代码与记录一同交付；生产尚未部署 A/B 与本次修复。

- **B-DEF-1（P1，恢复入口不可用）**：`BackupRestore.vue` 把列表的完整版本行（10 字段）直接交给 `createRestorePreview`，而 `refueling-restore.ts` 原样 `JSON.stringify` 入参，窄参数类型不删除运行时额外字段，真实 UI 的 `POST /api/restores/refueling/previews` 因此必然被服务端严格合同（恰好 `backupStreamId`/`revision`/`bundleSha256` 三字段）以 400 拒绝。修复：在客户端发送边界显式构造三字段正文；服务端严格拒绝未知字段的合同不变。
- **B-DEF-2（P2，失败原因不可见）**：预览失败的 `failure` 文案被紧随其后的 `refreshList()` 清空（该函数开头 `failure.value = ""`），本人点击后看不到原因；「当前版本不再匹配」分支与保护轮询的同名分支是同一模式，一并修复。修复：`refreshList` 支持在同一操作归属内保留失败原因（`retainFailure`），`selectVersion` 取得归属并在每个异步边界后复核；归属被新操作或待确认换人推进时，迟到的成功、失败与后置提示都不再写入新界面。
- 永久回归（客户端发送边界与路由接受两项不依赖 mock 客户端；组件回归为真实编译 SFC + 受控 mock 网络层）：`tests/refueling-restore.test.ts` 用真实列表客户端输出的完整版本行驱动真实 `createRestorePreview`，捕获实际 fetch 请求体并断言精确三字段；`tests/worker-restore.test.ts` 把该捕获正文送进真实路由 + `TestAccount`/Node SQLite + `FakeBucket` 的 Node 层读回链路，断言被服务端接受（200）——真实 workerd 与本地模拟 R2 属于另一个浏览器夹具层，不是本项；`tests/components/backup-restore.test.ts` 新增三项——预览失败后列表刷新仍保留可读原因（预览 1 次、列表 2 次）、预览失效分支同样保留、归属被新 pending 推进后迟到的失败原因不写回。修复前反例实际失败（客户端 1、路由 1、组件 2），修复后全部转绿。
- 无绕过浏览器复验（项目外重建夹具；修复候选生产构建 + 真实 workerd/SQLite 与本地模拟 R2 + 真实 Chrome `154.0.8037.95`、Playwright `1.62.1`；夹具实际只使用一个持久 profile：真实浏览器进程重建（profile a 关闭后以同一 userDataDir 重开）与同 profile 双标签共享 IndexedDB/control/Web Locks；**预览请求体投影/绕过 0 次**）：主流程 8 项（浏览器实际 POST 恰好三字段、服务端 200、差异比较、确认、恰一次切换与同 requestId 回执、接收后记录为所选版本）；未决请求跨浏览器进程 4 项（中止发送使请求未到达服务端→关闭前显式确认 pending 持久、本机无该 ID 终态、无新增恢复 POST 且服务端无回执→关闭整个浏览器进程→同 profile 重开，实际观测到本 requestId 的只读 GET/404 且从关闭前到重开后恢复 POST 增量为 0→本人以原 requestId 重试恰一次切换）；迟到归属 6 项（转发前延迟 8 秒的预览请求与同机第二标签登记 pending 交错，前台事件后旧预览结果不写入新 pending 界面、窗口内无新增恢复 POST，收尾重试得 `preview_replaced` 终态、零切换、不换号）。固定注入仅三项并逐项标注：请求中止、转发前延迟、合成前台 `focus` 事件；认证使用测试入口的合成会话，不接触真实 OIDC。旧双设备（两个独立 profile）验收只按历史归因引用，本轮未重做。
- **第二轮父审补修（B-DEF-2-remaining，P2）**：`selectVersion` 的 `finally` 仍无条件写 `loading=false`；当旧预览在途、另一窗口的 pending 已被解除且当前面板的新列表刷新仍在途时，旧预览的迟到收尾会结束新归属的加载状态，露出旧缓存版本按钮。修复：`finally` 与其他异步出口一致复核 `refreshEpoch`（成功、失败、早退与异常路径都经同一收尾）；同函数各出口逐一核对，不做无关重构。永久回归：`tests/components/backup-restore.test.ts` 新增「旧预览迟到收尾不得结束当前仍在途的列表刷新」，断言加载提示保持、旧缓存版本按钮不重新出现；修复前红、修复后绿。父侧隔离探针（只读临时副本，验证后移除、不纳入提交）在修复候选上复跑：`currentListInFlight=true, loadingVisible=true, staleButtonsEnabled=0`（父原观测为 `loadingVisible=false, staleButtonsEnabled=1`）。更正本节上一条的 S2 口径为上述基线/差值断言（不再使用累计 POST 数）。
- 实施方相关检查（第二轮）：`tests/components/backup-restore.test.ts` 25 项、组件配置全量 36 项、客户端+路由 67 项、`pnpm run typecheck`、`pnpm run build` 全部通过；无绕过浏览器夹具按更正的 S2 断言重跑 18/18。第一轮的相邻 44 项，以及未变化路径（大文档、workerd 事务、B→精确 A→B、SIGKILL 重启等）继续按归因复用，未重跑整套 494 或已闭项故障集。
- 父侧独立复核：第二轮候选 6/6 文件与 27/27 证据清单哈希一致，组件配置及父探针共 37 项通过；上一轮父侧实际运行的客户端/路由 67 项按未变文件复用。浏览器 18 项与类型检查、构建归因实施方；父侧核对脚本、结果及网络记录，未冒称重新执行。最终文档仅去重、更新交付状态并补齐验证归因，产品及测试与第二轮冻结候选一致。
- 未验边界：真机/PWA 安装、真实配额与 bfcache、生产 30 秒窗口、真实 OIDC/R2 均未验；“P1 终态后迟到列表响应”及“非 busy P1→P2 替换”的浏览器级稳定时序仍未验，既有组件证据不能算作本轮 S3。旧证据目录已不存在，本节为重建夹具的新结果（项目外第二轮回执 `implementation-round2/FIX_RECEIPT.md`），不宣称恢复旧文件哈希。

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
| [App.vue](../src/App.vue)、[RefuelingWorkspace.vue](../src/components/refueling/RefuelingWorkspace.vue) | 会话门禁、功能首页与固定页面切换、单一账号/PWA 接线与登录双次落盘编排；工作区保留新增/编辑、保存、草稿恢复及占用生命周期。 |
| [LoginPage.vue](../src/components/auth/LoginPage.vue)、[AuthStatus.vue](../src/components/auth/AuthStatus.vue)、[useAuthSession.ts](../src/composables/useAuthSession.ts)、[session-client.ts](../src/domain/auth/session-client.ts) | 登录页与 header 账号状态/操作、状态读取和可读错误；发起地址只接受 https（本机 http 例外），网络失败不谎报成功。 |
| [useRefuelingDrafts.ts](../src/composables/useRefuelingDrafts.ts)、[refueling-draft-session.ts](../src/data/refueling-draft-session.ts)、[refueling-draft-store.ts](../src/data/refueling-draft-store.ts)、[draft-environment.ts](../src/data/draft-environment.ts)、[draft-recovery.ts](../src/domain/refueling/draft-recovery.ts) | 草稿会话（绑定表单、flush、采用/放弃、保存后清理）、独立草稿库（严格持久性）、sessionStorage 线索与 Web Locks 页面占用、恢复决策（线索恢复/选择/幽灵清理/孤儿保留）。 |
| [RefuelingForm.vue](../src/components/refueling/RefuelingForm.vue)、[form.ts](../src/domain/refueling/form.ts) | 录入、校验与核对确认；确定性表单规则、十进制计算和定点金额。 |
| [refueling-document.ts](../src/data/refueling-document.ts) | Loro 文档读写、字段级变更与完整历史快照。 |
| [local-refueling-v2.ts](../src/data/local-refueling-v2.ts) | v2 账号控制锁与 IndexedDB 严格事务（documents/control）、v1→G0 迁移合并、代次切换接收与保留副本、待确认恢复结构。 |
| [useLocalRefueling.ts](../src/composables/useLocalRefueling.ts) | 页面状态、保存结果、窗口通知与聚焦刷新。 |
| [StorageStatus.vue](../src/components/refueling/StorageStatus.vue)、[vite.config.ts](../vite.config.ts) | 离线准备、持久存储申请、更新提示；cf/Vite/PWA 组合与预缓存范围。 |
| [restore 相关入口](../src/worker/restore/)（回执存储/服务/固定预览暂存/路由）、[backup-verify.ts](../src/worker/backup/backup-verify.ts)、[refueling-restore.ts](../src/data/refueling-restore.ts)、[restore-comparison.ts](../src/data/restore-comparison.ts)、[BackupRestore.vue](../src/components/refueling/BackupRestore.vue)、[refueling-server-api.ts](../src/data/refueling-server-api.ts)、[RetainedRefuelingCopy.vue](../src/components/refueling/RetainedRefuelingCopy.vue)、[scripts/backup-verify.ts](../scripts/backup-verify.ts) | 备份列表/固定预览/保护校验/唯一切换与回执、共享严格 v1/v2 完成备份验证器、本机 pending/终态与提交编排、独立只读比较、恢复面板、bootstrap/只读快照客户端、保留副本只读查看与逐项带回、离线 `backup:verify` CLI。 |
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

打开 `http://localhost:4173`，页面会先检查会话；匿名预览停在登录页。功能交互验证使用上述临时 loopback 合成 API，不能把真实 owner 凭据注入前端或当作本地测试数据。离线场景的当前结果见[登录门禁验证](#登录后访问首页)，旧阶段匿名离线进入表单的步骤已不适用。开发用 `pnpm dev`（当前端口为 `1420`，vite 仅监听 IPv6 `localhost`，`127.0.0.1` 可能不可达）；Service Worker 验证应使用生产构建预览。对已构建产物做无凭据部署演练：

```sh
pnpm exec cf deploy --prebuilt --dry-run --mode production
```

正式部署由项目锁定的 `pnpm exec cf deploy --prebuilt --mode production` 消费既有产物；首次部署已将 owner Secret 通过 `--secrets-file` 一并上传，并由配置声明同步 Custom Domain。安全输入、资源创建顺序、实际回执与授权范围见[首次登录发布单](./releases/2026-10-02-login.md)。

配置责任：`HAKO_LOGIN` 中的固定 origin、issuer、client、resource 是公开部署值，由 [cloudflare.config.ts](../cloudflare.config.ts) 声明并与[登录接入规格](./specs/eruoo-login-integration.md#3-客户端登记合同)保持一致；真实 owner 主体只能通过部署 Secret（本地用 `.dev.vars`，示例见 [.dev.vars.example](../.dev.vars.example)）输入，不进入前端、日志、公共配置或文档。`.cloudflare/`（类型与构建产物、本地 DO 状态）与 `.dev.vars` 均被 Git 忽略，类型由 `pnpm run typecheck` 先生成再检查。

登录后端与登录页面已随 `pnpm dev`/`pnpm preview` 提供：页面可读取登录状态、发起登录与退出。点击登录会跳转 eruoo 授权页，因此真实登录需要 eruoo 实际服务与真实 owner Secret；本地协议验证使用测试内的受控 OIDC 提供方（见 [worker-auth-flow.test.ts](../tests/worker-auth-flow.test.ts) 与 [tests/helpers/oidc-provider-mock.ts](../tests/helpers/oidc-provider-mock.ts)）。无 Cookie 的 `GET /api/auth/session` 返回 `{"authenticated":false}`，且在调用 DO 前直接返回，只能证明匿名路由行为；携带会话 Cookie 的读取及登录事务才涉及 DO。`POST /api/auth/login` 与 `POST /api/auth/logout` 要求精确 `Origin: https://hako.eruoo.me`。

在合成会话确认的本地预览中，可先保存一条合成记录，再打开两个同源窗口编辑不同字段并依次或同时保存，刷新后检查两项都在；会话允许进入工作区后，未保存的输入从独立草稿库恢复，金额差异需要重新确认，另一个窗口正在编辑的草稿不会被静默接管。草稿写入使用严格持久性事务；草稿库不可用（例如浏览器禁用站点数据）时会阻止登录跳转而不是丢掉输入。

## 尚未完成

账号同步已发布，首轮核心真实协作验收已通过；剩余未验场景、手机版本和认证路径未知项由[发布记录](./releases/2026-10-03-sync.md#未验与待补)维护。普通 Chrome 关闭重开、真实旧库导入、长期会话周期等不能由已完成的 PWA 联网重开或短时退出重登替代。

加油业务文档的整文档恢复与「备份与恢复」面板已由交付 B 实现、合并（PR #19 + #20）并部署（2026-10-05，见[恢复操作](#恢复操作b2026-10-05隔离-worktree未合并未部署)与[恢复发布记录](./releases/2026-10-05-restore.md)）；生产真实恢复、有差异预览与保护门禁未执行，等待用户实际恢复需求。完整统计、AI 识图，以及[完成码后备交互](./specs/eruoo-login-integration.md#62-浏览器--pwa-发起环境绑定)仍未实现。已有旧验证记录选择导入入口不等于真实导入已验。服务端副本与本机未上传修改、草稿的边界见账号同步规格；恢复能力与未验边界以[恢复设计](./specs/restore.md)和[恢复发布记录](./releases/2026-10-05-restore.md)为准。

1,000/10,000 条含历史的容量与延迟、Cloudflare Free CPU 和其他平台仍按[后续验证安排](./specs/architecture-validation-research.md#5-下一步最小验证)执行。会话与事务的时钟边界已有本地可控时钟证据，真机长期 Cookie 保存行为尚未验证；本次文档收尾没有追加这些检查。
