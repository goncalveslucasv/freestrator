// Converts the native Illustrator document read by `ai-file` into the editor's scene graph.
//
// The native model is in Illustrator "art space" (points, y up). The scene is in document space
// (points, y down); artboards keep their relative position from the file. Geometry is baked into
// document space so paths come out with identity matrices, like freshly drawn ones.

import {
  artBounds,
  rasterToPng,
  rasterToRgba,
  toRgb,
  type AiDocument,
  type Art,
  type Color,
  type GradientPaint,
  type MeshArt,
  type Paint as AiPaint,
  type PathArt,
  type PathStyle,
  type RasterArt,
  type CharStyle,
  type TextArt,
} from "ai-file";
import { parseFontName } from "../assets";
import { bboxContains, intersectBBox, newId, segsBBox, transformBBox, unionBBox, type BBox } from "../geometry";
import { IDENTITY, mul, scale, translate, type Mat } from "../matrix";
import { tessellateMesh } from "./mesh";
import type { Artboard, BlendMode, ClipShape, Doc, GradientStop, GroupNode, Paint, PathNode, SceneNode, Seg, TextNode } from "../types";

/** An image produced by the conversion: PNG when it has alpha, JPEG otherwise (like the PDF importer). */
export interface NativeImage {
  id: string;
  type: "image/png" | "image/jpeg";
  data: Uint8Array;
  /** Downscaled copy for on-screen display, when the image is large. */
  proxy?: Uint8Array;
  width: number;
  height: number;
  hasAlpha: boolean;
}

export interface NativeResult {
  doc: Doc;
  images: NativeImage[];
  /** Font families used by the text, to load as web fonts. */
  families: string[];
  warnings: string[];
}

const LAYER_COLORS = ["#4f8cff", "#ff4f6d", "#3ecf8e", "#ffb547", "#b97cff", "#2ad4d4"];
const MAX_PROXY = 3000;
const MESH_MAX_PX = 2048;

const hex = ([r, g, b]: [number, number, number]) =>
  "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
const colorHex = (c: Color) => hex(toRgb(c));

export async function convertNative(ai: AiDocument, name: string, onProgress: (fraction: number) => void = () => {}): Promise<NativeResult> {
  const conv = new Converter(ai);
  return conv.run(name, onProgress);
}

class Converter {
  private readonly ai: AiDocument;
  /** Art space -> document space. */
  private base: Mat = [...IDENTITY];
  private images: NativeImage[] = [];
  private imageByRange = new Map<string, NativeImage>();
  private imageBySig = new Map<string, { data: Uint8Array; raster: RasterArt }[]>();
  private families = new Set<string>();
  private warnings: string[] = [];
  private skipped = new Map<string, number>();

  constructor(ai: AiDocument) {
    this.ai = ai;
  }

  async run(name: string, onProgress: (fraction: number) => void): Promise<NativeResult> {
    const ai = this.ai;
    const rects = ai.artboards.length
      ? ai.artboards
      : [boundsArtboard(ai) ?? { name: "Mesa de trabajo 1", left: 0, top: 792, right: 612, bottom: 0 }];
    const minLeft = Math.min(...rects.map((a) => a.left));
    const maxTop = Math.max(...rects.map((a) => a.top));
    this.base = [1, 0, 0, -1, -minLeft, maxTop];
    const artboards: Artboard[] = rects.map((a, i) => ({
      id: newId("ab"),
      name: a.name || `Mesa de trabajo ${i + 1}`,
      x: a.left - minLeft,
      y: maxTop - a.top,
      width: a.right - a.left,
      height: a.top - a.bottom,
    }));

    const layers: GroupNode[] = [];
    for (let li = 0; li < ai.layers.length; li++) {
      const src = ai.layers[li];
      const layer = group({
        role: "layer",
        name: src.layerName || `Capa ${li + 1}`,
        visible: src.visible && !src.hidden,
        locked: src.locked,
        color: src.color ? hex([src.color[0] / 255, src.color[1] / 255, src.color[2] / 255]) : LAYER_COLORS[li % LAYER_COLORS.length],
        expanded: true,
      });
      const nodes: SceneNode[] = [];
      for (const child of src.children) {
        const n = await this.art(child);
        if (n) nodes.push(n);
      }
      layer.children = distribute(nodes, artboards);
      layers.push(layer);
      onProgress((li + 1) / ai.layers.length);
    }

    if (!layers.length) {
      const layer = group({ role: "layer", name: "Capa 1", color: LAYER_COLORS[0], expanded: true });
      layers.push(layer);
    }
    for (const layer of layers) {
      if (!layer.children.length) layer.children.push(group({ role: "artboard", artboard: 0, name: artboards[0].name, expanded: true }));
    }
    for (const [kind, count] of this.skipped) this.warnings.push(`Skipped ${count} unsupported object(s): ${kind}`);

    return {
      doc: { name, artboards, layers },
      images: this.images,
      families: [...this.families],
      warnings: [...ai.warnings, ...this.warnings],
    };
  }

