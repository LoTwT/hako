# Hako 架构补充调研与验证安排

核查日期：2026-09-23  
状态：官方资料与指定源码核查完成；合入后已开始[本地最小验证](../local-validation.md)。本机原图尺寸、真实模型调用、Cloudflare 运行和 iPhone 真机行为尚未验证。

产品选择由[重新设计记录](./redesign.md)维护；会话参数、图片处理和平台额度分别以[登录规格](./eruoo-login-integration.md#61-本应用会话与-owner-配置)、[识图规格](./ai-refueling-recognition.md#51-选择与准备图片)、[整体方案](./architecture-proposal.md#9-免费额度与实际费用)为准。本文记录调研依据和如何验证，不重复定义这些参数。

## 1. 本轮结论

| 问题 | 结论 | 尚不能由资料证明的内容 |
| --- | --- | --- |
| 自有设备长期保持登录 | 使用后端可撤销的持久会话，随正常前台使用续期；已提出有效期、续期间隔和绝对上限 | iPhone 的 Cookie 实际保存、外部授权是否顺利返回原 PWA |
| 易捷详情识图 | 保留合规原图，仅超出传输上限时压缩；沿用固定 DeepSeek 与人工核对 | 非推理模式对真实数字的准确率、压缩后的可读性、耗时与实际费用 |
| 免费托管 | 公开额度允许继续按 Free 设计，尚无资料依据要求立即升级套餐 | 当前账号剩余额度、实际构建与入口 CPU 是否满足限制 |
| Worker 间调用 | 先验证现有 HTTPS 接线；同账号 HTTP Service Binding 是必要时可比较的官方路径 | eruoo 控制台实际域名接线、目标部署版本和专用 Key 的可用性 |

## 2. iPhone 与长期登录

- [Chrome 的 iPhone 帮助](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DiOS&hl=en)明确提供分享菜单中的添加主屏幕入口；实际打开 Web App 还是浏览器快捷方式取决于网站。首次安装不能只以“出现图标”作为 PWA 验收通过。
- [WebKit 跟踪防护](https://webkit.org/tracking-prevention/#intelligent-tracking-prevention-itp)说明主屏幕应用的数据与 Safari 隔离，并对其第一方域名豁免脚本存储的 7 天清理规则。此项不是对所有浏览器共享 Cookie、自动登录返回或数据永久保留的承诺。
- [WebKit 存储策略](https://webkit.org/blog/14403/updates-to-storage-policy/)说明持久存储申请依赖启发式判断，Cookie 不属于该文的存储配额范围。会话保持和 IndexedDB 数据恢复要分别验收。
- [Better Auth](https://better-auth.com/docs/concepts/session-management)提供使用期间延长会话到期时间的成熟机制；Hako 参考这种行为，保留独立 OIDC 调用方职责，不因调研而新增整套身份框架。
- [Chrome Cookie 期限说明](https://developer.chrome.com/blog/cookie-max-age-expires/)说明有限期限 Cookie 可在后续访问时更新，也可能提前被清除。这是 Chromium 的实现证据，不能直接充当 iPhone Chrome 所用环境的实测结果。

推荐机制及具体参数已经写入登录规格。低频使用与较长会话之间的取舍由本项目提出；来源并未推荐 Hako 的具体天数。验收需记录用户设备的实际系统小版本、Chrome 版本和默认浏览器，分别从 Chrome 页面及主屏幕应用发起登录。

## 3. 图片协议、清晰度与费用

本轮重新读取 eruoo 的 `4e4ccff5ac77df834997fe04ac3ba8c2ff92f78e` 提交中的[请求校验](https://github.com/eruoo/server/blob/4e4ccff5ac77df834997fe04ac3ba8c2ff92f78e/src/worker/ai/responses-request.ts)：允许 PNG/JPEG/WebP 内联图片、`none` 推理参数和 `json_schema`，输入图片只允许在 user 消息中。Hako 保留合规原图符合该源码合同。

[DeepSeek Vision](https://api-docs.deepseek.com/guides/vision/)说明图片 token 取决于尺寸，推理前会进行尺寸调整，当前每张图最多计 1024 个图片 token。相同尺寸转 JPEG 主要影响上传体积，不应据此宣称减少识图 token。官方允许的部分能力（例如 GIF、远程 URL 和 detail 参数）不在已核查的 eruoo 请求子集内，Hako 不发送这些参数。

[Responses API](https://api-docs.deepseek.com/api/create-response/)分别支持图片、非推理模式、结构化输出和非流式响应；响应仍可能是 incomplete。协议支持不等于“真实易捷截图加指定 schema”已通过验收。先保留单次调用、用户核对及失败后手动重试，用样本结果决定是否调整推理和输出限制。

[DeepSeek 当前计费](https://api-docs.deepseek.com/quick_start/pricing/)按输入、输出 token 计算。PNG 转 JPEG 不能替代费用核对；实测从 eruoo 现有 usage 记录核对输入、缓存命中、输出和对应时段价格，单次费用再乘本人实际使用次数。此次没有真实 usage，不给出每月固定费用承诺。

原会话已查看过的截图可作为字段预期，但本轮读取时其临时文件路径已经不存在，无法测量原文件字节、尺寸或做同图处理比较。本次没有重新编码、上传或调用模型；实测时需要一张可访问的易捷截图。

## 4. Cloudflare 与接线

[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)和[定价](https://developers.cloudflare.com/workers/platform/pricing/)复核后，仍须重点验证入口的鉴权、JSON 解析与序列化开销。网络等待不等于 CPU 时间。当前包体限制已经改变，不能按旧的压缩体积上限推断 Loro 无法部署；实际产物、全局初始化及运行性能都需测量，额度数值只在整体方案维护。

[SQLite Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)可用于 Free，存储还有[单对象与账号上限](https://developers.cloudflare.com/durable-objects/platform/limits/)之分；[R2 免费额度](https://developers.cloudflare.com/r2/pricing/)适用于 Standard。个人记录量小有利于费用控制，但不能代替账号实际配额和调用时长检查。

核查的 eruoo [Wrangler 配置](https://github.com/eruoo/server/blob/4e4ccff5ac77df834997fe04ac3ba8c2ff92f78e/wrangler.jsonc)声明了正式 APP_ORIGIN，未声明 routes/custom_domain；这不证明控制台缺少配置。[普通 Route 不能作为同 zone fetch 目标](https://developers.cloudflare.com/workers/configuration/routing/routes/)，[Service Binding 要求目标 Worker 在同一账号](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)。先确认实际环境，随后只实现一种接线，避免为假设中的限制增加两套调用逻辑。

这一验证同时覆盖 OIDC 的 discovery、JWKS、token 和 UserInfo。`oauth4webapi` 的 [customFetch](https://github.com/panva/oauth4webapi/blob/main/docs/variables/customFetch.md) 提供可替换的 HTTP 发送入口，因此存在使用同账号绑定的适配路径；这是接口能力上的推断，尚未证明实际绑定与协议响应兼容。不能只把 AI 请求改通就宣布登录链路通过，浏览器授权仍使用公开 HTTPS 地址。

证据边界：本轮本地 eruoo 检出仍是 `339abbb`，上述 DeepSeek 合同通过读取 `4e4ccff` Git 对象核查，不代表检出状态、最新远端提交或线上部署。此前同日未认证请求出现本机 Cloudflare 1010，继续作为未验证链路的记录，不将其认定为 Hako Worker 的实际调用故障。本轮没有重复进行相同探测或尝试绕过访问控制。

## 5. 下一步最小验证

下表保留合入前的验证安排。文档 PR 合并后已开始第 1 项，实际完成范围与结果见[本地最小验证进展](../local-validation.md)；未创建云资源或执行付费调用。

| 顺序 | 验证内容 | 可审阅结果与通过条件 |
| --- | --- | --- |
| 1. 本地最小验证 | Hako 实施方准备一页表单、Loro/IndexedDB 保存及两个浏览器上下文；使用合成记录 | 保存后重开可读；并发修改合并正确；写入失败保留输入；会话边界可用测试时钟验证 |
| 2. Cloudflare 运行 | 实施方先做本地构建与 dry-run，再在实际目标套餐的验证环境测试入口、DO、R2；AI 用受控假响应 | 记录完整包体、启动时间、入口 CPU、DO 资源和备份体积；最大允许 payload 能通过；不把桌面运行时间当成云端 CPU |
| 3. iPhone 真机 | 用户在自己的设备操作测试页面，实施方核对登录回调与结果；Chrome/PWA 分别测试 | 登录返回正确环境；关闭重开与离线保存正常；已同步记录在清理后可恢复；记录 storage.persist 授权结果 |
| 4. 真实识图 | 实施方从已验证的 Hako Worker 接线，用专用应用 Key 与少量本人提供的易捷详情截图测试 | 每张对照日期、升数、三个金额和其他可见字段，记录准确项/错误项、耗时及 usage；不同格式页面不能预填；发现误读时先归因清晰度或提取规则 |

第 4 项先验证一张清晰详情图的组合合同，再补充同格式的优惠、零实付和可读性边界案例。合成图片用于合同与错误路径，不能替代真实样本准确率；少量样本全部正确也不能宣称稳定准确率已被统计证明。

真实调用前，测试截图、目标环境、模型目录与专用 Key 权限需要就绪，并给出具体调用数量及费用估算；这些准备完成后再处理有费用的执行。截图只在该次验证中临时使用，报告保留校验结论和用量，不把真实订单图片提交进仓库或业务备份。费用、域名接线或兼容性结果如果要求改变用户已确认的使用方式，再给出具体取舍。

验证通过后整理整体方案与实施清单供审阅，正式实现依据已确认的范围推进。验证失败先修改对应设计并复测；手填、已有数据与可恢复性要求保持为通过条件，不能靠省略失败项宣布完成。

## 6. 合入前审查

2026-09-23，按用户要求审查当前 Vue/Tauri 骨架、当前设计及引用关系，并准备先合入文档，再开始第 5 节的本地最小验证。

- 修正识图请求仍限定 JPEG 的旧文字，使其与原图优先的 PNG/JPEG/WebP 规则一致；否则按请求章节实现会拒绝合法原图。
- 给三份旧规格直接标注历史状态，避免从文件直达时误用原生客户端、自建身份和旧统计规则；保留正文用于追溯。
- 将历史 AI 提案中的本机绝对源码链接改为对应 eruoo 提交的仓库链接，供 PR 读者访问。
- 当前骨架的 `pnpm run build` 通过，包含 `vue-tsc --noEmit`；11 份文档的 119 个本地链接及锚点、代码围栏与空白检查通过。

修正后未发现阻塞这批设计文档合入的问题。此结论只覆盖文档一致性与现有骨架构建；第 5 节的运行、存储故障、Cloudflare、iPhone 和真实识图验收仍未执行。旧规格的内部实现要求不作为本轮发布门禁，也不因随本次 PR 归档而重新采用。
