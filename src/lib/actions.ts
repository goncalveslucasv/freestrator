"use client";

// High level editor commands, shared by menus, keyboard shortcuts and panels.

import { cloneNode, nodeBBox, transformNode } from "./geometry";
import { emptyDoc, importAiFile } from "./importer";
import { about, rotate, scale, translate } from "./matrix";
import {
  alignNodes,
  arrange,
  deleteNodes,
  duplicateNodes,
  getNodes,
  groupNodes,
  insertNode,
  locate,
  makeClipMask,
  releaseClipMask,
  selectionBBox,
  topmostIds,
  ungroupNodes,
  type AlignMode,
  type ArrangeMode,
} from "./ops";
import { commit, loadDoc, select, useEditor } from "./store";
import type { Doc, SceneNode } from "./types";
import type { Draft } from "immer";

const state = () => useEditor.getState();

export async function openFile(file: File) {
  useEditor.setState({ loading: { message: `Abriendo ${file.name}…`, fraction: 0 }, error: null });
  try {
    const doc = await importAiFile(file, file.name, (message, fraction) =>
      useEditor.setState({ loading: { message, fraction } }),
    );
    loadDoc(doc);
  } catch (err) {
    console.error(err);
    useEditor.setState({ loading: null, error: err instanceof Error ? err.message : String(err) });
  }
}

export function newDocument() {
  loadDoc(emptyDoc());
}

export function deleteSelection() {
  const { selection } = state();
  if (!selection.length) return;
  commit((d) => deleteNodes(d as Doc, selection));
  select([]);
}

export function duplicateSelection(offset: [number, number] = [10, 10]) {
  const { selection } = state();
  let ids: string[] = [];
  commit((d) => {
    ids = duplicateNodes(d as Doc, selection, offset);
  });
  select(ids);
}

export function copySelection(cut = false) {
  const { doc, selection } = state();
  if (!doc) return;
  const nodes = getNodes(doc, topmostIds(doc, selection)).filter((n) => !(n.type === "group" && n.role));
  useEditor.setState({ clipboard: nodes });
  if (cut) deleteSelection();
}

export function paste(inPlace = false) {
  const { clipboard, activeLayer, activeArtboard, isolation } = state();
  if (!clipboard.length) return;
  const copies = clipboard.map((n) => cloneNode(n));
  if (!inPlace) for (const c of copies) transformNode(c, translate(10, 10));
  commit((d) => {
    for (const c of copies) insertNode(d as Doc, c, activeLayer, activeArtboard, isolation);
  });
  // Next paste goes a bit further.
  useEditor.setState({ clipboard: copies });
  select(copies.map((c) => c.id));
}

export function groupSelection() {
  const { selection } = state();
  if (selection.length < 1) return;
  let id: string | null = null;
  commit((d) => {
    id = groupNodes(d as Doc, selection);
  });
  if (id) select([id]);
}

export function ungroupSelection() {
  const { selection } = state();
  let ids: string[] = [];
  commit((d) => {
    ids = ungroupNodes(d as Doc, selection);
  });
  select(ids);
}

export function clipSelection() {
  const { selection } = state();
  let id: string | null = null;
  commit((d) => {
    id = makeClipMask(d as Doc, selection);
  });
  if (id) select([id]);
}

export function releaseClipSelection() {
  const { selection } = state();
  let ids: string[] = [];
  commit((d) => {
    ids = releaseClipMask(d as Doc, selection);
  });
  if (ids.length) select(ids);
}

export function arrangeSelection(mode: ArrangeMode) {
  const { selection } = state();
  if (selection.length) commit((d) => arrange(d as Doc, selection, mode));
}

export function alignSelection(mode: AlignMode) {
  const { doc, selection, activeArtboard } = state();
  if (!doc || !selection.length) return;
  const ids = topmostIds(doc, selection);
  const ab = doc.artboards[activeArtboard];
  const ref = ids.length > 1 ? selectionBBox(doc, ids) : { x: ab.x, y: ab.y, w: ab.width, h: ab.height };
  if (ref) commit((d) => alignNodes(d as Doc, ids, mode, ref));
}

