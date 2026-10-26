// Reference photo for AI-assisted tracing: a locked bottom layer that the MCP tools compare the
// artwork against. Shared by the editor ("Colocar imagen de referencia…") and the MCP server.

import { newId } from "./geometry";
import type { Doc, GroupNode, ImageNode } from "./types";

export const REFERENCE_LAYER = "Referencia (Claude)";

export const isReferenceLayer = (n: { name?: string }) => n.name === REFERENCE_LAYER;

export interface PlaceReferenceOptions {
  opacity?: number;
  /** Resize artboard 0 to the photo's aspect ratio, with this longest side (pt). */
  resizeArtboard?: number | false;
}

/** Puts the image (asset already registered) in a fresh reference layer at the bottom. Mutates `doc`. */
export function placeReference(doc: Doc, asset: string, width: number, height: number, opts: PlaceReferenceOptions = {}): ImageNode {
  const ab = doc.artboards[0];
  if (opts.resizeArtboard) {
    const k = opts.resizeArtboard / Math.max(width, height);
    ab.width = Math.round(width * k);
    ab.height = Math.round(height * k);
  }
  // Contain-fit, centred on the artboard.
  const k = Math.min(ab.width / width, ab.height / height);
  const w = width * k;
  const h = height * k;
  const image: ImageNode = {
    id: newId("ref"),
    type: "image",
    name: "Foto de referencia",
    visible: true,
    locked: true,
    opacity: 1,
    blend: "normal",
    asset,
    m: [w, 0, 0, h, ab.x + (ab.width - w) / 2, ab.y + (ab.height - h) / 2],
  };
  const base = { visible: true, opacity: 1, blend: "normal" as const };
  const layer: GroupNode = {
    ...base,
    id: newId(),
    type: "group",
    role: "layer",
    name: REFERENCE_LAYER,
    locked: true,
    opacity: opts.opacity ?? 0.35,
    color: "#9aa0a6",
    expanded: false,
    children: [{ ...base, id: newId(), type: "group", role: "artboard", artboard: 0, name: ab.name, locked: true, children: [image] }],
  };
  doc.layers = doc.layers.filter((l) => !isReferenceLayer(l));
  doc.layers.unshift(layer);
  return image;
}

/** Id of the topmost layer that isn't the reference, creating "Capa 1" if there is none. Mutates `doc`. */
export function drawingLayer(doc: Doc): string {
  const layer = doc.layers.findLast((l) => !isReferenceLayer(l));
  if (layer) return layer.id;
  const created: GroupNode = {
    id: newId(),
    type: "group",
    role: "layer",
    name: "Capa 1",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    color: "#4f8cff",
    expanded: true,
    children: [],
  };
  doc.layers.push(created);
  return created.id;
}