  private skip(kind: string) {
    this.skipped.set(kind, (this.skipped.get(kind) ?? 0) + 1);
  }

  private async art(a: Art): Promise<SceneNode | null> {
    switch (a.type) {
      case "layer": {
        // Sublayers become named groups.
        const g = group({ name: a.layerName, visible: a.visible && !a.hidden, locked: a.locked });
        g.children = await this.children(a.children);
        return g.children.length ? g : null;
      }
      case "group":
        return this.group(a);
      case "compound": {
        const first = a.children[0];
        if (!first) return null;
        const node = this.path(first, a.children.flatMap((p) => this.segs(p)));
        if (node) applyBlend(node, a.blend, a);
        return node;
      }
      case "path":
        // A bare clipping path outside a clip group paints nothing.
        if (a.clip && !a.style.fill && !a.style.stroke) return null;
        return this.path(a, this.segs(a));
      case "raster":
        return await this.raster(a);
      case "text":
        return this.text(a);
      case "mesh":
        return this.mesh(a);
      default:
        this.skip(a.kind || "unknown");
        return null;
    }
  }

  private async children(list: Art[]): Promise<SceneNode[]> {
    const out: SceneNode[] = [];
    for (const c of list) {
      const n = await this.art(c);
      if (n) out.push(n);
    }
    return out;
  }

  private async group(a: Extract<Art, { type: "group" }>): Promise<SceneNode | null> {
    let clip: ClipShape | undefined;
    let rest = a.children;
    if (a.clipGroup) {
      const isClip = (c: Art) => (c.type === "path" && c.clip) || (c.type === "compound" && c.children.some((p) => p.clip));
      const clips = a.children.filter(isClip);
      rest = a.children.filter((c) => !isClip(c));
      if (clips.length) {
        const paths = clips.flatMap((c) => (c.type === "compound" ? c.children : c.type === "path" ? [c] : []));
        clip = { segs: paths.flatMap((p) => this.segs(p)), m: [...IDENTITY], rule: paths[0].style.fillRule };
      }
    }
    const children = await this.children(rest);
    if (!children.length) return null;
    const g = group({ name: a.name, visible: !a.hidden, locked: a.locked, clip });
    g.children = children;
    applyBlend(g, a.blend, a);
    return g;
  }

  private segs(p: PathArt): Seg[] {
    const [, , , , tx, ty] = this.base;
    const X = (x: number) => x + tx;
    const Y = (y: number) => ty - y;
    const out: Seg[] = [];
    for (const s of p.segments) {
      if (s.kind === "move") out.push({ c: "M", p: [X(s.x), Y(s.y)] });
      else if (s.kind === "line") out.push({ c: "L", p: [X(s.x), Y(s.y)] });
      else out.push({ c: "C", p: [X(s.x1!), Y(s.y1!), X(s.x2!), Y(s.y2!), X(s.x), Y(s.y)] });
    }
    if (out.length && out[0].c !== "M") out.unshift({ c: "M", p: [...out[0].p.slice(-2)] });
    if (p.closed && out.length) out.push({ c: "Z", p: [] });
    return out;
  }

