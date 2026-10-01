# 本地最小验证进展

更新：2026-10-01。设计文档已通过 [PR #4](https://github.com/LoTwT/hako/pull/4) 合入；本地验证版已通过 [PR #5](https://github.com/LoTwT/hako/pull/5) 合入。同日完成 PR1：同源 Hako Worker 与运行配置（cf CLI + Cloudflare Vite 插件 beta），本地验证记录见下方[PR1 验证](#2026-10-01-pr1-同源-worker-与运行配置验证)。本文件维护实现进度和运行证据，产品规则仍以[重新设计记录](./specs/redesign.md)为准。

当前完成的是本地手填验证版加同源 Worker：`/api` 命名空间由 Worker 承载（健康检查与 API 边界），静态页面与 PWA 离线能力不变；登录协议合同已按[登录接入规格](./specs/eruoo-login-integration.md)落地为后端配置读取与校验，但尚未提供登录接口。下一项工作是[完整 OIDC 登录事务与本应用会话](./specs/eruoo-login-integration.md#63-下一步-hako-最小实现范围)（PR2），再接登录 UI 与草稿恢复（PR3）。eruoo 的客户端支持已上线，10 月 1 日接收的[服务端只读复核记录](./specs/eruoo-login-integration.md#2026-10-01-服务端只读复核)确认发布状态未变。

## 已实现的范围

- 一页手填表单与记录列表：新增、编辑、是否加满、可选油灯及账单补充字段；金额联动、人工修正保护、精度与必填校验、金额差异确认和里程异常提示。
- Loro 字段级 Map 与完整历史快照；同源窗口使用 Web Locks 串行读取最新快照并写入字段变更。IndexedDB 快照、版本向量和待同步标记在同一严格持久性事务中保存，事务完成后才显示成功。
- 写入失败保留当前输入，不把失败修改留在可继续保存的共享文档中；重试复用记录 ID。BroadcastChannel 通知其他窗口重新读取，重新聚焦时也会读取最新版本。
- PWA 静态资源预缓存包含 Loro Wasm，可在首次准备成功后离线重开。提供持久存储申请和更新提示；新版本等待旧窗口全部关闭，不从某个窗口强制刷新其他窗口的未保存表单。
- 同源 Hako Worker（PR1，原生 `fetch`，无 Web 框架）：`/api` 与 `/api/*`（含页面导航请求）一律进入 Worker；`GET`/`HEAD /api/health` 返回简单健康状态，未支持方法返回 405 与 `Allow`，未知 API 返回 JSON 404，API 响应统一 `Cache-Control: no-store`；`/api/auth/callback` 得到 API 404 而非首页。非 API 请求由静态资产承载，SPA 回退仅作用于未命中资产的非 API 路径。
- [cloudflare.config.ts](../cloudflare.config.ts) 是唯一 Cloudflare 配置入口（PR1）：单个 `hako` Worker、正式域名 `hako.eruoo.me`（关闭 workers.dev）、兼容日期 2026-10-01、`assets.runWorkerFirst` 固定 `/api` 与 `/api/*`、observability 开启日志与 traces 并对 query 脱敏。工具链采用 cf CLI（`cf@1.0.0-beta.10`）与 `@cloudflare/vite-plugin@2.0.0-beta.sha-ad79608dd` beta 组合。
- 登录配置合同（PR1）：固定 origin、issuer、client、resource 以 `HAKO_LOGIN` JSON 绑定声明；owner 主体由 `HAKO_OWNER_SUBJECT` 后端 Secret 输入。Worker 在读取登录配置时执行校验（HTTPS origin 形态、拒绝本地/内网地址、非空 owner），回调由固定配置组装为 `${origin}/api/auth/callback`，不从请求 Host/Origin 推导。缺少 owner 无法取得有效登录配置，但类型生成、构建、健康检查与静态页面不依赖真实 owner；真实 owner 不进入前端、日志、公共配置或文档。
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

## 代码入口

| 位置 | 职责 |
| --- | --- |
| [cloudflare.config.ts](../cloudflare.config.ts) | 唯一 Cloudflare 配置入口：Worker 名称/兼容日期、正式域名、`runWorkerFirst` API 分流、observability 与登录配置绑定。 |
| [src/worker/index.ts](../src/worker/index.ts)、[api.ts](../src/worker/api.ts) | Worker 入口与 API 路由：健康检查（GET/HEAD）、405、JSON 404、`no-store`。 |
| [login-config.ts](../src/worker/login-config.ts) | 登录配置合同：固定值与 owner Secret 的读取、校验、回调组装。 |
| [App.vue](../src/App.vue)、[RefuelingWorkspace.vue](../src/components/refueling/RefuelingWorkspace.vue) | 页面组合、新增和编辑流程、保存结果衔接。 |
| [RefuelingForm.vue](../src/components/refueling/RefuelingForm.vue)、[form.ts](../src/domain/refueling/form.ts) | 录入、校验与核对确认；确定性表单规则、十进制计算和定点金额。 |
| [refueling-document.ts](../src/data/refueling-document.ts) | Loro 文档读写、字段级变更与完整历史快照。 |
| [local-refueling.ts](../src/data/local-refueling.ts) | Web Locks、最新快照读取、候选文档和 IndexedDB 严格事务。 |
| [useLocalRefueling.ts](../src/composables/useLocalRefueling.ts) | 页面状态、保存结果、窗口通知与聚焦刷新。 |
| [StorageStatus.vue](../src/components/refueling/StorageStatus.vue)、[vite.config.ts](../vite.config.ts) | 离线准备、持久存储申请、更新提示；cf/Vite/PWA 组合与预缓存范围。 |
| [refueling-form.test.ts](../tests/refueling-form.test.ts)、[refueling-document.test.ts](../tests/refueling-document.test.ts)、[worker-api.test.ts](../tests/worker-api.test.ts)、[worker-login-config.test.ts](../tests/worker-login-config.test.ts) | 表单规则、Loro 文档与 Worker 路由/配置合同的自动化用例。 |
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

配置责任：`HAKO_LOGIN` 中的固定 origin、issuer、client、resource 是公开部署值，由 [cloudflare.config.ts](../cloudflare.config.ts) 声明并与[登录接入规格](./specs/eruoo-login-integration.md#3-客户端登记合同)保持一致；真实 owner 主体只能通过部署 Secret（本地用 `.dev.vars`，示例见 [.dev.vars.example](../.dev.vars.example)）输入，不进入前端、日志、公共配置或文档。`.cloudflare/`（类型与构建产物）与 `.dev.vars` 均被 Git 忽略，类型由 `pnpm run typecheck` 先生成再检查。

手工复核可先保存一条合成记录，再打开两个同源窗口编辑不同字段并依次或同时保存，刷新后检查两项都在。取消或离开未保存表单会提示；当前草稿仅保留在页面内存中，强制关闭或系统终止仍可能丢失未保存输入。

## 尚未完成

这不是可正式使用的首版：尚未接入本人登录、长期会话及测试时钟、跨设备同步、云端备份与恢复、历史查看/恢复界面、完整统计、历史导入和 AI 识图。同源 Worker 与 API 边界已就绪（PR1），但完整 OIDC 登录事务、DO 会话与 eruoo 出站接线属于 PR2，登录 UI 与草稿恢复属于 PR3。清除站点数据会丢失本验证版记录，当前不能从云端恢复。

会话时钟边界随登录模块验证；1,000/10,000 条含历史的容量与延迟、Cloudflare Free CPU、真实 iPhone Chrome/PWA 和其他平台仍按[后续验证安排](./specs/architecture-validation-research.md#5-下一步最小验证)执行。本轮没有创建云资源、调用付费模型或部署；真实部署需先完成域名绑定与 owner Secret 写入，且尚未验证。
