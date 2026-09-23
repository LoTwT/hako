# eruoo/server AI 请求转发：Hako 接入评审稿

日期：2026-09-15  
状态：历史参考，不作为当前接入合同  
提出方：Hako  
评审对象：在现有 eruoo/server 中增加使用 API Key 鉴权的模型原生协议转发能力。

> 2026-09-15，用户因方案过于复杂，决定“暂不做 ai 识图了，完全手填表单”。Hako 的 AI 识图、模型配置与本代理接入需求一并暂缓，不再等待本稿评审或将其作为当前实施任务。

> 2026-09-23，用户确认恢复截图识别后预填表单、人工核对保存，并保留完全手填。恢复的是产品需求；本稿仍属历史提案，新接入需依据 eruoo/server 已有 DeepSeek 服务重新评估。

以下保留暂缓前的接口提案，供历史追溯。Hako 当前需求以[重新设计记录](./redesign.md#ai-截图识别)为准；本文中的路径、权限、限额、配置与验收要求不因恢复识图需求而自动重新采用。

## 1. 要解决的问题

Hako 是本人使用的单账号应用，通过浏览器和可安装 PWA 使用。首个 AI 场景是识别加油记录截图：Hako 组织请求和输出字段，模型返回结果后，由 Hako 校验、生成草稿，再由用户核对保存。离线手动记录和统计继续在本地运行。

当前主要模型为 `gpt-6-astra`，后续需要接入协议兼容的 GPT 模型。部署平台为 Cloudflare，费用和维护成本尽量低。实际模型 API 提供方和凭证尚未配置，也未执行应用内模型调用。

用户提出的方案是：**Hako 通过 API Key 调用 eruoo/server，eruoo/server 将请求发给 AI，并原样返回 AI 响应。** 本稿以此作为评审基线，重点确认服务边界、协议和必要的运行约束。

## 2. 尚待确认的接入选择

以下事项不阻塞接口提案评审，但决定最终接线方式，不能当作用户已经选择：

| 事项 | 当前状态 | 对实现的影响 |
| --- | --- | --- |
| Hako 的请求由哪里发出 | 浏览器/PWA 直连或 Hako 的 Cloudflare 后端调用，用户尚未回答 | 决定 API Key 保存位置、是否需要跨源接口，以及是否增加后端转发一跳 |
| 浏览器直连的鉴权 | 用户提出 API Key；Agent 建议复用已选登录体系的访问令牌，尚未形成采用决定 | API Key 契约可以先评审，但不能据此将长期共享 Key 写进前端包，也不能自动把提案改成 OAuth-only |
| Hako 设置页的字段含义 | 已要求可修改 API 地址、API Key、模型名；新方案中地址和 Key 指向代理还是模型提供方，尚未确认 | 本稿建议 Hako 配置代理地址和 eruoo 访问 Key，上游配置由 eruoo/server 管理；该映射需用户确认 |

Hako 已决定复用 eruoo/server 登录，这不自动授予 AI 调用权限。采用 API Key 调用 AI 也不自动替代 Hako 的账号登录和同步认证。

## 3. 职责与首版范围

```text
Hako 调用方
  原生模型请求 + eruoo 访问凭证
        │
        ▼
eruoo/server：鉴权 → 检查调用策略 → 注入上游凭证 → 转发
        │
        ▼
受控配置的 GPT 模型 API
        │
        └── 原生响应体 / 状态 / 流式内容 → Hako 解析与核对
```

| 责任方 | 负责内容 |
| --- | --- |
| Hako | 截图选择、提示词、输出 schema、模型名称、结果解析、字段校验、草稿和用户核对，以及加油数据、历史、同步和统计业务 |
| eruoo/server | 调用凭证验证、权限、受控上游地址、提供方密钥、模型准入、请求转发、超时、限流、必要的运行记录 |
| 模型 API 提供方 | 推理、图片理解和原生 API 响应；其账号权限、计费和数据处理政策单独确认 |

首版建议只实现一个上游配置和 Responses HTTP 接口，支持 JSON 响应及 SSE 流式响应。Hako 使用请求内的图片数据，首版不需要为识图增加图片托管或文件上传接口。

本次范围不包含加油专用服务端接口、CRDT 存储、历史导入、聊天历史、工具执行、模型自动回退、响应缓存或用量计费系统。也不要求完整代理 OpenAI 的 Files、Batch、Realtime、Conversations 等接口。

最小部署方式是现有单包、单 Worker 内的一个 AI 功能模块。Cloudflare AI Gateway 的原生 OpenAI 端点可作为协议参考；本稿不要求再增加 Gateway 或独立服务。[参考：原生 OpenAI 端点](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)。

## 4. 当前 eruoo/server 的接入基础

下列为 2026-09-15 的本地代码与规格核查结果，接收评审时应检查仓库是否已有后续变化。

| 当前事实 | 对本提案的影响 |
| --- | --- |
| 已有 owner 身份、GitHub/Passkey、OAuth/OIDC，以及 API Key 生命周期管理 | 复用已有身份和凭证设施 |
| API Key 通过 `x-api-key` 传递，哈希保存；当前权限固定为 `status:read` | 需要新增 AI 权限和专用签发方式；不能直接给现有 Key 提权 |
| 通用 API 拒绝混合 Cookie、Bearer、API Key；不从 URL 或请求体取通用凭证 | AI 路由沿用唯一凭证载体规则 |
| 通用请求体上限 1 MiB，普通读取等待预算 5 秒 | 图片和模型推理需要 AI operation 自己的限额；不能全局放宽认证接口 |
| 自有错误采用 RFC 9457 Problem，现有业务接口没有通用成功包装 | 保留代理错误契约；上游响应采用原生协议例外 |
| 当前没有 AI 路由，生产跨源允许项为空，Hako Web 客户端尚未启用 | 路由、权限以及最终选定的客户端接线都需要实施 |

证据入口：[认证配置](https://github.com/eruoo/server/blob/806250c1b1ea9c7a8bace499caa20839a691e9bd/src/worker/auth.ts)、[API Key 权限](https://github.com/eruoo/server/blob/806250c1b1ea9c7a8bace499caa20839a691e9bd/src/shared/api-key.ts)、[路由注册](https://github.com/eruoo/server/blob/806250c1b1ea9c7a8bace499caa20839a691e9bd/src/worker/routes/index.ts)、[请求边界实现](https://github.com/eruoo/server/blob/806250c1b1ea9c7a8bace499caa20839a691e9bd/src/worker/http/response.ts)、[协议规格](https://github.com/eruoo/server/blob/806250c1b1ea9c7a8bace499caa20839a691e9bd/docs/specs/protocol-contract.md)。

## 5. 建议的调用契约

### 5.1 路由和凭证

| 项目 | 建议契约 |
| --- | --- |
| 方法与路径 | `POST /api/ai/responses` |
| 对应上游 | 受控 API Base URL 下的 `/responses`；Base URL 例如以 `/v1` 结尾 |
| 内容类型 | `application/json` |
| eruoo 访问凭证 | `x-api-key`，不接受 URL/query/body 中的 Key |
| 路由权限 | 新增 `ai:invoke`，建议底层表示为 `ai: ["invoke"]`；只授予已明确登记的 AI operation |
| 请求体 | 原生 Responses JSON 对象；Hako 明确发送 `model` 和 `input` |
| 返回内容 | 原生 JSON 或 `text/event-stream`，不添加业务包装 |

路径沿用 eruoo/server 当前 `/api` 组织方式，不增加通用 `/api/v1` 或路径通配代理。未知路径、方法和别名继续按现有路由规则拒绝。只有最终选择浏览器跨源直连时，才登记对应的 `OPTIONS` 预检。

概念性请求示例；这里只展示传输契约，不代表已配置模型账户：

```http
POST /api/ai/responses
Content-Type: application/json
x-api-key: <ERUOO_AI_ACCESS_KEY>

{
  "model": "gpt-6-astra",
  "input": "只回复 OK",
  "stream": false,
  "store": false
}
```

实际识图时，Hako 将 `input` 换为包含文字和 `input_image` 的原生输入，并提供结构化输出要求。模型请求参数由 Hako 管理；eruoo/server 不插入加油提示词，不改写油量、金额或统计规则。[参考：图片输入](https://developers.openai.com/api/docs/guides/images-vision)、[结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)。

### 5.2 API Key 的权限与生命周期

eruoo 访问 Key 与模型提供方 Key 是两种不同凭证：前者用于进入代理，继续哈希保存；后者由服务端读取后用于调用模型，不能放进现有哈希 Key 字段。

建议通过现有 owner 管理流程签发“仅 AI 调用”的 Key，沿用期限、撤销和归属校验。现有 `status:read` Key 保持原权限。具体如何在创建入口表达 Key 用途，由 eruoo/server 评审给出最小方案；普通调用方不能提交任意 permissions，也不能使用 AI Key 修改上游配置或签发其他 Key。

首版 API Key 调用不携带 Cookie 或 `Authorization`。若 Hako 选择浏览器直连，需要避免浏览器附带同源 Cookie；若后续采用 OAuth，单独登记该载体和路由授权，不能做凭证失败后的自动回退。

“原生模型协议”不表示所有 OpenAI SDK 都可零改动接入：使用 SDK 时，必须核对其鉴权头，避免同时发送 Bearer 和 `x-api-key`。Hako 可以先用普通 HTTP 客户端发送上述契约。

### 5.3 请求校验和上游选择

服务端依次完成精确路由匹配、凭证载体检查、入口限制、身份与权限验证、请求体大小和最小 schema 校验，再发起上游请求。拒绝请求不得触发模型调用；鉴权超时后迟到的成功结果也不得继续发起上游请求。

最小校验包括合法 JSON 对象、必需字段、允许的模型及实际需要的调用策略。其它原生字段应在校验后保留，不能被 schema 默认剔除。通过校验后转发原请求内容，不静默替换模型或参数。新字段是否获得能力支持仍由实际模型 API 决定。

上游地址只来自服务端配置，不读取调用方传入的代理目标 URL、Host 或上游 Key；第一版只映射固定 `/responses` 路径，不拼接任意请求路径。Base URL 使用 HTTPS，不接受用户信息、查询串、片段或指向自身的配置。上游重定向不自动跟随，收到 3xx 视为上游配置或协议异常，按代理错误返回。

出站鉴权由服务端新建，仅使用模型提供方密钥。Hako 的 `x-api-key`、Cookie、Bearer 以及浏览器 Origin 不转发给模型提供方。

### 5.4 “原样返回”的精确定义

| 内容 | 处理方式 |
| --- | --- |
| 正常上游 JSON | 保留响应内容和 HTTP 状态，不提取成自定义 `data`，不解析后重新拼装 |
| 上游错误 | 保留上游 4xx/5xx 的状态和响应体，不能转成 200 或假装 Hako 未登录 |
| SSE | 边接收边转发，保持事件内容与顺序，不等待整个结果，不注入自定义成功事件 |
| 响应头 | 使用明确的允许项，建议保留 `Content-Type` 和 `Retry-After`；补充 eruoo 自己的追踪及跨源头 |
| Cookie、跳转及连接头 | 不透传 `Set-Cookie`、`Location` 或逐跳头；处理 `Connection` 指名的头。压缩与长度头必须与实际传输一致，不复制失效的 `Content-Length` |

“原样”保证应用内容和事件语义，不保证网络分块、HTTP 头顺序或压缩字节一致。上述限制以及 §6 的资源终止条件属于公开契约，不应被隐藏为实现细节。HTTP 转发依据：[RFC 9110 §7.6](https://www.rfc-editor.org/rfc/rfc9110.html#section-7.6)。Workers 可直接流式返回上游响应，无需完整缓冲：[Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)。

### 5.5 错误来源和流中断

建议 AI 路由所有响应都包含以下元信息，由 eruoo/server 生成或明确映射，不能信任上游同名头：

| 头 | 含义 |
| --- | --- |
| `Eruoo-Response-Source: gateway` 或 `upstream` | 表示该响应由代理生成还是来自模型 API |
| `x-request-id` | eruoo/server 自己的请求标识，沿用现有约定 |
| `Eruoo-Upstream-Request-Id` | 上游提供请求标识时映射保留，用于排查模型调用 |

代理自身错误沿用 `application/problem+json` 和现有 Problem 注册表：凭证缺失或失效 401、权限不足 403、超体积 413、错误媒体类型 415、参数不合格 422、限流 429、依赖/上游连接不可用 503、等待超时 504。重复或混合凭证继续返回 400。无需为所有上游错误重建一套错误码。

Hako 应先读取错误来源：上游 401 表示模型 API 的鉴权失败，不能据此清除 Hako 登录状态；上游 429 应展示模型限流并允许用户稍后重试。代理自身 401 才按相应 eruoo 调用凭证处理。

发送响应头之后发生超时、断流或超限时，无法再把已有 200 改成 504。服务端终止流并取消出站读取；不得追加 Problem JSON 污染 SSE，或伪造完成事件。Hako 只有在原生协议报告完整结束、结果也通过校验后，才将识别视为成功；提前断流显示未完成，保留重试入口。[参考：OpenAI 流式响应](https://developers.openai.com/api/docs/guides/streaming-responses)。

## 6. 运行边界与隐私

以下数字为方便评审给出的初值，属于 AI operation 的建议值，不是当前服务或 Cloudflare 平台默认限制。eruoo/server 可按运行时测量提出替代值，并同步客户端契约。

| 项目 | 评审初值与行为 |
| --- | --- |
| 请求体 | 最大 8 MiB，含图片的 Base64 和 JSON 开销；按实际流式读取字节计数，不能只信 Content-Length |
| 响应体 | 最大 4 MiB，包含 SSE 事件；超限取消读取。已经开始下发时按流中断处理 |
| 请求等待 | 从收到请求起最多 180 秒，覆盖上传、鉴权、上游等待和响应读取；不使用普通读取的 5 秒包装器执行整次 AI 请求 |
| 调用频率 | 建议每把 AI Key 5 次/60 秒，上游调用前执行；不把它宣称为全账号并发上限或金额预算 |
| Hako 并发 | 首版交互一次只发起一个识图请求；这不是跨设备或服务端全局并发保证 |
| 自动重试 | 代理不自动重试模型 POST，不自动切换模型；使用 SDK 时也应检查其内置重试 |

客户端取消、连接关闭或达到 deadline 时，应传播取消信号并停止继续读写；已被模型服务接受的请求不保证完全撤销或免于计费。实现必须覆盖响应体读取阶段，不能只对获取响应头设置超时。

等待模型期间不得持有数据库事务、跨请求连接锁或共享的 pending Promise。限流或并发机制是否需要进一步强化，由 eruoo/server 根据自身实现回评；不得使用 Worker 实例内计数并声称它具有全局保证。

代理不持久保存图片、提示词和响应正文，不将其写入数据库、备份、访问日志或响应缓存。可以记录请求标识、Key 的非秘密标识、模型、状态、耗时、请求/响应大小和失败类别；不记录密钥，也不为收集日志而完整缓冲响应。

Hako 的截图请求建议显式使用 `store: false`，不使用需要服务端历史的会话或后台任务流程。`store: false` 用于关闭 Responses 对象的常规保存，不等于提供方零保留承诺；实际提供方的数据处理政策仍需确认。[参考：OpenAI 响应状态与保存](https://developers.openai.com/api/docs/guides/conversation-state)。

## 7. 配置与浏览器接线

### 7.1 上游配置

建议首版只有一组上游配置：API Base URL、提供方 Key、允许使用的模型名集合。首个允许模型为 `gpt-6-astra`；后续模型经实际接口、图片输入和输出格式验证后加入。Hako 请求中选择模型，代理不做别名替换或静默回退。

最小候选是通过现有 Cloudflare 部署配置和 Worker secret 管理上游，避免为本接口另建配置数据库与管理后台。真实密钥不写进 Wrangler 的普通 `vars`、Git 或前端包。[参考：Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

这一候选不取消 Hako 已提出的设置入口要求：若用户要求在 Hako 修改的是上游密钥，需要另行定义受 owner 管理权限保护的配置接口、保存介质及恢复规则；AI 调用 Key 不获得这类管理权限。该事项见 §2。

### 7.2 两种调用位置的接线要求

| 最终选择 | 接线要求 |
| --- | --- |
| Hako 后端调用 | eruoo 访问 Key 留在 Hako 服务端；浏览器通过 Hako 已验证的账号会话调用后端。该后端不能成为匿名转发入口；需要评估额外一跳的成本 |
| 浏览器/PWA 直连 | 明确凭证签发、存储、续期和撤销方式；设置精确 Hako Origin 的 CORS 与预检规则。本人运行时输入的 Key 不等于公开打包，但浏览器脚本可读取的存储仍有风险 |

若选择浏览器直连，建议仅在 AI 路由开放已登记的 Origin、`POST`、`Content-Type` 和所选凭证头；对浏览器暴露 §5.5 的来源与追踪头，以及适用的 `Retry-After`、`API-Key-Expires-At`。使用 `Vary: Origin`，不使用通配 Origin。预检本身不要求 Key，但真正调用必须鉴权；CORS 不能代替权限验证。具体 Origin 来自实际 Hako 部署，本文不预设域名。

浏览器登录若采用授权码流程，应使用 PKCE；它保护授权码交换，不能保护已经被页面恶意脚本读取的凭证。[参考：OAuth 安全最佳实践](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1.1)、[OWASP 浏览器存储](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html)。

## 8. 验收要求

下列是将来实施的验收要求，本次编写 spec 没有执行这些测试。

| 场景 | 应观察到的行为 |
| --- | --- |
| 合法 AI Key + 文字/图片请求 | 上游被调用一次，收到原生参数和提供方鉴权；不会收到 eruoo 凭证 |
| 缺失、错误、到期、撤销、混合载体、仅 status 权限 | 按约定拒绝；上游调用次数为零；旧 Key 不自动获得 AI 权限 |
| 非法 JSON、超体积、媒体类型错误、未准入模型 | 返回对应代理错误；伪造或省略 Content-Length 不能绕过限制 |
| 扩展原生参数与结构化输出 | 合法未知原生字段不被服务端剔除；字段 schema 和模型参数不被静默改写 |
| 上游 JSON、401、429、5xx | 内容、状态、允许的头和来源正确；上游 401 不触发 Hako 退出登录 |
| SSE 分块 | 首个事件在上游完成前到达；多字节字符、跨块事件及原生错误事件内容保持完整 |
| 上游卡住、客户端取消、响应体超限、流提前结束 | 出站请求/读取被取消；没有后台重试、迟到上游调用或伪造完成；客户端识别未完成 |
| 上游 3xx、异常头、指向自身的配置 | 不跟随重定向，不泄漏 Key，不复制 Set-Cookie 或失效的压缩/长度/连接头 |
| 并行 AI 请求及挂起请求 | `/health`、会话与凭证管理仍能按各自规则完成，不被共享 pending 状态阻塞 |
| 浏览器直连（仅选中该方案时） | 合法 Origin 的预检、凭证头、响应元信息可用；未登记 Origin 被拒绝；持有 Key 的实际请求仍需权限校验 |
| 日志和存储 | 不出现截图、提示词、响应正文或明文 Key；不会为 AI 代理新增内容备份 |
| 配置变更和回退 | 新请求使用新配置；在途请求按开始时选定的配置完成或失败；撤销 AI Key 或回退 AI 路由不会改写加油数据或破坏已有认证 |

实现前可用本地模拟上游验证协议、取消、超限、限流和流式行为。实际提供方的图片识别、凭证权限、延迟和费用需要后续真实联调，文档能力不等于账户已可用。

eruoo/server 当前有 `test`、`test:client`、`test:scripts`、`openapi:check`、`test:e2e` 和完整 `check` 脚本；实施后按改动范围运行相关测试及仓库要求的完整检查。建议将 AI 路由测试放入现有 Worker 测试体系，并让 OpenAPI 同时描述原生 JSON/SSE 上游响应与本地 Problem 错误。

## 9. 请 eruoo/server 返回的评审结论

请按“接受 / 建议调整 / 不适合纳入”给出结论，并重点回答：

1. **职责与接口**：是否接受现有 Worker 内的原生 Responses 转发，以及 `/api/ai/responses` 路径？如调整，给出替代契约。
2. **凭证**：如何最小化扩展现有 API Key 签发和权限，保持现有 Key 不提权？对于 Hako PWA，建议直连还是后端调用，理由是什么？
3. **响应与运行边界**：是否接受来源头、上游错误透传、流中断语义及 §6 的建议初值？是否有明确需要的并发或成本限制？
4. **配置与维护成本**：单上游、部署配置和 Worker secret 是否足够？Hako 设置入口的最终含义由用户确认后，有哪些额外改动？
5. **实施影响**：列出路由、权限、配置、OpenAPI、测试及运维文档的最小改动范围，说明是否需要迁移或新 Cloudflare 资源。

预计接线可能涉及超过 8 个文件，但目标仍是一个功能模块，复用现有构建、认证、错误和测试设施。现有服务已经正式使用，不能沿用历史“首次启用可清空数据库”的条款来删除现有数据或凭证。

本稿暂缓前用于两边评审接口，未据此修改 eruoo/server 或发起模型调用、发布、部署。本稿不再作为当前评审任务；恢复后的识图需求与接入进展以[重新设计记录](./redesign.md#ai-截图识别)为准。