  private path(a: PathArt, segs: Seg[]): PathNode | null {
    if (!segs.length) return null;
    const st = a.style;
    const ss = st.strokeStyle;
    const node: PathNode = {
      id: newId("x"),
      type: "path",
      name: a.name,
      visible: !a.hidden,
      locked: a.locked,
      opacity: 1,
      blend: "normal",
      segs,
      m: [...IDENTITY],
      fill: this.paint(st.fill),
      fillOpacity: 1,
      fillRule: st.fillRule,
      stroke: this.paint(st.stroke),
      strokeOpacity: 1,
      strokeWidth: ss.width,
      lineCap: ss.cap,
      lineJoin: ss.join,
      miterLimit: Math.max(1, ss.miterLimit),
      dash: ss.dash,
      dashOffset: ss.dashOffset,
    };
    applyBlend(node, a.blend ?? st.blend, a);
    return node;
  }

  private paint(p: AiPaint | null): Paint | null {
    if (!p) return null;
    if (p.type === "color") return { kind: "solid", color: colorHex(p.color) };
    if (p.type === "gradient") return this.gradient(p);
    // Patterns are not modelled by the editor yet: a neutral placeholder keeps the shape visible.
    return { kind: "solid", color: "#808080" };
  }

  private gradient(p: GradientPaint): Paint {
    const def = this.ai.gradients.get(p.name);
    if (!def || !def.stops.length) return { kind: "solid", color: "#808080" };
    const stops: GradientStop[] = [];
    def.stops.forEach((s, i) => {
      const ca = toRgb(s.color);
      stops.push(stop(s.offset, ca, s.opacity));
      const next = def.stops[i + 1];
      if (!next || Math.abs(s.midpoint - 0.5) < 0.01 || s.midpoint <= 0 || s.midpoint >= 1) return;
      // Illustrator's midpoint is an exponent on the segment parameter: v(t) = t^N, N = ln 0.5 / ln midpoint.
      const N = Math.log(0.5) / Math.log(s.midpoint);
      const cb = toRgb(next.color);
      for (let k = 1; k < 8; k++) {
        const t = k / 8;
        const v = Math.pow(t, N);
        const mix = (x: number, y: number) => x + (y - x) * v;
        stops.push(stop(s.offset + (next.offset - s.offset) * t, [mix(ca[0], cb[0]), mix(ca[1], cb[1]), mix(ca[2], cb[2])], mix(s.opacity, next.opacity)));
      }
    });
    // SVG pads the ramp beyond the first and last stops, PDF shadings don't: make them explicit.
    if (stops[0].offset > 0) stops.unshift({ ...stops[0], offset: 0 });
    if (stops[stops.length - 1].offset < 1) stops.push({ ...stops[stops.length - 1], offset: 1 });
    // Unit vector in Xm space, or legacy origin/angle/length in Bg-matrix space.
    let [x1, y1, x2, y2] = [0, 0, 1, 0];
    if (!p.unitVector) {
      const rad = (p.angle * Math.PI) / 180;
      [x1, y1] = p.origin;
      x2 = x1 + p.length * Math.cos(rad);
      y2 = y1 + p.length * Math.sin(rad);
    }
    const gt = mul(this.base, p.matrix as Mat);
    if (def.type === "linear") return { kind: "linear", stops, x1, y1, x2, y2, gt };
    const hl = p.highlight;
    return {
      kind: "radial",
      stops,
      cx: x1,
      cy: y1,
      r: Math.hypot(x2 - x1, y2 - y1),
      fx: hl ? x1 + hl[0] : x1,
      fy: hl ? y1 + hl[1] : y1,
      fr: 0,
      gt,
    };
  }