export function nudgeSelection(dx: number, dy: number) {
  const { selection } = state();
  if (!selection.length) return;
  commit((d) => {
    for (const id of topmostIds(d as Doc, selection)) {
      const loc = locate(d as Doc, id);
      if (loc) transformNode(loc.node, translate(dx, dy));
    }
  });
}

export function flipSelection(axis: "h" | "v") {
  const { doc, selection } = state();
  if (!doc) return;
  const b = selectionBBox(doc, selection);
  if (!b) return;
  const D = about(axis === "h" ? scale(-1, 1) : scale(1, -1), b.x + b.w / 2, b.y + b.h / 2);
  commit((d) => {
    for (const id of topmostIds(d as Doc, selection)) {
      const loc = locate(d as Doc, id);
      if (loc) transformNode(loc.node, D);
    }
  });
}

export function rotateSelection(deg: number) {
  const { doc, selection } = state();
  if (!doc) return;
  const b = selectionBBox(doc, selection);
  if (!b) return;
  const D = about(rotate((deg * Math.PI) / 180), b.x + b.w / 2, b.y + b.h / 2);
  commit((d) => {
    for (const id of topmostIds(d as Doc, selection)) {
      const loc = locate(d as Doc, id);
      if (loc) transformNode(loc.node, D);
    }
  });
}

/** Moves/resizes the selection so its bounding box matches the given values (document space). */
export function setSelectionBox(next: { x?: number; y?: number; w?: number; h?: number }, keepRatio = false) {
  const { doc, selection } = state();
  if (!doc) return;
  const b = selectionBBox(doc, selection);
  if (!b) return;
  let sx = next.w !== undefined && b.w ? next.w / b.w : 1;
  let sy = next.h !== undefined && b.h ? next.h / b.h : 1;
  if (keepRatio) {
    if (next.w !== undefined) sy = sx;
    else if (next.h !== undefined) sx = sy;
  }
  const x = next.x ?? b.x;
  const y = next.y ?? b.y;
  const D = [sx, 0, 0, sy, x - b.x * sx, y - b.y * sy] as const;
  commit((d) => {
    for (const id of topmostIds(d as Doc, selection)) {
      const loc = locate(d as Doc, id);
      if (loc) transformNode(loc.node, [...D]);
    }
  });
}

/** Applies a change to every selected node (and, for groups, optionally to their leaves). */
export function updateSelected(recipe: (n: Draft<SceneNode>) => void, deep = true, coalesce?: string) {
  const { selection } = state();
  if (!selection.length) return;
  commit((d) => {
    const visit = (n: Draft<SceneNode>) => {
      if (n.type === "group" && deep) n.children.forEach(visit);
      else recipe(n);
    };
    for (const id of topmostIds(d as Doc, selection)) {
      const loc = locate(d as Doc, id);
      if (loc) visit(loc.node as Draft<SceneNode>);
    }
  }, coalesce && `${coalesce}:${selection.join(",")}`);
}

export function updateNode(id: string, recipe: (n: Draft<SceneNode>) => void, coalesce?: string) {
  commit((d) => {
    const loc = locate(d as Doc, id);
    if (loc) recipe(loc.node as Draft<SceneNode>);
  }, coalesce && `${coalesce}:${id}`);
}

export function selectAll() {
  const { doc, activeArtboard, isolation } = state();
  if (!doc) return;
  if (isolation) {
    const g = locate(doc, isolation)?.node;
    if (g?.type === "group") select(g.children.filter((c) => c.visible && !c.locked).map((c) => c.id));
    return;
  }
  const ids: string[] = [];
  for (const layer of doc.layers) {
    if (!layer.visible || layer.locked) continue;
    for (const sub of layer.children) {
      if (sub.type === "group" && sub.role === "artboard") {
        if (sub.artboard === activeArtboard && sub.visible && !sub.locked)
          ids.push(...sub.children.filter((c) => c.visible && !c.locked).map((c) => c.id));
      } else if (sub.visible && !sub.locked) ids.push(sub.id);
    }
  }
  select(ids);
}

export function selectedNodes(): SceneNode[] {
  const { doc, selection } = state();
  return doc ? getNodes(doc, selection) : [];
}

export function nodeCenter(n: SceneNode): [number, number] | null {
  const b = nodeBBox(n);
  return b ? [b.x + b.w / 2, b.y + b.h / 2] : null;
}
