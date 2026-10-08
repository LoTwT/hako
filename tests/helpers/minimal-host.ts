import { createRenderer } from "vue";

/**
 * 忠实最小宿主（组件测试共享）：维护父子与兄弟关系的假 DOM。Vue 卸载
 * fragment 时按 nextSibling 沿兄弟链走到锚点收敛（removeFragment 的 while
 * 循环），no-op 宿主（remove/nextSibling 恒空）会无限循环，必须真实记账。
 * 元素带 style 供 v-show 使用；文本/注释/父指针/兄弟指针按 Vue 期望实现。
 */
export interface MinimalHostNode {
  kind: "root" | "element" | "text" | "comment" | "static";
  tag: string | null;
  text: string | null;
  props: Record<string, unknown>;
  children: MinimalHostNode[];
  parent: MinimalHostNode | null;
  style: Record<string, string>;
  /** 焦点调用计数：组件以 heading.focus()/button.focus() 转移键盘焦点。 */
  focusCount: number;
  focus: (options?: { preventScroll?: boolean }) => void;
  /** 事件监听 no-op：v-model 等运行时指令在挂载时注册监听（本宿主不派发事件）。 */
  addEventListener: (type: string, listener: unknown, options?: unknown) => void;
  removeEventListener: (type: string, listener: unknown, options?: unknown) => void;
}

export function createMinimalHostNode(
  kind: MinimalHostNode["kind"],
  tag: string | null,
  text: string | null,
): MinimalHostNode {
  const node: MinimalHostNode = {
    kind, tag, text, props: {}, children: [], parent: null, style: {}, focusCount: 0,
    focus: () => { node.focusCount += 1; },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return node;
}

/** 挂载根节点（应用测试直接构造时使用）。 */
export function createMinimalHostRoot(): MinimalHostNode {
  return createMinimalHostNode("root", null, null);
}

function childListOf(node: MinimalHostNode): MinimalHostNode[] {
  if (!Array.isArray(node.children)) node.children = [];
  return node.children;
}

function detach(node: MinimalHostNode): void {
  const parent = node.parent;
  if (parent === null) return;
  const siblings = childListOf(parent);
  const index = siblings.indexOf(node);
  if (index >= 0) siblings.splice(index, 1);
  node.parent = null;
}

function insertBefore(child: MinimalHostNode, parent: MinimalHostNode, anchor: MinimalHostNode | null): void {
  detach(child);
  const siblings = childListOf(parent);
  const index = anchor === null ? -1 : siblings.indexOf(anchor);
  siblings.splice(index < 0 ? siblings.length : index, 0, child);
  child.parent = parent;
}

/** 可选的行为记录：测试自定关注点（如焦点、属性断言）。 */
export interface MinimalHostOptions {
  onPropPatch?: (node: MinimalHostNode, key: string, value: unknown) => void;
}

export function createMinimalHostRenderer(options: MinimalHostOptions = {}) {
  return createRenderer<MinimalHostNode, MinimalHostNode>({
    patchProp(node, key, _previous, next) {
      node.props[key] = next;
      options.onPropPatch?.(node, key, next);
    },
    insert(child, parent, anchor = null) {
      insertBefore(child, parent, anchor);
    },
    remove(child) {
      detach(child);
    },
    createElement(tag) {
      return createMinimalHostNode("element", tag, null);
    },
    createText(text) {
      return createMinimalHostNode("text", null, text);
    },
    createComment(text) {
      return createMinimalHostNode("comment", null, text);
    },
    insertStaticContent(content, parent, anchor = null) {
      const node = createMinimalHostNode("static", "#static", String(content));
      insertBefore(node, parent, anchor);
      return [node, node];
    },
    setText(node, text) {
      node.text = text;
    },
    setElementText(node, text) {
      for (const child of childListOf(node)) child.parent = null;
      node.children = [];
      node.text = text;
    },
    parentNode(node) {
      return node.parent;
    },
    nextSibling(node) {
      const parent = node.parent;
      if (parent === null) return null;
      const siblings = childListOf(parent);
      const index = siblings.indexOf(node);
      return index >= 0 && index + 1 < siblings.length ? siblings[index + 1]! : null;
    },
  });
}
