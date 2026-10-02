// Hako 同源 Worker 入口。非 API 请求由静态资产承载，本 Worker 在当前路由约定下
// 只会收到 /api 与 /api/*；保留静态资产后备以防路由配置漂移。
// Env 与 ExportedHandler 来自 .cloudflare/types 生成的全局类型（Worker 专用 tsconfig）。

import { handleApiRequest, isApiPath } from "./api";

export { HakoAccountDurableObject } from "./account-durable-object";

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (isApiPath(pathname)) {
      return handleApiRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