  private async raster(a: RasterArt): Promise<SceneNode | null> {
    const key = a.dataRange ? `${a.dataRange[0]}:${a.dataRange[1]}` : null;
    let img = key ? (this.imageByRange.get(key) ?? this.sameImage(a)) : undefined;
    if (!img) {
      img = (await this.encodeImage(a)) ?? undefined;
      if (!img) {
        this.skip(a.linked ? "linked image" : "image");
        return null;
      }
      this.images.push(img);
      if (key) this.imageByRange.set(key, img);
    }
    const [ma, mb, mc, md, tx, ty] = a.matrix;
    // Image space has v pointing down: art = (tx + a*u - c*v, ty + b*u - d*v).
    const m = mul(this.base, mul([ma, mb, -mc, -md, tx, ty], scale(a.width, a.height)));
    const node: SceneNode = { id: newId("x"), type: "image", name: a.name, visible: !a.hidden, locked: a.locked, opacity: 1, blend: "normal", asset: img.id, m };
    applyBlend(node, a.blend, a);
    return node;
  }

  private async encodeImage(a: RasterArt): Promise<NativeImage | null> {
    const hasAlpha = a.alphaChannels > 0;
    const big = Math.max(a.width, a.height) > MAX_PROXY;
    if (!hasAlpha && typeof OffscreenCanvas !== "undefined") {
      // Opaque images: JPEG through the browser's encoder, so the PDF export can embed them as is.
      const px = rasterToRgba(a, this.ai.source);
      if (!px) return null;
      const canvas = new OffscreenCanvas(px.width, px.height);
      const ctx = canvas.getContext("2d")!;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(px.rgba.buffer as ArrayBuffer, px.rgba.byteOffset, px.rgba.length), px.width, px.height), 0, 0);
      const data = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
      let proxy: Uint8Array | undefined;
      if (big) {
        const k = MAX_PROXY / Math.max(px.width, px.height);
        const small = new OffscreenCanvas(Math.round(px.width * k), Math.round(px.height * k));
        const sctx = small.getContext("2d")!;
        sctx.imageSmoothingQuality = "high";
        sctx.drawImage(canvas, 0, 0, small.width, small.height);
        proxy = new Uint8Array(await (await small.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
      }
      return { id: newId("img"), type: "image/jpeg", data, proxy, width: px.width, height: px.height, hasAlpha };
    }
    // PNG encoded in Rust (ai-file's WebAssembly codecs).
    const full = rasterToPng(a, this.ai.source, Infinity, 1);
    if (!full) return null;
    const proxy = big ? rasterToPng(a, this.ai.source, MAX_PROXY, 1)?.png : undefined;
    return { id: newId("img"), type: "image/png", data: full.png, proxy, width: full.width, height: full.height, hasAlpha };
  }

  /** Illustrator embeds a copy of an image per placement: reuse an identical one already encoded. */
  private sameImage(a: RasterArt): NativeImage | undefined {
    const [start, end] = a.dataRange!;
    const data = this.ai.source.subarray(start, end);
    const sig = `${a.width}x${a.height}x${a.channels}x${a.alphaChannels}:${data.length}:${sampleHash(data)}`;
    const candidates = this.imageBySig.get(sig);
    if (!candidates) {
      this.imageBySig.set(sig, [{ data, raster: a }]);
      return undefined;
    }
    for (const c of candidates) {
      if (sameBytes(c.data, data)) return this.imageByRange.get(`${c.raster.dataRange![0]}:${c.raster.dataRange![1]}`);
    }
    candidates.push({ data, raster: a });
    return undefined;
  }

