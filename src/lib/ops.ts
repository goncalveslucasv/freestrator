// Document operations. They mutate an immer draft and are meant to run inside commit()/liveFromBase().

import { cloneNode, newId, nodeBBox, nodesBBox, transformNode, type BBox } from "./geometry";
import { inv, translate, type Mat } from "./matrix";
import type { Doc, GroupNode, PathNode, SceneNode } from "./types";

export interface Loc {
  node: SceneNode;
  parent: GroupNode | null;
  list: SceneNode[];
  index: number;
  /** Ancestors from the top layer down to the parent. */
  path: GroupNode[];
}

export function locate(doc: Doc, id: string): Loc | null {
  const visit = (list: SceneNode[], parent: GroupNode | null, path: GroupNode[]): Loc | null => {
    for (let index = 0; index < list.length; index++) {
      const node = list[index];
      if (node.id === id) return { node, parent, list, index, path };
      if (node.type === "group") {
        const found = visit(node.children, node, [...path, node]);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(doc.layers, null, []);
}

export const getNodes = (doc: Doc, ids: string[]) =>
  ids.map((id) => locate(doc, id)?.node).filter((n): n is SceneNode => !!n);

/**
 * Resolves what a click on `id` selects:
 * - "top": the outermost object inside the artboard sub-layer (or inside the isolated group);
 * - "leaf": the clicked element itself.
 */
export function resolveSelectable(doc: Doc, id: string, mode: "top" | "leaf", isolation: string | null): string | null {
  const loc = locate(doc, id);
  if (!loc) return null;
  if (loc.node.type === "group" && loc.node.role) return null;
  const chain = [...loc.path, loc.node];
  if (chain.some((n) => n.locked || !n.visible)) return null;
  if (mode === "leaf") return id;
  let start = 0;
  const iso = isolation ? chain.findIndex((n) => n.id === isolation) : -1;
  if (iso >= 0) start = iso + 1;
  else {
    for (let i = 0; i < chain.length; i++) if (chain[i].type === "group" && (chain[i] as GroupNode).role) start = i + 1;
  }
  return chain[start]?.id ?? id;
}

/** Drops ids whose ancestor is also selected (so transforms aren't applied twice). */
export function topmostIds(doc: Doc, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    const loc = locate(doc, id);
    return loc && !loc.path.some((p) => set.has(p.id));
  });
}

export function transformNodes(doc: Doc, ids: string[], D: Mat) {
  for (const id of topmostIds(doc, ids)) {
    const loc = locate(doc, id);
    if (loc) transformNode(loc.node, D);
  }
}

export function deleteNodes(doc: Doc, ids: string[]) {
  for (const id of ids) {
    const loc = locate(doc, id);
    if (!loc || (loc.node.type === "group" && loc.node.role)) continue;
    loc.list.splice(loc.index, 1);
  }
}

export function duplicateNodes(doc: Doc, ids: string[], offset: [number, number] = [0, 0]): string[] {
  const out: string[] = [];
  for (const id of topmostIds(doc, ids)) {
    const loc = locate(doc, id);
    if (!loc || (loc.node.type === "group" && loc.node.role)) continue;
    const copy = cloneNode(loc.node as SceneNode);
    if (offset[0] || offset[1]) transformNode(copy, translate(offset[0], offset[1]));
    loc.list.splice(loc.index + 1, 0, copy);
    out.push(copy.id);
  }
  return out;
}

/** Sorts ids by paint order (bottom first). */
export function sortByZ(doc: Doc, ids: string[]): string[] {
  const order = new Map<string, number>();
  let i = 0;
  const visit = (list: SceneNode[]) => {
    for (const n of list) {
      order.set(n.id, i++);
      if (n.type === "group") visit(n.children);
    }
  };
  visit(doc.layers);
  return [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

export function groupNodes(doc: Doc, ids: string[], extra: Partial<GroupNode> = {}): string | null {
  const sorted = sortByZ(doc, topmostIds(doc, ids)).filter((id) => {
    const n = locate(doc, id)?.node;
    return n && !(n.type === "group" && n.role);
  });
  if (!sorted.length) return null;
  const top = locate(doc, sorted.at(-1)!)!;
  const targetList = top.list;
  const nodes: SceneNode[] = [];
  let insertAt = top.index;
  for (const id of sorted) {
    const loc = locate(doc, id)!;
    if (loc.list === targetList && loc.index < insertAt) insertAt--;
    nodes.push(loc.list.splice(loc.index, 1)[0]);
  }
  const group: GroupNode = {
    id: newId(),
    type: "group",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    children: nodes,
    ...extra,
  };
  targetList.splice(insertAt + 1, 0, group);
  return group.id;
}

export function ungroupNodes(doc: Doc, ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const loc = locate(doc, id);
    // Masked groups can't be dissolved without changing how they look.
    if (!loc || loc.node.type !== "group" || loc.node.role || loc.node.mask) {
      out.push(id);
      continue;
    }
    const g = loc.node;
    for (const c of g.children) {
      c.opacity *= g.opacity;
      if (c.blend === "normal") c.blend = g.blend;
    }
    // Ungrouping a clip group releases the clipping path, like Illustrator.
    const released = g.clip ? [clipToPath(g)] : [];
    loc.list.splice(loc.index, 1, ...g.children, ...released);
    out.push(...g.children.map((c) => c.id), ...released.map((r) => r.id));
  }
  return out;
}

function clipToPath(g: GroupNode): PathNode {
  return {
    id: newId(),
    type: "path",
    name: "<Trazado de recorte>",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    segs: g.clip!.segs,
    m: g.clip!.m,
    fill: null,
    fillOpacity: 1,
    fillRule: g.clip!.rule,
    stroke: null,
    strokeOpacity: 1,
    strokeWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    dash: [],
    dashOffset: 0,
  };
}

/** Illustrator's Object › Clipping Mask › Make: the topmost path clips the rest. */
export function makeClipMask(doc: Doc, ids: string[]): string | null {
  const sorted = sortByZ(doc, topmostIds(doc, ids));
  if (sorted.length < 2) return null;
  const topLoc = locate(doc, sorted.at(-1)!);
  if (!topLoc || topLoc.node.type !== "path") return null;
  const clipPath = topLoc.node;
  const groupId = groupNodes(doc, sorted.slice(0, -1), {
    clip: { segs: clipPath.segs, m: clipPath.m, rule: clipPath.fillRule },
  });
  const loc = locate(doc, clipPath.id);
  if (loc) loc.list.splice(loc.index, 1);
  return groupId;
}

export function releaseClipMask(doc: Doc, ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const loc = locate(doc, id);
    if (!loc || loc.node.type !== "group" || !loc.node.clip) continue;
    const path = clipToPath(loc.node);
    loc.node.clip = undefined;
    loc.list.splice(loc.index + 1, 0, path);
    out.push(id, path.id);
  }
  return out;
}

export type ArrangeMode = "front" | "forward" | "backward" | "back";
export function arrange(doc: Doc, ids: string[], mode: ArrangeMode) {
  const sorted = sortByZ(doc, topmostIds(doc, ids));
  const ordered = mode === "front" || mode === "forward" ? [...sorted].reverse() : sorted;
  for (const id of ordered) {
    const loc = locate(doc, id);
    if (!loc) continue;
    const [node] = loc.list.splice(loc.index, 1);
    let to = loc.index;
    if (mode === "front") to = loc.list.length;
    else if (mode === "back") to = 0;
    else if (mode === "forward") to = Math.min(loc.list.length, loc.index + 1);
    else to = Math.max(0, loc.index - 1);
    loc.list.splice(to, 0, node);
  }
}

export function ensureSublayer(doc: Doc, layerId: string | null, artboard: number): GroupNode {
  let layer = doc.layers.find((l) => l.id === layerId) ?? doc.layers.at(-1);
  if (!layer) {
    layer = { id: newId(), type: "group", role: "layer", name: "Capa 1", visible: true, locked: false, opacity: 1, blend: "normal", children: [], expanded: true };
    doc.layers.push(layer);
  }
  let sub = layer.children.find((c): c is GroupNode => c.type === "group" && c.role === "artboard" && c.artboard === artboard);
  if (!sub) {
    sub = {
      id: newId(),
      type: "group",
      role: "artboard",
      artboard,
      name: doc.artboards[artboard]?.name ?? `Mesa de trabajo ${artboard + 1}`,
      visible: true,
      locked: false,
      opacity: 1,
      blend: "normal",
      children: [],
      expanded: true,
    };
    layer.children.push(sub);
  }
  return sub;
}

export function insertNode(doc: Doc, node: SceneNode, layerId: string | null, artboard: number, isolation: string | null) {
  const iso = isolation ? locate(doc, isolation)?.node : null;
  if (iso && iso.type === "group") iso.children.push(node);
  else ensureSublayer(doc, layerId, artboard).children.push(node);
}

export function artboardAt(doc: Doc, x: number, y: number, fallback = 0): number {
  const i = doc.artboards.findIndex((a) => x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height);
  return i >= 0 ? i : fallback;
}

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export function alignNodes(doc: Doc, ids: string[], mode: AlignMode, ref: BBox) {
  for (const id of topmostIds(doc, ids)) {
    const loc = locate(doc, id);
    if (!loc) continue;
    const b = nodeBBox(loc.node);
    if (!b) continue;
    let dx = 0,
      dy = 0;
    if (mode === "left") dx = ref.x - b.x;
    else if (mode === "hcenter") dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
    else if (mode === "right") dx = ref.x + ref.w - (b.x + b.w);
    else if (mode === "top") dy = ref.y - b.y;
    else if (mode === "vcenter") dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
    else dy = ref.y + ref.h - (b.y + b.h);
    transformNode(loc.node, translate(dx, dy));
  }
}

export function selectionBBox(doc: Doc, ids: string[]): BBox | null {
  return nodesBBox(getNodes(doc, topmostIds(doc, ids)));
}

/** Maps a document-space delta into a node's local space. */
export function toLocalDelta(m: Mat, dx: number, dy: number): [number, number] {
  const li = inv([m[0], m[1], m[2], m[3], 0, 0]);
  return [li[0] * dx + li[2] * dy, li[1] * dx + li[3] * dy];
}

/**
 * Moves a node next to (or inside) another one. Positions are in panel terms: "above" paints over the
 * target, "below" under it, "inside" makes it the top child of a group.
 */
export function moveNode(doc: Doc, id: string, targetId: string, position: "above" | "below" | "inside") {
  if (id === targetId) return;
  const target = locate(doc, targetId);
  const src = locate(doc, id);
  if (!src || !target) return;
  // Can't move a node into its own subtree.
  if (target.path.some((p) => p.id === id)) return;
  const isLayer = (n: SceneNode) => n.type === "group" && n.role === "layer";
  if (isLayer(src.node) !== (position === "inside" ? false : isLayer(target.node))) return;
  const [node] = src.list.splice(src.index, 1);
  if (position === "inside" && target.node.type === "group") {
    target.node.children.push(node);
    return;
  }
  const after = locate(doc, targetId)!;
  after.list.splice(position === "above" ? after.index + 1 : after.index, 0, node);
}
