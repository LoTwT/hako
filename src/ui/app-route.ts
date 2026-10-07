import { shallowRef } from "vue";

/**
 * 有限 hash 地址（UI/UX 设计 §3.2）：浏览器地址只承载页面身份，不承载表单值、
 * 草稿 ID、previewId 或 requestId。未知加油子路径回记录根页；其他未知地址回
 * 首页；`#login` 与 `#settings` 是独立固定地址。认证回调与返回类别仍只有
 * home / refueling 两个粗类别（见 App 的 loginReturnPageKey）。
 */
export type RefuelingRoute =
  | { name: "records" }
  | { name: "record-detail"; recordId: string }
  | { name: "record-new" }
  | { name: "record-edit"; recordId: string }
  | { name: "statistics" }
  | { name: "data" }
  | { name: "data-backups" }
  | { name: "data-backup-preview" }
  | { name: "data-restore-result" }
  | { name: "data-retained" }
  | { name: "data-legacy-import" };

export type AppRoute =
  | { name: "home" }
  | { name: "login" }
  | { name: "settings" }
  | { name: "refueling"; refueling: RefuelingRoute };

export const recordsRoute: AppRoute = { name: "refueling", refueling: { name: "records" } };

/** 记录 ID 只接受受限字符与长度；是否属于当前账号由工作区按记录解析。 */
function validRecordId(segment: string): boolean {
  return segment.length > 0 && segment.length <= 64 && /^[A-Za-z0-9_-]+$/.test(segment);
}

function parseRefuelingRoute(path: string): RefuelingRoute {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return { name: "records" };
  const [head, second, third, fourth] = segments;
  if (head === "new" && segments.length === 1) return { name: "record-new" };
  if (head === "records" && second !== undefined && validRecordId(second)) {
    if (segments.length === 2) return { name: "record-detail", recordId: second };
    if (segments.length === 3 && third === "edit") return { name: "record-edit", recordId: second };
    return { name: "records" };
  }
  if (head === "statistics" && segments.length === 1) return { name: "statistics" };
  if (head === "data") {
    if (segments.length === 1) return { name: "data" };
    if (second === "backups" && segments.length === 2) return { name: "data-backups" };
    if (second === "backups" && third === "preview" && segments.length === 3) return { name: "data-backup-preview" };
    if (second === "restore" && segments.length === 2) return { name: "data-restore-result" };
    if (second === "retained" && segments.length === 2) return { name: "data-retained" };
    if (second === "legacy-import" && segments.length === 2) return { name: "data-legacy-import" };
    return { name: "data" };
  }
  void fourth;
  return { name: "records" };
}

export function parseAppRoute(hash: string): AppRoute {
  const raw = hash.replace(/^#\/?/, "");
  if (raw === "" ) return { name: "home" };
  if (raw === "login") return { name: "login" };
  if (raw === "settings") return { name: "settings" };
  if (raw === "refueling" || raw.startsWith("refueling/")) {
    return { name: "refueling", refueling: parseRefuelingRoute(raw.slice("refueling".length)) };
  }
  return { name: "home" };
}

export function refuelingRouteHref(refueling: RefuelingRoute): string {
  const base = "/#refueling";
  switch (refueling.name) {
    case "records": return base;
    case "record-new": return `${base}/new`;
    case "record-detail": return `${base}/records/${encodeURIComponent(refueling.recordId)}`;
    case "record-edit": return `${base}/records/${encodeURIComponent(refueling.recordId)}/edit`;
    case "statistics": return `${base}/statistics`;
    case "data": return `${base}/data`;
    case "data-backups": return `${base}/data/backups`;
    case "data-backup-preview": return `${base}/data/backups/preview`;
    case "data-restore-result": return `${base}/data/restore`;
    case "data-retained": return `${base}/data/retained`;
    case "data-legacy-import": return `${base}/data/legacy-import`;
  }
}

export function routeHref(route: AppRoute): string {
  switch (route.name) {
    case "home": return "/";
    case "login": return "/#login";
    case "settings": return "/#settings";
    case "refueling": return refuelingRouteHref(route.refueling);
  }
}

export function routeKey(route: AppRoute): string {
  return routeHref(route);
}

export function isEditorRoute(route: AppRoute): boolean {
  return route.name === "refueling"
    && (route.refueling.name === "record-new" || route.refueling.name === "record-edit");
}

/** 编辑器路由对应的挂起目标（新建无记录 ID）。 */
export function editorRouteFor(mode: "create" | "edit", recordId: string): { name: "refueling"; refueling: Extract<RefuelingRoute, { name: "record-new" }> | Extract<RefuelingRoute, { name: "record-edit" }> } {
  return mode === "create"
    ? { name: "refueling", refueling: { name: "record-new" } }
    : { name: "refueling", refueling: { name: "record-edit", recordId } };
}

/**
 * 路由状态（单例由 App 创建后向工作区传递）：App 统一持有 popstate/hashchange
 * 与历史写入，工作区只读路由并发起导航请求，保证离开编辑器的落盘保护先于
 * 地址变化执行。
 */
export function createAppRouter(initialHash: string) {
  const route = shallowRef<AppRoute>(parseAppRoute(initialHash));
  /** 本文档内由应用压入的历史层数：用于判断「返回」是否可走 history.back。 */
  let pushedEntries = 0;

  function push(next: AppRoute): void {
    if (routeKey(next) === routeKey(route.value)) return;
    window.history.pushState({ hako: true }, "", routeHref(next));
    pushedEntries += 1;
    route.value = next;
  }

  function replace(next: AppRoute): void {
    window.history.replaceState({ hako: true }, "", routeHref(next));
    route.value = next;
  }

  /** 应用内返回：有自己的压入层时走 history.back，否则替换到回退目标。 */
  function backOrReplace(fallback: AppRoute): void {
    if (pushedEntries > 0) {
      pushedEntries -= 1;
      window.history.back();
      return;
    }
    replace(fallback);
  }

  /** 浏览器发起的前进/后退：按当前地址重算路由。 */
  function syncFromLocation(): void {
    const next = parseAppRoute(window.location.hash);
    if (routeKey(next) !== routeKey(route.value)) route.value = next;
    else route.value = next;
  }

  return { route, push, replace, backOrReplace, syncFromLocation };
}
