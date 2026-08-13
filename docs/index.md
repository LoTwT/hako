# 文档索引

## 临时规格

以下三份文档共同组成一个临时规格组，当前均为“待确认”。它们描述目标架构和分阶段门禁，不要求一次性实现全部内容；编号表示文档入口，不表示实施顺序或只能单向引用。

1. [Hako 客户端共享基建](./specs/hako-client-foundation.md)
2. [Hako 服务端共享基建](./specs/hako-server-foundation.md)
3. [加油统计模块](./specs/fuel-tracking.md)

当前实施顺序固定为：客户端离线应用壳 → 离线 Fuel → OAuth/设备授权 → Passkey → Fuel private sync beta → 发布 hardening。纯离线阶段不创建远端资源；服务端是否抽成独立项目只按[服务端规格的拆分门禁](./specs/hako-server-foundation.md#1-决策需要服务端但暂不拆仓)判断。

清理门禁：只有当三份规格全部实现并通过验收、实际架构与运维知识已经写入长期文档、全部入站链接已在同一变更中更新后，才一起删除这三份临时规格及本节入口；不得提前单独删除其中一份。