  private text(a: TextArt): SceneNode | null {
    const td = a.undoFree ? this.ai.undoFreeText : this.ai.text;
    const story = td?.stories[a.storyIndex];
    if (!td || !story) return null;
    const frameId = story.frameIds[a.frameIndex] ?? story.frameIds[0];
    const frame = td.frames[frameId];
    if (!frame) return null;
    if (frame.kind !== "point" && !story.lines.some((l) => l.frameId === frameId && l.positions.length)) {
      this.skip(frame.kind === "area" ? "area text" : "text on a path");
      return null;
    }
    // Text space (y down, offset by the ruler origin) -> art space -> document space.
    const toArt: Mat = mul([1, 0, 0, -1, -td.rulerOrigin[0], td.rulerOrigin[1]], frame.matrix as Mat);
    const frameM = mul(this.base, toArt);
    const just = story.paragraphs[0]?.style.justification ?? 0;
    const nodes: TextNode[] = [];

    for (const line of story.lines) {
      if (line.frameId !== frameId) continue;
      const text = story.text.slice(line.start, line.start + line.length).replace(/[\r\n\u0003]+$/, "");
      if (!text.trim()) continue;
      const positioned = line.positions.length >= text.length;
      for (const r of story.chars) {
        const s = Math.max(r.start, line.start) - line.start;
        const e = Math.min(r.start + r.length, line.start + text.length) - line.start;
        if (e <= s) continue;
        const chunk = text.slice(s, e);
        if (!chunk.trim()) continue;
        const cs = r.style;
        const ps = cs.font?.postScriptName ?? "";
        const font = parseFontName(ps || "sans-serif");
        if (ps) this.families.add(font.family);
        const x0 = positioned ? line.x + line.positions[s] : frame.anchor[0];
        let m = mul(frameM, translate(x0, line.y - cs.baselineShift));
        if (cs.horizontalScale && cs.horizontalScale !== 1) m = mul(m, scale(cs.horizontalScale, 1));
        let size = cs.size;
        let xs = positioned ? Array.from(chunk, (_, k) => line.positions[s + k] - line.positions[s]) : undefined;
        // Fold uniform scaling into the font size so the size shown in the UI is meaningful.
        const sx = Math.hypot(m[0], m[1]);
        const sy = Math.hypot(m[2], m[3]);
        if (sx > 0 && Math.abs(sx - sy) / sx < 1e-3 && Math.abs(sx - 1) > 1e-6) {
          m = mul(m, scale(1 / sx));
          size *= sx;
          xs = xs?.map((x) => x * sx);
        }
        const fill = textPaint(cs.fill);
        const stroke = textPaint(cs.stroke);
        nodes.push({
          id: newId("x"),
          type: "text",
          visible: true,
          locked: false,
          opacity: 1,
          blend: "normal",
          m,
          text: chunk,
          fontSize: size,
          family: font.family,
          weight: cs.fauxBold && font.weight < 600 ? 700 : font.weight,
          italic: font.italic || cs.fauxItalic,
          letterSpacing: ((cs.tracking || 0) / 1000) * size,
          glyphs: xs ? { chars: chunk, xs } : undefined,
          fill: fill?.paint ?? null,
          fillOpacity: fill?.alpha ?? 1,
          stroke: stroke?.paint ?? null,
          strokeOpacity: stroke?.alpha ?? 1,
          strokeWidth: cs.strokeWidth * (sx || 1),
          align: positioned ? undefined : just === 2 ? "middle" : just === 1 ? "end" : undefined,
        });
      }
    }
    if (!nodes.length) return null;
    const target: SceneNode = nodes.length === 1 ? nodes[0] : group({ children: nodes });
    if (a.name) target.name = a.name;
    target.visible = !a.hidden;
    target.locked = a.locked;
    applyBlend(target, a.blend ?? a.style.blend, a);
    return target;
  }

