// 有限 hash 地址（UI/UX 设计 §3.2）纯逻辑测试：地址只承载页面身份；未知加油
// 子路径回记录根页、其他未知地址回首页；记录 ID 只接受受限字符；编辑器路由
// 按挂起目标（新建/编辑）生成。不冒充真实浏览器。

import { describe, expect, it } from "vitest";
import {
  editorRouteFor,
  isEditorRoute,
  parseAppRoute,
  refuelingRouteHref,
  routeHref,
  routeKey,
  type AppRoute,
} from "../src/ui/app-route";

describe("parseAppRoute", () => {
  it("空地址与未知地址回首页；#login/#settings 是独立固定地址", () => {
    expect(parseAppRoute("")).toEqual({ name: "home" });
    expect(parseAppRoute("#")).toEqual({ name: "home" });
    expect(parseAppRoute("#/")).toEqual({ name: "home" });
    expect(parseAppRoute("#unknown")).toEqual({ name: "home" });
    expect(parseAppRoute("#login")).toEqual({ name: "login" });
    expect(parseAppRoute("#settings")).toEqual({ name: "settings" });
  });

  it("加油根页与固定子路径", () => {
    expect(parseAppRoute("#refueling")).toEqual({ name: "refueling", refueling: { name: "records" } });
    expect(parseAppRoute("#refueling/")).toEqual({ name: "refueling", refueling: { name: "records" } });
    expect(parseAppRoute("#refueling/new")).toEqual({ name: "refueling", refueling: { name: "record-new" } });
    expect(parseAppRoute("#refueling/statistics")).toEqual({ name: "refueling", refueling: { name: "statistics" } });
    expect(parseAppRoute("#refueling/data")).toEqual({ name: "refueling", refueling: { name: "data" } });
    expect(parseAppRoute("#refueling/data/backups")).toEqual({ name: "refueling", refueling: { name: "data-backups" } });
    expect(parseAppRoute("#refueling/data/backups/preview")).toEqual({ name: "refueling", refueling: { name: "data-backup-preview" } });
    expect(parseAppRoute("#refueling/data/restore")).toEqual({ name: "refueling", refueling: { name: "data-restore-result" } });
    expect(parseAppRoute("#refueling/data/retained")).toEqual({ name: "refueling", refueling: { name: "data-retained" } });
    expect(parseAppRoute("#refueling/data/legacy-import")).toEqual({ name: "refueling", refueling: { name: "data-legacy-import" } });
  });

  it("记录详情与编辑按记录 ID 解析", () => {
    expect(parseAppRoute("#refueling/records/one")).toEqual({ name: "refueling", refueling: { name: "record-detail", recordId: "one" } });
    expect(parseAppRoute("#refueling/records/one/edit")).toEqual({ name: "refueling", refueling: { name: "record-edit", recordId: "one" } });
  });

  it("未知加油子路径回记录根页；非法记录 ID 不进入详情/编辑", () => {
    expect(parseAppRoute("#refueling/unknown")).toEqual({ name: "refueling", refueling: { name: "records" } });
    expect(parseAppRoute("#refueling/data/unknown")).toEqual({ name: "refueling", refueling: { name: "data" } });
    expect(parseAppRoute("#refueling/records/../../secret")).toEqual({ name: "refueling", refueling: { name: "records" } });
    expect(parseAppRoute("#refueling/records/" + "a".repeat(65))).toEqual({ name: "refueling", refueling: { name: "records" } });
    expect(parseAppRoute("#refueling/records/a%20b")).toEqual({ name: "refueling", refueling: { name: "records" } });
  });

  it("routeHref 与解析互逆；routeKey 区分不同页面", () => {
    const routes: AppRoute[] = [
      { name: "home" },
      { name: "login" },
      { name: "settings" },
      { name: "refueling", refueling: { name: "records" } },
      { name: "refueling", refueling: { name: "record-new" } },
      { name: "refueling", refueling: { name: "record-detail", recordId: "one" } },
      { name: "refueling", refueling: { name: "record-edit", recordId: "one" } },
      { name: "refueling", refueling: { name: "statistics" } },
      { name: "refueling", refueling: { name: "data" } },
      { name: "refueling", refueling: { name: "data-backups" } },
      { name: "refueling", refueling: { name: "data-backup-preview" } },
      { name: "refueling", refueling: { name: "data-restore-result" } },
      { name: "refueling", refueling: { name: "data-retained" } },
      { name: "refueling", refueling: { name: "data-legacy-import" } },
    ];
    for (const route of routes) {
      expect(parseAppRoute(routeHref(route).replace(/^\/?#?/, route.name === "home" ? "#" : "#"))).toEqual(route);
      expect(routeKey(route)).toBe(routeHref(route));
    }
    expect(refuelingRouteHref({ name: "record-edit", recordId: "a b" })).toBe("/#refueling/records/a%20b/edit");
  });
});

describe("编辑器路由", () => {
  it("新建与编辑对应固定地址；isEditorRoute 只认编辑器路由", () => {
    expect(editorRouteFor("create", "ignored")).toEqual({ name: "refueling", refueling: { name: "record-new" } });
    expect(editorRouteFor("edit", "one")).toEqual({ name: "refueling", refueling: { name: "record-edit", recordId: "one" } });
    expect(isEditorRoute({ name: "refueling", refueling: { name: "record-new" } })).toBe(true);
    expect(isEditorRoute({ name: "refueling", refueling: { name: "record-edit", recordId: "one" } })).toBe(true);
    expect(isEditorRoute({ name: "refueling", refueling: { name: "records" } })).toBe(false);
    expect(isEditorRoute({ name: "home" })).toBe(false);
  });
});
