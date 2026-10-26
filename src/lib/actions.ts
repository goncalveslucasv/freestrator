"use client";

// High level editor commands, shared by menus, keyboard shortcuts and panels.

import { images } from "./assets";
import { cloneNode, newId, nodeBBox, transformNode, walk } from "./geometry";
import { emptyDoc, importAiFile } from "./importer";
import { about, mul, rotate, scale, translate } from "./matrix";
import {
  alignNodes,
  arrange,
  deleteNodes,
  duplicateNodes,
  ensureSublayer,
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
import { drawingLayer, isReferenceLayer, placeReference } from "./reference";
import { commit, loadDoc, requestFit, select, useEditor } from "./store";
import type { Doc, ImageNode, SceneNode } from "./types";
import type { Detail } from "./vectorize";
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

/** Puts an image file in the reference layer that Claude traces over (see mcp/). */
export async function placeReferenceImage(file: File) {
  try {
    const bmp = await createImageBitmap(file);
    const { width, height } = bmp;
    bmp.close();
    const id = newId("img");
    images.set(id, { id, blob: file, url: URL.createObjectURL(file), width, height, hasAlpha: file.type !== "image/jpeg" });
    if (!state().doc) loadDoc(emptyDoc());
    const doc = state().doc!;
    // An empty document takes the photo's proportions.
    const empty = ![...walk(doc.layers.filter((l) => !isReferenceLayer(l)))].some(([n]) => n.type !== "group");
    commit((d) => {
      placeReference(d as Doc, id, width, height, { resizeArtboard: empty ? 1000 : false });
    });
    requestFit(0);
  } catch (err) {
    console.error(err);
    useEditor.setState({ error: `No se pudo abrir la imagen: ${err instanceof Error ? err.message : err}` });
  }
}

/** The image "Vectorizar imagen" works on: the selected image, else the reference photo. */
export function vectorizableImage(): ImageNode | null {
  const { doc, selection } = state();
  if (!doc) return null;
  const selected = getNodes(doc, selection).find((n): n is ImageNode => n.type === "image");
  if (selected) return selected;
  const ref = doc.layers.find(isReferenceLayer);
  for (const [n] of walk(ref ? [ref] : [])) if (n.type === "image") return n;
  return null;
}

export interface VectorizeChoice {
  detail: Detail;
  ocr: boolean;
  skipBackground: boolean;
}

/** Draws an image into an opaque canvas whose longest side is `long` px. */
async function rasterize(blob: Blob, long: number) {
  const bmp = await createImageBitmap(blob);
  const k = long / Math.max(bmp.width, bmp.height);
  const W = Math.max(1, Math.round(bmp.width * k)),
    H = Math.max(1, Math.round(bmp.height * k));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  return { canvas, W, H };
}

/**
 * Vectorises the selected image (or the reference photo) in the browser. The result goes right
 * above the image, which is hidden; for the reference, it goes on the drawing layer.
 */
export async function vectorizeImage(choice: VectorizeChoice) {
  const node = vectorizableImage();
  const asset = node && images.get(node.asset);
  if (!node || !asset) return;
  const progress = (message: string, fraction: number) => useEditor.setState({ loading: { message, fraction } });
  progress("Preparando la imagen…", 0);
  try {
    const { vectorizeRaster, recognizeLines } = await import("./vectorize");
    // Small images are upsampled: interpolation gives the outlines sub-pixel information.
    const probe = await createImageBitmap(asset.blob);
    const natural = Math.max(probe.width, probe.height);
    probe.close();
    const { canvas, W, H } = await rasterize(asset.blob, Math.min(1600, Math.max(1200, natural)));
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, W, H).data;

    let ocr;
    if (choice.ocr) {
      progress("Buscando texto (la primera vez descarga los datos de idioma)…", 0.02);
      const big = await rasterize(asset.blob, Math.min(3200, Math.max(2400, natural)));
      ocr = await recognizeLines(await big.canvas.convertToBlob({ type: "image/png" }), {
        scaleX: W / big.W,
        scaleY: H / big.H,
        offsetX: 0,
        offsetY: 0,
      });
    }
    const { group } = await vectorizeRaster(
      { pixels, width: W, height: H },
      { x: 0, y: 0, w: W, h: H },
      { detail: choice.detail, skipBackground: choice.skipBackground, ocr },
      progress,
    );
    // Pixel space -> wherever the image sits in the document.
    transformNode(group, mul(node.m, scale(1 / W, 1 / H)));
    const { activeArtboard } = state();
    commit((d) => {
      const loc = locate(d as Doc, node.id);
      if (!loc || loc.path.some(isReferenceLayer)) {
        ensureSublayer(d as Doc, drawingLayer(d as Doc), activeArtboard).children.push(group);
      } else {
        loc.list.splice(loc.index + 1, 0, group);
        loc.node.visible = false;
      }
    });
    useEditor.setState({ loading: null });
    select([group.id]);
  } catch (err) {
    console.error(err);
    useEditor.setState({ loading: null, error: `No se pudo vectorizar: ${err instanceof Error ? err.message : err}` });
  }
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
