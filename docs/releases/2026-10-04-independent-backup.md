# Hako 独立备份发布与首份真实备份读回（2026-10-04）

整理日期：2026-10-04（Asia/Shanghai）。**独立备份已随 PR #13/#14 合并、部署到 production，并完成首份真实备份的独立读回验证。** 技术合同见[独立备份合同](../specs/backup.md)，产品取舍见[重新设计记录](../specs/redesign.md#备份与恢复)；恢复 UI、恢复写入与 `documentGeneration` 协议仍未实现。

## 发布身份与时间线

| 项目 | 值 |
| --- | --- |
| 实现交付（PR #13） | squash `b586ad271e08d6f15d8497fa66f6a70d9aad11ad`，tree `8f3bf072de8f2a81524a1a12b60d8e86835a5b6d`，parent `c73effa1e2ba708ed5fd7aec80376f819e6cc5fa` |
| 文案对齐（PR #14） | squash `fc10854514fbb4d62118da913a01d00ab1d56102`，tree `0f173d9f404243eb352aa94cfbeec902a9dd8701`，parent `b586ad27`；两条静态提示与交付状态一致 |
| 部署 | 2026-10-04 09:30:35Z：version `b6287e49-6353-470e-86d6-3aec639e5f1c`，deployment `99d57d7a-1266-4f2e-a646-2dd453cee2cd`，流量 **100%** |
| 上一活动版本（保留） | version `07ea9c45-3d57-4edc-9a20-1ff733c25266`（deployment `ac7224e5-16e2-4aa1-b676-fdab47c6fd49`）及其余历史版本 |
| 桶 | `hako-backups-production` 创建于 2026-10-04 09:30:12Z：R2 Standard、jurisdiction default、私有（r2.dev 关闭、无自定义域） |
| 首份真实备份读回 | 2026-10-04 09:35:39Z：revision `1`、recordCount `1`、bundle SHA-256 `1743ba46d71d669c9a7b8e504561a58f94153c939387d739cdf70c38c0c7cdda`，独立验证通过 |

时间均为 UTC；平台读回时间只归属对应读回，不证明此后状态未变。

## 交付范围

- 服务端独立备份按合同实现并部署：完整 Loro 业务文档快照、固定 30 秒窗口、1/5/15/60 分钟→每小时退避、最近 30 份裁剪、只读状态接口与 blocked 语义；配置唯一入口为 [cloudflare.config.ts](../../cloudflare.config.ts)（新增 `HAKO_BACKUPS` 绑定）。
- 部署消费已审候选 tree `0f173d9f…` 的 14 个预构建产物（相对原合并候选 tree `8f3bf072…`：9 个产物相同、3 个原地变化、2 个前端资源重命名替换；Worker bundle 与 wasm 未变）。产物 SHA-256 清单保留在仓库外。
- 桶为本次新建的私有 Standard 桶；现有 Secret、域名、Durable Object namespace/实例与数据全部沿用；部署继承既有 `HAKO_OWNER_SUBJECT`（未读取其值、未重传）。
- workers.dev 与预览入口保持关闭；`hako.eruoo.me` 自定义域与 Universal SSL 保持启用。
- 两条用户可见文案随 PR #14 对齐：同步成功不代表独立备份已完成；本版暂不提供备份恢复。

## 首份真实备份读回（独立、脱敏）

- 触发：用户本人一次正常前台同步（未代登录、未新增业务编辑）；服务端在既有文档上建立首份完成备份（revision 1）。
- 方法：只读列出桶内完成标记，选取最新标记与其精确包，在内存中完成严格格式解析、环境/账号/文档/stream/revision 归属核对、包与快照长度及 SHA-256、全新 Loro 导入、历史摘要与记录数核对。
- 结果：**通过**（约 5.4 秒）。输出仅含 revision、recordCount、bundle SHA-256、结果与耗时；业务字段、Cookie/Token 未输出或保存。
- 边界：这是 **R2 内部完整性与独立可读性验证**，不是生产恢复演练；不证明所有设备离线修改已被覆盖，不证明长期 30 秒窗口/30 份裁剪行为，也不等于生产账单。
- 公开可达性只证明对应公开路由行为（`GET /api/health` 200；匿名 `GET /api/auth/session` 未认证，不创建账号状态）。
- 编号：后续验收以“高于已归档完成版本的新完成版本及其覆盖”为准，不把下一个版本号预承诺为 2（合并窗口可造成缺号）。
- 本次未回退、未人工删除数据；自动最近 30 份裁剪仅按合同在该桶、该序列内运行，当前尚未触发。

## 验证归因（未重跑）

| 证据 | 归属 |
| --- | --- |
| 300 项测试（227 既有 + 61 备份单元[含引擎 50] + 12 workerd）、typecheck/build/prebuilt dry-run | 实施方实跑，按候选范围复用 |
| 两条文案补丁的 build/typecheck 与无写入 prebuilt dry-run | 发布准备会话实跑 |
| 父会话/分析会话定向检查与 workerd 探针 | 以已归档回执为准，未重跑 |
| 首份真实备份读回 | 发布会话只读执行（仅脱敏输出） |

## 未验证与后续

- 生产 R2 操作计量/账单与 DO SQLite 实际计费未对照；长期窗口/退避/30 份裁剪行为仅有合同与本地证据。
- 恢复（恢复 UI、恢复写入、`documentGeneration`）未实现；恢复前备份、整文档恢复、跨代次衔接与身份重绑定尚未落地。
- blocked 恢复路径与多设备覆盖未被本次读回证明。
- 原始脱敏回执保留在仓库外；后续变更以对应 PR 与发布记录为准。
