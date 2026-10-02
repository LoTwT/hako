# 文档索引

## 实施进度

- [账号数据隔离与最小同步](./specs/account-sync.md)：本地实现切片的账号边界、旧验证数据主动导入、HTTP/Loro 持久确认与原始容器合同；实际验证及审阅修复由[本地进展](./local-validation.md#账号数据隔离与双副本同步本地切片)维护，尚未发布。

- [本地最小验证进展](./local-validation.md)：设计文档 PR #4、本地验证版 PR #5 及登录切片 PR1 至 PR3（#7、#8、#9）均已合并。维护同源 Worker、OIDC/DO 会话、登录 UI、草稿保护与返回恢复的实现范围、验证结果、代码入口和本地运行方法；首次 production 部署已完成，用户已确认真实登录成功，退出/重登、草稿往返和真机验收待分项回报。
- [首次登录发布单（2026-10-02）](./releases/2026-10-02-login.md)：精确候选、实际 version/namespace/域名证书、Secret 安全处理、只读及线上验收回执、数据保留与恢复方式。已获整组授权并完成部署和自主检查；维护仍未知项及桌面/iPhone 本人验收步骤。

- [首页与登录门禁发布（2026-10-02）](./releases/2026-10-02-ui.md)：后续 UI 的最终审阅、发布范围、恢复边界与 PR 回执入口。

## 当前设计

- [Hako 重新设计：范围与决策记录](./specs/redesign.md)：本轮产品定位、功能范围和架构讨论的唯一当前入口。维护独立功能首页与登录门禁的当前规则；AI 截图预填、人工核对、保留手填及服务端调用方向已确认，技术接入已形成评审稿，整体架构与技术选型继续审阅。
- [Hako 首版技术方案](./specs/architecture-proposal.md)：Vue PWA、Loro、IndexedDB 与 Cloudflare 同步/备份的整体建议；已开始本地验证，完整首版及云端接入尚未完成。
- [架构补充调研与验证安排](./specs/architecture-validation-research.md)：长期登录、易捷截图与 Cloudflare Free 的官方资料核查、方案修订依据及验证顺序；本地运行进展由实施进度维护，云端与真机仍待验证。
- [Hako 加油截图识别接入规格](./specs/ai-refueling-recognition.md)：单张截图、固定 DeepSeek、服务端调用的请求合同、候选字段、预填规则、限额、错误映射与验收；第一版评审稿，技术参数尚未确认或联调。
- [Hako × eruoo/server 登录接入规格](./specs/eruoo-login-integration.md)：正式域名已启用，eruoo 客户端支持已在双环境上线；维护实际合同、Hako 最小登录切片、环境接线及发布恢复边界。Hako PR1 至 PR3 已合入并首次部署，用户已报告真实登录成功；后续分项验收待回报，回调 UI、功能首页与登录门禁修订已获后续发布授权，结果见对应发布记录。
- [加油统计工具算法对照](./specs/refueling-algorithm-research.md)：小熊油耗等工具的官方依据、公式算例与公开资料的边界；Hako 采用决定仍由重新设计记录维护。

## 历史 AI 方案

- [eruoo/server AI 请求转发评审稿](./specs/eruoo-ai-proxy-review.md)：2026-09-15 暂缓的旧接口提案，仅保留历史参考。2026-09-23 恢复识图需求不代表重新采用本稿，接入需依据 eruoo/server 的实际服务合同评估。

## 临时规格

以下三份文档是上一轮未确认的方案，自 2026-09-13 起作为历史参考保留。其中的产品定位、技术选型、实施顺序和门禁不再约束本轮重新设计；如需沿用某项决策，应在[当前设计](./specs/redesign.md)中重新确认。

1. [Hako 客户端共享基建](./specs/hako-client-foundation.md)
2. [Hako 服务端共享基建](./specs/hako-server-foundation.md)
3. [加油统计模块](./specs/fuel-tracking.md)

这些文档保留原文和现有链接，便于追溯旧方案。后续整理历史文档时，应同步维护入站链接。