  /** Gradient meshes are rasterized, like the PDF importer does. */
  private async mesh(a: MeshArt): Promise<SceneNode | null> {
    const b = artBounds(a);
    if (!b || typeof OffscreenCanvas === "undefined") return null;
    const [l, bottom, r, t] = b;
    const w = r - l;
    const h = t - bottom;
    if (w <= 0 || h <= 0) return null;
    const k = Math.min(4, MESH_MAX_PX / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * k));
    const ch = Math.max(1, Math.round(h * k));
    const canvas = new OffscreenCanvas(cw, ch);
    const ctx = canvas.getContext("2d")!;
    ctx.lineWidth = 1;
    for (const { quad, color } of tessellateMesh(a, 12)) {
      ctx.beginPath();
      quad.forEach(([x, y], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, (x - l) * k, (t - y) * k));
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle = meshColor(a.colorSpace, color);
      ctx.fill();
      ctx.stroke();
    }
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const img: NativeImage = { id: newId("img"), type: "image/png", data: new Uint8Array(await blob.arrayBuffer()), width: cw, height: ch, hasAlpha: true };
    this.images.push(img);
    const [x, y] = [l + this.base[4], this.base[5] - t];
    const node: SceneNode = { id: newId("x"), type: "image", name: a.name ?? "Malla", visible: !a.hidden, locked: a.locked, opacity: 1, blend: "normal", asset: img.id, m: [w, 0, 0, h, x, y] };
    applyBlend(node, a.blend, a);
    return node;
  }
}

