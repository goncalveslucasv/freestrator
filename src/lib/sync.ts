// Wire protocol between the editor and the MCP server (mcp/bridge.ts). Shared by both sides, so it
// only relies on APIs available in browsers and Node (Blob, URL, btoa/atob).

import { base64ToBytes, bytesToBase64, fonts, images, type FontAsset, type ImageAsset } from "./assets";
import { walk } from "./geometry";
import type { Doc, SceneNode } from "./types";

export const BRIDGE_PORT = 7465;

/** Where the editor is published; these pages may connect to a local MCP server. */
export const APP_ORIGINS = ["https://freestrator.vercel.app"];

export interface WireImage {
  kind: "image";
  id: string;
  mime: string;
  data: string;
  width: number;
  height: number;
  hasAlpha: boolean;
}

export interface WireFont extends Omit<FontAsset, "data"> {
  kind: "font";
  data?: string;
}

export type WireAsset = WireImage | WireFont;

export type BridgeMessage =
  /** Editor -> server, right after connecting. */
  | { type: "hello"; doc: Doc | null }
  /** Either way. Assets the document needs are sent first as "asset" messages. */
  | { type: "doc"; doc: Doc; label?: string }
  | { type: "asset"; asset: WireAsset }
  /** Editor -> server: current selection. Server -> editor: objects to select. */
  | { type: "selection"; ids: string[] };

/** Ids of the image and font assets a document references. */
export function assetIds(doc: Doc): Set<string> {
  const ids = new Set<string>();
  const visit = (nodes: SceneNode[]) => {
    for (const [n] of walk(nodes)) {
      if (n.type === "image") ids.add(n.asset);
      if (n.type === "text" && n.font) ids.add(n.font);
      if (n.type === "group" && n.mask) visit(n.mask.nodes);
    }
  };
  visit(doc.layers);
  return ids;
}

export async function encodeAsset(id: string): Promise<WireAsset | null> {
  const img = images.get(id);
  if (img) {
    const data = bytesToBase64(new Uint8Array(await img.blob.arrayBuffer()));
    return { kind: "image", id, mime: img.blob.type, data, width: img.width, height: img.height, hasAlpha: img.hasAlpha };
  }
  const font = fonts.get(id);
  if (font) return { ...font, kind: "font", data: font.data ? bytesToBase64(font.data) : undefined };
  return null;
}

/** Registers an asset received from the other side (no-op if it is already known). */
export function decodeAsset(a: WireAsset) {
  if (a.kind === "image") {
    if (images.has(a.id)) return;
    const blob = new Blob([base64ToBytes(a.data)], { type: a.mime });
    const asset: ImageAsset = { id: a.id, blob, url: URL.createObjectURL(blob), width: a.width, height: a.height, hasAlpha: a.hasAlpha };
    images.set(a.id, asset);
  } else {
    if (fonts.has(a.id)) return;
    const { data, ...rest } = a;
    const font: FontAsset & { kind?: string } = { ...rest, data: data ? base64ToBytes(data) : undefined };
    delete font.kind;
    fonts.set(a.id, font);
  }
}

/** Messages that bring the other side up to date: missing assets first, then the document. */
export async function docMessages(doc: Doc, sent: Set<string>, label?: string): Promise<BridgeMessage[]> {
  const out: BridgeMessage[] = [];
  for (const id of assetIds(doc)) {
    if (sent.has(id)) continue;
    const asset = await encodeAsset(id);
    if (!asset) continue;
    sent.add(id);
    out.push({ type: "asset", asset });
  }
  out.push({ type: "doc", doc, label });
  return out;
}
