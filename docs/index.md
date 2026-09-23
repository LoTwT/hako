# 文档索引

## 当前设计

- [Hako 重新设计：范围与决策记录](./specs/redesign.md)：本轮产品定位、功能范围和架构讨论的唯一当前入口。AI 截图预填、人工核对、保留手填及服务端调用方向已确认；技术接入已形成评审稿，整体架构与技术选型继续审阅。
- [Hako 首版技术方案](./specs/architecture-proposal.md)：Vue PWA、Loro、IndexedDB 与 Cloudflare 同步/备份的整体建议，已整合登录与 AI 接入规格、费用边界及验收安排；待审阅，尚未实施。
- [架构补充调研与验证安排](./specs/architecture-validation-research.md)：长期登录、易捷截图与 Cloudflare Free 的官方资料核查、方案修订依据及下一步最小验证；资料核查完成，运行与真机验证未执行。
- [Hako 加油截图识别接入规格](./specs/ai-refueling-recognition.md)：单张截图、固定 DeepSeek、服务端调用的请求合同、候选字段、预填规则、限额、错误映射与验收；第一版评审稿，技术参数尚未确认或联调。
- [Hako × eruoo/server 登录接入规格](./specs/eruoo-login-integration.md)：独立 Web 客户端登记、OIDC 合同、双方改动、PWA 登录返回、验收及发布回退要求；交接评审稿，尚未实施。
- [加油统计工具算法对照](./specs/refueling-algorithm-research.md)：小熊油耗等工具的官方依据、公式算例与公开资料的边界；Hako 采用决定仍由重新设计记录维护。

## 历史 AI 方案

- [eruoo/server AI 请求转发评审稿](./specs/eruoo-ai-proxy-review.md)：2026-09-15 暂缓的旧接口提案，仅保留历史参考。2026-09-23 恢复识图需求不代表重新采用本稿，接入需依据 eruoo/server 的实际服务合同评估。

## 临时规格

以下三份文档是上一轮未确认的方案，自 2026-09-13 起作为历史参考保留。其中的产品定位、技术选型、实施顺序和门禁不再约束本轮重新设计；如需沿用某项决策，应在[当前设计](./specs/redesign.md)中重新确认。

1. [Hako 客户端共享基建](./specs/hako-client-foundation.md)
2. [Hako 服务端共享基建](./specs/hako-server-foundation.md)
3. [加油统计模块](./specs/fuel-tracking.md)

这些文档保留原文和现有链接，便于追溯旧方案。后续整理历史文档时，应同步维护入站链接。