/** FNV-1a over up to 64K evenly spaced bytes. */
function sampleHash(data: Uint8Array): number {
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(data.length / 65536));
  for (let i = 0; i < data.length; i += step) h = Math.imul(h ^ data[i], 0x01000193);
  return h >>> 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Compare 32 bits at a time when both views are aligned.
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const n = a.length >> 2;
    const a32 = new Uint32Array(a.buffer, a.byteOffset, n);
    const b32 = new Uint32Array(b.buffer, b.byteOffset, n);
    for (let i = 0; i < n; i++) if (a32[i] !== b32[i]) return false;
    for (let i = n << 2; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function stop(offset: number, rgb: [number, number, number], opacity: number): GradientStop {
  return opacity < 1 ? { offset, color: hex(rgb), opacity } : { offset, color: hex(rgb) };
}

function textPaint(p: CharStyle["fill"]): { paint: Paint; alpha: number } | null {
  if (!p) return null;
  const v = p.values;
  const rgb: [number, number, number] =
    p.space === "rgb" ? [v[0], v[1], v[2]] : p.space === "cmyk" ? toRgb({ kind: "cmyk", c: v[0], m: v[1], y: v[2], k: v[3] }) : [v[0], v[0], v[0]];
  return { paint: { kind: "solid", color: hex(rgb) }, alpha: p.alpha >= 0 && p.alpha <= 1 ? p.alpha : 1 };
}

function meshColor(space: string, c: number[]): string {
  if (space === "DeviceCMYK") return hex(toRgb({ kind: "cmyk", c: c[0], m: c[1], y: c[2], k: c[3] }));
  if (space === "DeviceGray") return hex([c[0], c[0], c[0]]);
  return hex([c[0], c[1], c[2]]);
}

function applyBlend(node: SceneNode, blend: PathStyle["blend"] | undefined, a: Art) {
  if (a.name && !node.name) node.name = a.name;
  if (!blend) return;
  node.opacity *= blend.opacity;
  if (blend.mode !== "normal") node.blend = blend.mode as BlendMode;
}

function group(extra: Partial<GroupNode> = {}): GroupNode {
  return { id: newId("x"), type: "group", visible: true, locked: false, opacity: 1, blend: "normal", children: [], ...extra };
}

/** Artboard covering the whole artwork, for documents without artboards (legacy files). */
function boundsArtboard(ai: AiDocument) {
  let b: [number, number, number, number] | null = null;
  for (const l of ai.layers) {
    const lb = artBounds(l);
    if (lb) b = b ? [Math.min(b[0], lb[0]), Math.min(b[1], lb[1]), Math.max(b[2], lb[2]), Math.max(b[3], lb[3])] : lb;
  }
  if (!b) {
    const hb = ai.header.boundingBox;
    if (!hb) return null;
    b = hb;
  }
  return { name: "Mesa de trabajo 1", left: b[0], bottom: b[1], right: b[2], top: b[3] };
}

// ---------------------------------------------------------------------------------------------
// Artboard sub-layers: the editor groups each layer's content per artboard (and clips it there).

function nodeBox(n: SceneNode): BBox | null {
  switch (n.type) {
    case "path":
      return segsBBox(n.segs, n.m);
    case "image":
      return transformBBox({ x: 0, y: 0, w: 1, h: 1 }, n.m);
    case "text": {
      // Rough box: glyph positions along the baseline, one em tall.
      const w = n.glyphs ? (n.glyphs.xs.at(-1) ?? 0) + n.fontSize * 0.6 : n.text.length * n.fontSize * 0.6;
      return transformBBox({ x: 0, y: -n.fontSize, w, h: n.fontSize * 1.2 }, n.m);
    }
    case "group": {
      if (n.clip) return segsBBox(n.clip.segs, n.clip.m);
      let b: BBox | null = null;
      for (const c of n.children) b = unionBBox(b, nodeBox(c));
      return b;
    }
  }
}

const area = (b: BBox | null) => (b ? Math.max(0, b.w) * Math.max(0, b.h) : 0);

/** Index of the artboard a box belongs to (largest overlap, else nearest), or -1 if it spans several. */
function homeArtboard(b: BBox, boxes: BBox[]): number {
  let best = -1;
  let bestArea = 0;
  let touched = 0;
  for (let i = 0; i < boxes.length; i++) {
    if (bboxContains(boxes[i], b)) return i;
    const o = intersectBBox(b, boxes[i]);
    const ov = o && o.w > 0 && o.h > 0 ? area(o) : 0;
    if (ov > 0) touched++;
    if (ov > bestArea) {
      bestArea = ov;
      best = i;
    }
  }
  if (touched > 1) return -1;
  if (best >= 0) return best;
  // Outside every artboard: the nearest one.
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  let dist = Infinity;
  boxes.forEach((ab, i) => {
    const d = Math.hypot(ab.x + ab.w / 2 - cx, ab.y + ab.h / 2 - cy);
    if (d < dist) {
      dist = d;
      best = i;
    }
  });
  return Math.max(0, best);
}

const isPlain = (g: GroupNode) => !g.clip && !g.mask && g.opacity === 1 && g.blend === "normal";

/** Splits a layer's nodes into one sub-layer per artboard, keeping stacking order. */
function distribute(nodes: SceneNode[], artboards: Artboard[]): GroupNode[] {
  const boxes = artboards.map((a) => ({ x: a.x, y: a.y, w: a.width, h: a.height }));
  const buckets = artboards.map(() => [] as SceneNode[]);

  const place = (n: SceneNode, into: SceneNode[][]) => {
    const b = nodeBox(n);
    let i = b ? homeArtboard(b, boxes) : 0;
    if (i === -1) {
      // Spans several artboards: split plain groups by artboard, otherwise use the biggest overlap.
      if (n.type === "group" && isPlain(n) && n.children.length > 1) {
        const sub = artboards.map(() => [] as SceneNode[]);
        for (const c of n.children) place(c, sub);
        sub.forEach((kids, k) => {
          if (!kids.length) return;
          into[k].push(kids.length === n.children.length ? n : { ...n, id: k ? newId("x") : n.id, children: kids });
        });
        return;
      }
      let bestArea = -1;
      boxes.forEach((ab, k) => {
        const ov = area(intersectBBox(b, ab));
        if (ov > bestArea) {
          bestArea = ov;
          i = k;
        }
      });
    }
    into[i].push(n);
  };
  for (const n of nodes) place(n, buckets);

  const subs: GroupNode[] = [];
  buckets.forEach((kids, i) => {
    if (kids.length) subs.push(group({ role: "artboard", artboard: i, name: artboards[i].name, expanded: true, children: kids }));
  });
  return subs;
}
