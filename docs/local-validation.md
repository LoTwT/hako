# 本地最小验证进展

更新：2026-10-01。设计文档已通过 [PR #4](https://github.com/LoTwT/hako/pull/4) 合入；本地验证版已通过 [PR #5](https://github.com/LoTwT/hako/pull/5) 合入。本文件维护实现进度和运行证据，产品规则仍以[重新设计记录](./specs/redesign.md)为准。

当前完成的是本地手填验证版。下一项工作是[Hako 最小登录实现](./specs/eruoo-login-integration.md#63-下一步-hako-最小实现范围)，再接正式服务验证完整登录与 iPhone PWA。eruoo 的客户端支持已上线，10 月 1 日接收的[服务端只读复核记录](./specs/eruoo-login-integration.md#2026-10-01-服务端只读复核)确认发布状态未变。

## 已实现的范围

- 一页手填表单与记录列表：新增、编辑、是否加满、可选油灯及账单补充字段；金额联动、人工修正保护、精度与必填校验、金额差异确认和里程异常提示。
- Loro 字段级 Map 与完整历史快照；同源窗口使用 Web Locks 串行读取最新快照并写入字段变更。IndexedDB 快照、版本向量和待同步标记在同一严格持久性事务中保存，事务完成后才显示成功。
- 写入失败保留当前输入，不把失败修改留在可继续保存的共享文档中；重试复用记录 ID。BroadcastChannel 通知其他窗口重新读取，重新聚焦时也会读取最新版本。
- PWA 静态资源预缓存包含 Loro Wasm，可在首次准备成功后离线重开。提供持久存储申请和更新提示；新版本等待旧窗口全部关闭，不从某个窗口强制刷新其他窗口的未保存表单。

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

## 代码入口

| 位置 | 职责 |
| --- | --- |
| [App.vue](../src/App.vue)、[RefuelingWorkspace.vue](../src/components/refueling/RefuelingWorkspace.vue) | 页面组合、新增和编辑流程、保存结果衔接。 |
| [RefuelingForm.vue](../src/components/refueling/RefuelingForm.vue)、[form.ts](../src/domain/refueling/form.ts) | 录入、校验与核对确认；确定性表单规则、十进制计算和定点金额。 |
| [refueling-document.ts](../src/data/refueling-document.ts) | Loro 文档读写、字段级变更与完整历史快照。 |
| [local-refueling.ts](../src/data/local-refueling.ts) | Web Locks、最新快照读取、候选文档和 IndexedDB 严格事务。 |
| [useLocalRefueling.ts](../src/composables/useLocalRefueling.ts) | 页面状态、保存结果、窗口通知与聚焦刷新。 |
| [StorageStatus.vue](../src/components/refueling/StorageStatus.vue)、[vite.config.ts](../vite.config.ts) | 离线准备、持久存储申请、更新提示和预缓存范围。 |
| [refueling-form.test.ts](../tests/refueling-form.test.ts)、[refueling-document.test.ts](../tests/refueling-document.test.ts) | 表单规则与 Loro 文档的自动化用例。 |

`src-tauri/` 保留早期原生骨架，当前交付方向是浏览器和 PWA，原生分发不作为前置。

## 本地查看

Node、pnpm 版本与运行命令以 [package.json](../package.json) 为准，依赖版本以[锁文件](../pnpm-lock.yaml)为准。

```sh
pnpm install --frozen-lockfile
pnpm run test
pnpm run build
pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort
```

打开 `http://localhost:4173`，先联网等待离线页面准备成功，再测试断网。开发用 `pnpm run dev`，当前端口为 `1420`；Service Worker 验证应使用生产构建预览。

手工复核可先保存一条合成记录，再打开两个同源窗口编辑不同字段并依次或同时保存，刷新后检查两项都在。取消或离开未保存表单会提示；当前草稿仅保留在页面内存中，强制关闭或系统终止仍可能丢失未保存输入。

## 尚未完成

这不是可正式使用的首版：尚未接入本人登录、长期会话及测试时钟、跨设备同步、Cloudflare Worker/DO/R2、云端备份与恢复、历史查看/恢复界面、完整统计、历史导入和 AI 识图。清除站点数据会丢失本验证版记录，当前不能从云端恢复。

会话时钟边界随登录模块验证；1,000/10,000 条含历史的容量与延迟、Cloudflare Free CPU、真实 iPhone Chrome/PWA 和其他平台仍按[后续验证安排](./specs/architecture-validation-research.md#5-下一步最小验证)执行。本轮没有创建云资源、调用付费模型或部署。
