// Imports an Adobe Illustrator file (.ai) — or any PDF — into an editable scene graph.
//
// .ai files that keep Illustrator's native data are read natively with ai-file (Rust/WebAssembly
// codecs, in a Web Worker): real layers, editable text and the objects as the designer built them.
//
// Otherwise we fall back to the PDF rendition modern .ai files embed (one page per artboard): pdf.js
// parses it and we interpret its operator list (paths, clips, soft masks, transparency groups,
// shadings, images and text) into vector nodes instead of rasterising it.

import type { PDFPageProxy } from "pdfjs-dist";
import { fonts, images, pdfHandles, parseFontName, resetAssets, ensureWebFont, type FontAsset } from "./assets";
import { bboxContains, newId, rectSegs, segsBBox, transformBBox, type BBox } from "./geometry";
import { IDENTITY, inv, mul, scale, translate, type Mat } from "./matrix";
import { importNative } from "./native";
import type {
  Artboard,
  BlendMode,
  ClipShape,
  Doc,
  GradientStop,
  GroupNode,
  Paint,
  PathNode,
  SceneNode,
  Seg,
  TextNode,
} from "./types";

export type ProgressFn = (message: string, fraction: number) => void;

export async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  return pdfjs;
}

const ARTBOARD_GAP = 72;

export async function importAiFile(blob: Blob, fileName: string, onProgress: ProgressFn = () => {}): Promise<Doc> {
  await resetAssets();
  const name = fileName.replace(/\.(ai|pdf|eps)$/i, "");

  onProgress("Leyendo encabezado…", 0);
  const header = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1 << 16)).arrayBuffer());
  const headText = new TextDecoder("latin1").decode(header.slice(0, 1024));
  const isPdf = headText.includes("%PDF");

  try {
    const doc = await importNative(blob, name, onProgress);
    if (doc) return doc;
  } catch (err) {
    // The PDF rendition is still usable when the native data can't be read.
    if (!isPdf) throw err;
    console.warn("Native reading failed, falling back to the PDF rendition:", err);
    await resetAssets();
  }

  const pdfjs = await loadPdfjs();
  if (!isPdf) {
    if (headText.includes("%!PS-Adobe")) {
      throw new Error(
        "Este .ai fue guardado sin contenido compatible con PDF (formato PostScript antiguo). " +
          "En Illustrator, guardalo con la opción «Crear archivo compatible con PDF» activada.",
      );
    }
    throw new Error("El archivo no parece ser un .ai compatible con PDF.");
  }

  // Stream the file in ranges instead of loading hundreds of MB at once.
  class BlobRangeTransport extends pdfjs.PDFDataRangeTransport {
    requestDataRange(begin: number, end: number) {
      blob
        .slice(begin, end)
        .arrayBuffer()
        .then((buf) => this.onDataRange(begin, new Uint8Array(buf)));
    }
  }
  const transport = new BlobRangeTransport(blob.size, header);
  const task = pdfjs.getDocument({
    range: transport,
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: 1 << 20,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
    fontExtraProperties: true,
  });
  const pdf = await task.promise;
  pdfHandles.destroy = () => task.destroy();

  // Optional content groups = Illustrator layers.
  const ocConfig = await pdf.getOptionalContentConfig();
  const layerById = new Map<string, GroupNode>();
  const layers: GroupNode[] = [];
  const getLayer = (ocId: string | null): GroupNode => {
    const key = ocId ?? "__default";
    let layer = layerById.get(key);
    if (!layer) {
      const group = ocId ? ocConfig.getGroup(ocId) : null;
      layer = makeGroup({
        role: "layer",
        name: group?.name || `Capa ${layers.length + 1}`,
        visible: group ? group.visible !== false : true,
        color: LAYER_COLORS[layers.length % LAYER_COLORS.length],
        expanded: true,
      });
      layerById.set(key, layer);
      layers.push(layer);
    }
    return layer;
  };

  const n = pdf.numPages;
  const cols = n <= 3 ? n : Math.ceil(Math.sqrt(n * 1.5));
  const artboards: Artboard[] = [];
  let rowY = 0;
  let rowH = 0;
  let colX = 0;

  for (let i = 1; i <= n; i++) {
    onProgress(`Interpretando mesa de trabajo ${i} de ${n}…`, (i - 1) / n);
    const page = await pdf.getPage(i);
    const [vx0, vy0, vx1, vy1] = page.view;
    const width = vx1 - vx0;
    const height = vy1 - vy0;
    if ((i - 1) % cols === 0 && i > 1) {
      rowY += rowH + ARTBOARD_GAP;
      rowH = 0;
      colX = 0;
    }
    const ab: Artboard = { id: newId("ab"), name: `Mesa de trabajo ${i}`, x: colX, y: rowY, width, height };
    artboards.push(ab);
    colX += width + ARTBOARD_GAP;
    rowH = Math.max(rowH, height);

    // PDF user space (y up) -> document space (y down) for this artboard.
    const base: Mat = [1, 0, 0, -1, ab.x - vx0, ab.y + vy1];
    await interpretPage(pdfjs, page, i - 1, ab, base, getLayer, (frac) =>
      onProgress(`Procesando imágenes de la mesa ${i}…`, (i - 1 + frac) / n),
    );
    page.cleanup();
  }

  for (const layer of layers) {
    for (const sub of layer.children) simplifyGroup(sub as GroupNode, artboards);
    layer.children = layer.children.filter((sub) => sub.type === "group" && sub.children.length);
  }
  const nonEmpty = layers.filter((l) => l.children.length);
  const finalLayers = nonEmpty.length ? nonEmpty : layers.slice(0, 1);
  for (const f of fonts.values()) ensureWebFont(f.family);
  onProgress("Listo", 1);

  return { name, artboards, layers: finalLayers };
}

const LAYER_COLORS = ["#4f8cff", "#ff4f6d", "#3ecf8e", "#ffb547", "#b97cff", "#2ad4d4"];

function makeGroup(extra: Partial<GroupNode> = {}): GroupNode {
  return { id: newId(), type: "group", visible: true, locked: false, opacity: 1, blend: "normal", children: [], ...extra };
}

// ---------------------------------------------------------------------------------------------

interface GState {
  ctm: Mat;
  /** CTM pattern spaces are relative to (page base or current form). */
  baseCtm: Mat;
  container: GroupNode;
  /** Container before a soft mask was activated in this frame. */
  unmaskedContainer?: GroupNode;
  fill: Paint | null;
  stroke: Paint | null;
  fillAlpha: number;
  strokeAlpha: number;
  blend: BlendMode;
  lineWidth: number;
  lineCap: PathNode["lineCap"];
  lineJoin: PathNode["lineJoin"];
  miterLimit: number;
  dash: number[];
  dashOffset: number;
  font: string | null;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  renderMode: number;
}

type Pdfjs = Awaited<ReturnType<typeof loadPdfjs>>;

const CAPS: PathNode["lineCap"][] = ["butt", "round", "square"];
const JOINS: PathNode["lineJoin"][] = ["miter", "round", "bevel"];
const BLENDS = new Set([
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);

function getObj(page: PDFPageProxy, id: string): Promise<unknown> {
  const store = id.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 20000);
    try {
      store.get(id, (data: unknown) => {
        clearTimeout(timer);
        resolve(data);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function interpretPage(
  pdfjs: Pdfjs,
  page: PDFPageProxy,
  pageIndex: number,
  ab: Artboard,
  base: Mat,
  getLayer: (ocId: string | null) => GroupNode,
  onImageProgress: (frac: number) => void,
) {
  const OPS = pdfjs.OPS;
  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;

  // ---- resolve every object the operator list depends on ----
  const deps = new Set<string>();
  const imageIds = new Set<string>();
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.dependency) for (const id of args) deps.add(id);
    else if (fn === OPS.setFont || fn === OPS.shadingFill) deps.add(args[0]);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      deps.add(args[0]);
      imageIds.add(args[0]);
    } else if ((fn === OPS.setFillColorN || fn === OPS.setStrokeColorN) && args[0] !== "TilingPattern") deps.add(args[1]);
    else if (fn === OPS.paintImageMaskXObject && typeof args[0]?.data === "string") deps.add(args[0].data);
  }
  const objs = new Map<string, unknown>();
  await Promise.all([...deps].map(async (id) => objs.set(id, await getObj(page, id))));

  // Images -> encoded assets.
  let done = 0;
  for (const id of imageIds) {
    if (!images.has(id)) await registerImage(id, objs.get(id));
    onImageProgress(++done / imageIds.size);
  }

  // ---- interpret ----
  const sublayers = new Map<GroupNode, GroupNode>();
  const sublayerOf = (layer: GroupNode) => {
    let sub = sublayers.get(layer);
    if (!sub) {
      sub = makeGroup({ role: "artboard", artboard: pageIndex, name: ab.name, expanded: true });
      layer.children.push(sub);
      sublayers.set(layer, sub);
    }
    return sub;
  };

  let st: GState = {
    ctm: base,
    baseCtm: base,
    container: sublayerOf(getLayer(null)),
    fill: { kind: "solid", color: "#000000" },
    stroke: { kind: "solid", color: "#000000" },
    fillAlpha: 1,
    strokeAlpha: 1,
    blend: "normal",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    dash: [],
    dashOffset: 0,
    font: null,
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    renderMode: 0,
  };
  // The default (no OC) container is only kept if something gets drawn into it.
  const stack: GState[] = [];
  let pendingClip: "nonzero" | "evenodd" | null = null;
  let lastMask: GroupNode | null = null;
  const maskStack: { group: GroupNode; smask: { subtype: string; backdrop?: string } }[] = [];

  // Text state
  let textMatrix: Mat = [...IDENTITY];
  let textX = 0;
  let textY = 0;
  let lineX = 0;
  let lineY = 0;

  const save = () => stack.push({ ...st });
  const restore = () => {
    const prev = stack.pop();
    if (prev) st = prev;
  };
  const push = (node: SceneNode) => st.container.children.push(node);

  const toPaintFromPattern = (args: unknown[], localM: Mat): Paint | null => {
    if (args[0] === "TilingPattern") {
      const color = args[1];
      return { kind: "solid", color: typeof color === "string" ? color : "#808080" };
    }
    const ir = objs.get(args[1] as string) as unknown[] | null;
    const patMatrix = (args[2] as Mat | null) ?? IDENTITY;
    // Gradient space -> doc = baseCtm · patternMatrix; relative to the node's local space.
    return shadingToPaint(ir, mul(inv(localM), mul(st.baseCtm, patMatrix)));
  };

  // Fill/stroke patterns are resolved lazily because their mapping depends on the node matrix.
  let fillPatternArgs: unknown[] | null = null;
  let strokePatternArgs: unknown[] | null = null;
  const fillPaint = (m: Mat) => (fillPatternArgs ? toPaintFromPattern(fillPatternArgs, m) : st.fill);
  const strokePaint = (m: Mat) => (strokePatternArgs ? toPaintFromPattern(strokePatternArgs, m) : st.stroke);
  // Pattern args belong to the graphics state, so they must follow save/restore.
  const patternStack: [unknown[] | null, unknown[] | null][] = [];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case OPS.save:
        save();
        patternStack.push([fillPatternArgs, strokePatternArgs]);
        break;
      case OPS.restore:
        restore();
        [fillPatternArgs, strokePatternArgs] = patternStack.pop() ?? [null, null];
        break;
      case OPS.transform:
        st.ctm = mul(st.ctm, args as Mat);
        break;

      case OPS.setLineWidth:
        st.lineWidth = args[0];
        break;
      case OPS.setLineCap:
        st.lineCap = CAPS[args[0]] ?? "butt";
        break;
      case OPS.setLineJoin:
        st.lineJoin = JOINS[args[0]] ?? "miter";
        break;
      case OPS.setMiterLimit:
        st.miterLimit = args[0];
        break;
      case OPS.setDash:
        st.dash = [...(args[0] ?? [])];
        st.dashOffset = args[1] ?? 0;
        break;
      case OPS.setGState:
        for (const [key, value] of args[0] as [string, unknown][]) {
          if (key === "LW") st.lineWidth = value as number;
          else if (key === "LC") st.lineCap = CAPS[value as number] ?? "butt";
          else if (key === "LJ") st.lineJoin = JOINS[value as number] ?? "miter";
          else if (key === "ML") st.miterLimit = value as number;
          else if (key === "D") {
            const [arr, phase] = value as [number[], number];
            st.dash = [...arr];
            st.dashOffset = phase;
          } else if (key === "CA") st.strokeAlpha = value as number;
          else if (key === "ca") st.fillAlpha = value as number;
          else if (key === "BM") st.blend = BLENDS.has(value as string) ? (value as BlendMode) : "normal";
          else if (key === "Font") {
            const [fontId, size] = value as [string, number];
            st.font = fontId;
            st.fontSize = size;
          } else if (key === "SMask") {
            if (value && lastMask) {
              const masked = makeGroup({ mask: lastMask.mask, name: "<Grupo con máscara>" });
              push(masked);
              st.unmaskedContainer ??= st.container;
              st.container = masked;
              lastMask = null;
            } else if (!value && st.unmaskedContainer) {
              st.container = st.unmaskedContainer;
              st.unmaskedContainer = undefined;
            }
          }
        }
        break;

      case OPS.setFillRGBColor:
        st.fill = { kind: "solid", color: args[0] };
        fillPatternArgs = null;
        break;
      case OPS.setStrokeRGBColor:
        st.stroke = { kind: "solid", color: args[0] };
        strokePatternArgs = null;
        break;
      case OPS.setFillTransparent:
        st.fill = null;
        fillPatternArgs = null;
        break;
      case OPS.setStrokeTransparent:
        st.stroke = null;
        strokePatternArgs = null;
        break;
      case OPS.setFillColorN:
        fillPatternArgs = [...args];
        break;
      case OPS.setStrokeColorN:
        strokePatternArgs = [...args];
        break;

      case OPS.clip:
        pendingClip = "nonzero";
        break;
      case OPS.eoClip:
        pendingClip = "evenodd";
        break;

      case OPS.constructPath: {
        const [op, data] = args as [number, (Float32Array | number[] | null)[]];
        const segs = drawOpsToSegs(data?.[0] ?? null);
        const closes = op === OPS.closeStroke || op === OPS.closeFillStroke || op === OPS.closeEOFillStroke;
        if (closes && segs.length && segs.at(-1)!.c !== "Z") segs.push({ c: "Z", p: [] });
        const doFill = [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke, OPS.rawFillPath].includes(op);
        const doStroke = [OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(op);
        const evenOdd = op === OPS.eoFill || op === OPS.eoFillStroke || op === OPS.closeEOFillStroke;
        if (segs.length && (doFill || doStroke)) {
          const fill = doFill ? fillPaint(st.ctm) : null;
          const stroke = doStroke ? strokePaint(st.ctm) : null;
          if (fill || stroke) {
            push({
              id: newId(),
              type: "path",
              visible: true,
              locked: false,
              opacity: 1,
              blend: st.blend,
              segs,
              m: st.ctm,
              fill,
              fillOpacity: st.fillAlpha,
              fillRule: evenOdd ? "evenodd" : "nonzero",
              stroke,
              strokeOpacity: st.strokeAlpha,
              strokeWidth: st.lineWidth,
              lineCap: st.lineCap,
              lineJoin: st.lineJoin,
              miterLimit: st.miterLimit,
              dash: st.dash,
              dashOffset: st.dashOffset,
            });
          }
        }
        if (pendingClip) {
          const clip: ClipShape = { segs: segs.length ? segs : rectSegs(0, 0, 0, 0), m: st.ctm, rule: pendingClip };
          const g = makeGroup({ clip });
          push(g);
          st.container = g;
          pendingClip = null;
        }
        break;
      }

      case OPS.shadingFill: {
        const ir = objs.get(args[0]) as unknown[] | null;
        if (ir?.[0] === "Mesh") {
          // Mesh gradients (free-form / gradient mesh) have no SVG equivalent: rasterise them.
          const placed = await rasterizeMesh(ir, st.ctm);
          if (placed) push(makeImage(placed.asset, mul(st.ctm, placed.m), st));
          break;
        }
        const paint = shadingToPaint(ir, IDENTITY);
        if (!paint) break;
        // A shading paints the whole clip region: cover the artboard (in local space).
        const local = transformBBox(
          { x: ab.x - ab.width, y: ab.y - ab.height, w: ab.width * 3, h: ab.height * 3 },
          inv(st.ctm),
        );
        push({
          id: newId(),
          type: "path",
          name: "<Degradado>",
          visible: true,
          locked: false,
          opacity: 1,
          blend: st.blend,
          segs: rectSegs(local.x, local.y, local.w, local.h),
          m: st.ctm,
          fill: paint,
          fillOpacity: st.fillAlpha,
          fillRule: "nonzero",
          stroke: null,
          strokeOpacity: 1,
          strokeWidth: 0,
          lineCap: "butt",
          lineJoin: "miter",
          miterLimit: 10,
          dash: [],
          dashOffset: 0,
          // marker used by the simplifier
          ...({ __shading: true } as object),
        } as PathNode);
        break;
      }

      case OPS.paintFormXObjectBegin: {
        save();
        patternStack.push([fillPatternArgs, strokePatternArgs]);
        const [matrix, bbox] = args as [Mat | null, number[] | null];
        if (matrix) st.ctm = mul(st.ctm, matrix);
        st.baseCtm = st.ctm;
        if (bbox) {
          const [x0, y0, x1, y1] = bbox;
          const g = makeGroup({ clip: { segs: rectSegs(x0, y0, x1 - x0, y1 - y0), m: st.ctm, rule: "nonzero" } });
          push(g);
          st.container = g;
        }
        break;
      }
      case OPS.paintFormXObjectEnd:
        restore();
        [fillPatternArgs, strokePatternArgs] = patternStack.pop() ?? [null, null];
        break;

      case OPS.beginGroup: {
        const group = args[0] as { smask?: { subtype: string; backdrop?: string } | null; isolated?: boolean };
        save();
        patternStack.push([fillPatternArgs, strokePatternArgs]);
        if (group.smask) {
          const maskRoot = makeGroup();
          maskStack.push({ group: maskRoot, smask: group.smask });
          st.container = maskRoot;
        } else {
          const g = makeGroup({ opacity: st.fillAlpha, blend: st.blend });
          push(g);
          st.container = g;
        }
        st.fillAlpha = 1;
        st.strokeAlpha = 1;
        st.blend = "normal";
        st.unmaskedContainer = undefined;
        break;
      }
      case OPS.endGroup: {
        const group = args[0] as { smask?: unknown };
        restore();
        [fillPatternArgs, strokePatternArgs] = patternStack.pop() ?? [null, null];
        if (group.smask) {
          const entry = maskStack.pop();
          if (entry) {
            const backdrop = entry.smask.backdrop;
            lastMask = makeGroup({
              mask: {
                type: entry.smask.subtype === "Alpha" ? "alpha" : "luminance",
                nodes: entry.group.children,
                backdrop: backdrop && backdrop !== "#000000" ? backdrop : undefined,
              },
            });
          }
        }
        break;
      }

      case OPS.beginMarkedContentProps:
        if (args[0] === "OC" && args[1]?.id) st.container = sublayerOf(getLayer(args[1].id));
        break;

      // ---- images ----
      case OPS.paintImageXObject:
        if (images.has(args[0])) push(makeImage(args[0], mul(st.ctm, [1, 0, 0, -1, 0, 1]), st));
        break;
      case OPS.paintInlineImageXObject: {
        const id = newId("inline");
        await registerImage(id, args[0]);
        if (images.has(id)) push(makeImage(id, mul(st.ctm, [1, 0, 0, -1, 0, 1]), st));
        break;
      }
      case OPS.paintImageXObjectRepeat: {
        const [objId, sx, sy, positions] = args as [string, number, number, number[]];
        if (!images.has(objId)) break;
        for (let k = 0; k < positions.length; k += 2) {
          push(makeImage(objId, mul(st.ctm, mul([sx, 0, 0, sy, positions[k], positions[k + 1]], [1, 0, 0, -1, 0, 1])), st));
        }
        break;
      }
      case OPS.paintImageMaskXObject: {
        const img = args[0] as { data: unknown; width: number; height: number };
        const resolved = typeof img.data === "string" ? (objs.get(img.data) as typeof img) : img;
        const id = newId("mask");
        const color = st.fill?.kind === "solid" ? st.fill.color : "#000000";
        await registerImageMask(id, resolved, color);
        if (images.has(id)) push(makeImage(id, mul(st.ctm, [1, 0, 0, -1, 0, 1]), st));
        break;
      }
      case OPS.paintSolidColorImageMask:
        push(makeRect(st, 0, 0, 1, 1));
        break;

      // ---- text ----
      case OPS.beginText:
        textMatrix = [...IDENTITY];
        textX = textY = lineX = lineY = 0;
        break;
      case OPS.setTextMatrix: {
        const m = (Array.isArray(args[0]) || ArrayBuffer.isView(args[0]) ? Array.from(args[0] as ArrayLike<number>) : args) as Mat;
        textMatrix = [m[0], m[1], m[2], m[3], m[4], m[5]];
        textX = textY = lineX = lineY = 0;
        break;
      }
      case OPS.moveText:
        textX = lineX += args[0];
        textY = lineY += args[1];
        break;
      case OPS.setLeadingMoveText:
        st.leading = -args[1];
        textX = lineX += args[0];
        textY = lineY += args[1];
        break;
      case OPS.nextLine:
        textX = lineX;
        textY = lineY -= st.leading;
        break;
      case OPS.setLeading:
        st.leading = args[0];
        break;
      case OPS.setCharSpacing:
        st.charSpacing = args[0];
        break;
      case OPS.setWordSpacing:
        st.wordSpacing = args[0];
        break;
      case OPS.setHScale:
        st.hScale = args[0] / 100;
        break;
      case OPS.setTextRise:
        st.rise = args[0];
        break;
      case OPS.setTextRenderingMode:
        st.renderMode = args[0];
        break;
      case OPS.setFont: {
        st.font = args[0];
        st.fontSize = args[1];
        registerFont(args[0], objs.get(args[0]));
        break;
      }
      case OPS.nextLineSetSpacingShowText:
        st.wordSpacing = args[0];
        st.charSpacing = args[1];
        textX = lineX;
        textY = lineY -= st.leading;
        textX += showText(args[2]);
        break;
      case OPS.nextLineShowText:
        textX = lineX;
        textY = lineY -= st.leading;
        textX += showText(args[0]);
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        textX += showText(args[0]);
        break;
    }
  }

  /** Emits a text node and returns the horizontal advance (in text space). */
  function showText(glyphs: (number | { fontChar: string; unicode: string; width: number; isSpace: boolean })[]): number {
    const font = st.font ? fonts.get(st.font) : undefined;
    const fontObj = st.font ? (objs.get(st.font) as { fontMatrix?: number[]; vertical?: boolean } | null) : null;
    const fontMatrix = fontObj?.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];
    let size = Math.abs(st.fontSize);
    const advScale = size * fontMatrix[0];
    let x = 0;
    const xs: number[] = [];
    let chars = "";
    let text = "";
    for (const g of glyphs) {
      if (typeof g === "number") {
        x -= (g * size) / 1000;
        continue;
      }
      xs.push(x);
      chars += g.fontChar;
      text += g.unicode;
      if (font && g.unicode && !(g.unicode in font.map)) font.map[g.unicode] = g.fontChar;
      if (font && !(g.fontChar in font.widths)) font.widths[g.fontChar] = g.width;
      x += g.width * advScale + st.charSpacing + (g.isSpace ? st.wordSpacing : 0);
    }
    const advance = x * st.hScale;
    const mode = st.renderMode & 3;
    if (mode === 3 || !text.trim()) return advance;

    // text space -> doc: CTM · Tm · translate(x, y + rise) · scale(Th, -1)
    let m = mul(st.ctm, mul(textMatrix, mul(translate(textX, textY + st.rise), scale(st.hScale, -1))));
    let letterSpacing = st.charSpacing;
    // Fold uniform scaling into the font size so the size shown in the UI is meaningful.
    const sx = Math.hypot(m[0], m[1]);
    const sy = Math.hypot(m[2], m[3]);
    if (sx > 0 && Math.abs(sx - sy) / sx < 1e-3) {
      m = mul(m, scale(1 / sx));
      size *= sx;
      letterSpacing *= sx;
      for (let k = 0; k < xs.length; k++) xs[k] *= sx;
    }
    const fill = mode === 0 || mode === 2 ? fillPaint(m) : null;
    const stroke = mode === 1 || mode === 2 ? strokePaint(m) : null;
    const node: TextNode = {
      id: newId(),
      type: "text",
      visible: true,
      locked: false,
      opacity: 1,
      blend: st.blend,
      m,
      text,
      fontSize: size,
      font: font?.id,
      family: font?.family ?? "sans-serif",
      weight: font?.weight ?? 400,
      italic: font?.italic ?? false,
      letterSpacing,
      glyphs: font?.loadedName ? { chars, xs } : undefined,
      fill,
      fillOpacity: st.fillAlpha,
      stroke,
      strokeOpacity: st.strokeAlpha,
      strokeWidth: st.lineWidth * (sx || 1),
    };
    push(node);
    return advance;
  }
}

function makeImage(asset: string, m: Mat, st: GState): SceneNode {
  return { id: newId(), type: "image", visible: true, locked: false, opacity: st.fillAlpha, blend: st.blend, asset, m };
}

function makeRect(st: GState, x: number, y: number, w: number, h: number): PathNode {
  return {
    id: newId(),
    type: "path",
    visible: true,
    locked: false,
    opacity: 1,
    blend: st.blend,
    segs: rectSegs(x, y, w, h),
    m: st.ctm,
    fill: st.fill,
    fillOpacity: st.fillAlpha,
    fillRule: "nonzero",
    stroke: null,
    strokeOpacity: 1,
    strokeWidth: 0,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    dash: [],
    dashOffset: 0,
  };
}

function drawOpsToSegs(data: Float32Array | number[] | null): Seg[] {
  const segs: Seg[] = [];
  if (!data) return segs;
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  for (let i = 0; i < data.length; ) {
    switch (data[i++]) {
      case 0:
        segs.push({ c: "M", p: [r(data[i++]), r(data[i++])] });
        break;
      case 1:
        segs.push({ c: "L", p: [r(data[i++]), r(data[i++])] });
        break;
      case 2:
        segs.push({ c: "C", p: [r(data[i++]), r(data[i++]), r(data[i++]), r(data[i++]), r(data[i++]), r(data[i++])] });
        break;
      case 3:
        segs.push({ c: "Q", p: [r(data[i++]), r(data[i++]), r(data[i++]), r(data[i++])] });
        break;
      case 4:
        segs.push({ c: "Z", p: [] });
        break;
      default:
        return segs;
    }
  }
  return segs;
}

/** pdf.js shading IR -> paint. `gt` maps gradient space to the node's local space. */
function shadingToPaint(ir: unknown[] | null, gt: Mat): Paint | null {
  if (!ir) return null;
  if (ir[0] === "RadialAxial") {
    const [, type, , colorStops, p0, p1, r0, r1] = ir as [string, string, unknown, [number, string][], number[], number[], number, number];
    const stops: GradientStop[] = compactStops(colorStops.map(([offset, color]) => ({ offset, color })));
    const g = isIdentityMat(gt) ? undefined : gt;
    if (type === "axial") return { kind: "linear", stops, x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], gt: g };
    return { kind: "radial", stops, fx: p0[0], fy: p0[1], fr: r0, cx: p1[0], cy: p1[1], r: r1, gt: g };
  }
  if (ir[0] === "Mesh") {
    // Mesh gradients have no SVG equivalent; approximate with the average colour.
    const colors = ir[3] as Uint8Array | number[] | undefined;
    if (colors && colors.length >= 3) {
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let i = 0; i + 2 < colors.length; i += 3, n++) {
        r += colors[i];
        g += colors[i + 1];
        b += colors[i + 2];
      }
      return { kind: "solid", color: rgbHex(r / n, g / n, b / n) };
    }
  }
  return null;
}

/**
 * Rasterises a pdf.js mesh shading IR (already triangulated: positions, RGBA colours, vertex count,
 * bounds) into a transparent PNG. Returns the asset and the unit-square -> shading space matrix.
 */
async function rasterizeMesh(ir: unknown[], ctm: Mat): Promise<{ asset: string; m: Mat } | null> {
  const pos = ir[2] as Float32Array | number[];
  const col = ir[3] as Uint8Array | number[];
  const count = ir[4] as number;
  const bounds = ir[5] as number[] | null;
  if (!pos || !col || !count || !bounds) return null;
  const [bx0, by0, bx1, by1] = bounds;
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  if (!(bw > 0 && bh > 0)) return null;
  // ~3 px per document point, capped.
  const density = 3 * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
  const k = Math.min(density, 2048 / Math.max(bw, bh));
  const w = Math.max(1, Math.ceil(bw * k));
  const h = Math.max(1, Math.ceil(bh * k));
  const data = new Uint8ClampedArray(w * h * 4);
  const X = (i: number) => (pos[i * 2] - bx0) * (w / bw);
  const Y = (i: number) => (pos[i * 2 + 1] - by0) * (h / bh);
  for (let i = 0; i + 2 < count; i += 3) fillTriangle(data, w, h, [i, i + 1, i + 2], X, Y, col);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d")!.putImageData(new ImageData(data, w, h), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const id = newId("mesh");
  images.set(id, { id, blob, url: URL.createObjectURL(blob), width: w, height: h, hasAlpha: true });
  return { asset: id, m: [bw, 0, 0, bh, bx0, by0] };
}

/** Gouraud-shaded scanline fill of one triangle into an RGBA buffer. */
function fillTriangle(
  out: Uint8ClampedArray,
  w: number,
  h: number,
  idx: number[],
  X: (i: number) => number,
  Y: (i: number) => number,
  col: ArrayLike<number>,
) {
  const v = idx.map((i) => ({ x: X(i), y: Y(i), r: col[i * 4], g: col[i * 4 + 1], b: col[i * 4 + 2] })).sort((a, b) => a.y - b.y);
  const [a, b, c] = v;
  if (c.y - a.y < 1e-9) return;
  const lerp = (p: typeof a, q: typeof a, y: number) => {
    const t = q.y === p.y ? 0 : Math.min(1, Math.max(0, (y - p.y) / (q.y - p.y)));
    return { x: p.x + (q.x - p.x) * t, r: p.r + (q.r - p.r) * t, g: p.g + (q.g - p.g) * t, b: p.b + (q.b - p.b) * t };
  };
  const y0 = Math.max(0, Math.floor(a.y));
  const y1 = Math.min(h - 1, Math.ceil(c.y));
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    const e1 = lerp(a, c, sy);
    const e2 = sy < b.y ? lerp(a, b, sy) : lerp(b, c, sy);
    const [l, r] = e1.x <= e2.x ? [e1, e2] : [e2, e1];
    const x0 = Math.max(0, Math.floor(l.x));
    const x1 = Math.min(w - 1, Math.ceil(r.x));
    for (let x = x0; x <= x1; x++) {
      const t = r.x === l.x ? 0 : Math.min(1, Math.max(0, (x + 0.5 - l.x) / (r.x - l.x)));
      const o = (y * w + x) * 4;
      out[o] = l.r + (r.r - l.r) * t;
      out[o + 1] = l.g + (r.g - l.g) * t;
      out[o + 2] = l.b + (r.b - l.b) * t;
      out[o + 3] = 255;
    }
  }
}

const isIdentityMat = (m: Mat) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);
const rgbHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

/** pdf.js samples gradients into many stops; drop the ones that are linear interpolations of their neighbours. */
function compactStops(stops: GradientStop[]): GradientStop[] {
  if (stops.length <= 2) return stops;
  const rgb = (c: string) => [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));
  const out = [stops[0]];
  for (let i = 1; i < stops.length - 1; i++) {
    const a = out.at(-1)!;
    const b = stops[i];
    const c = stops[i + 1];
    const t = (b.offset - a.offset) / (c.offset - a.offset || 1);
    const [ca, cb, cc] = [rgb(a.color), rgb(b.color), rgb(c.color)];
    const err = Math.max(...cb.map((v, k) => Math.abs(v - (ca[k] + (cc[k] - ca[k]) * t))));
    if (err > 2) out.push(b);
  }
  out.push(stops.at(-1)!);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fonts and images

function registerFont(id: string, obj: unknown) {
  if (fonts.has(id) || !obj) return;
  const f = obj as {
    name?: string;
    loadedName?: string;
    fallbackName?: string;
    bold?: boolean;
    black?: boolean;
    italic?: boolean;
    data?: Uint8Array;
    isType3Font?: boolean;
    missingFile?: boolean;
  };
  const parsed = parseFontName(f.name || f.fallbackName || "sans-serif");
  const font: FontAsset = {
    id,
    name: parsed.name,
    family: parsed.family,
    weight: f.black ? 900 : f.bold && parsed.weight < 600 ? 700 : parsed.weight,
    italic: f.italic || parsed.italic,
    loadedName: !f.isType3Font && f.data ? f.loadedName : undefined,
    map: {},
    widths: {},
    data: f.data ? new Uint8Array(f.data) : undefined,
  };
  fonts.set(id, font);
}

type PdfImage = {
  width: number;
  height: number;
  bitmap?: ImageBitmap;
  data?: Uint8Array | Uint8ClampedArray;
  kind?: number;
};

const MAX_PROXY = 3000;

async function registerImage(id: string, obj: unknown) {
  const img = obj as PdfImage | null;
  if (!img || !img.width || !img.height) return;
  const { width, height } = img;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  if (img.bitmap) {
    ctx.drawImage(img.bitmap, 0, 0);
  } else if (img.data) {
    ctx.putImageData(new ImageData(toRGBA(img.data, width, height, img.kind ?? 3), width, height), 0, 0);
  } else return;

  const hasAlpha = detectAlpha(canvas);
  const type = hasAlpha ? "image/png" : "image/jpeg";
  const blob = await canvas.convertToBlob({ type, quality: 0.92 });
  let displayBlob = blob;
  const longest = Math.max(width, height);
  if (longest > MAX_PROXY) {
    const k = MAX_PROXY / longest;
    const proxy = new OffscreenCanvas(Math.round(width * k), Math.round(height * k));
    const pctx = proxy.getContext("2d")!;
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(canvas, 0, 0, proxy.width, proxy.height);
    displayBlob = await proxy.convertToBlob({ type, quality: 0.9 });
  }
  images.set(id, { id, blob, url: URL.createObjectURL(displayBlob), width, height, hasAlpha });
}

async function registerImageMask(id: string, img: { data: unknown; width: number; height: number } | null, color: string) {
  if (!img || !(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray)) return;
  const { width, height } = img;
  const src = img.data;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const [r, g, b] = [1, 3, 5].map((k) => parseInt(color.slice(k, k + 2), 16));
  const rowBytes = (width + 7) >> 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      const o = (y * width + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = bit ? 0 : 255;
    }
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  images.set(id, { id, blob, url: URL.createObjectURL(blob), width, height, hasAlpha: true });
}

function toRGBA(data: Uint8Array | Uint8ClampedArray, w: number, h: number, kind: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(w * h * 4);
  if (kind === 3) {
    out.set(data.subarray(0, out.length));
  } else if (kind === 2) {
    for (let i = 0, j = 0; j < out.length; i += 3, j += 4) {
      out[j] = data[i];
      out[j + 1] = data[i + 1];
      out[j + 2] = data[i + 2];
      out[j + 3] = 255;
    }
  } else {
    // 1 bit per pixel grayscale, rows padded to bytes.
    const rowBytes = (w + 7) >> 3;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const o = (y * w + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = 255;
      }
  }
  return out;
}

function detectAlpha(canvas: OffscreenCanvas): boolean {
  const k = Math.min(1, 512 / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * k));
  const h = Math.max(1, Math.round(canvas.height * k));
  const probe = new OffscreenCanvas(w, h);
  const ctx = probe.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Simplification: turn the save/restore soup of a PDF into a tidy Illustrator-like tree.

const isPlain = (g: GroupNode) => !g.clip && !g.mask && g.opacity === 1 && g.blend === "normal" && !g.role;

function simplifyGroup(g: GroupNode, artboards: Artboard[]) {
  const ab = artboards[g.artboard ?? 0];
  const abBox: BBox = { x: ab.x, y: ab.y, w: ab.width, h: ab.height };
  g.children = simplifyChildren(g.children, abBox);
}

function simplifyChildren(children: SceneNode[], abBox: BBox): SceneNode[] {
  const out: SceneNode[] = [];
  for (let child of children) {
    if (child.type === "group") {
      child.children = simplifyChildren(child.children, abBox);
      if (child.mask) child.mask.nodes = simplifyChildren(child.mask.nodes, abBox);
      // Clips that cover the whole artboard are no-ops (the artboard itself clips the page).
      if (child.clip && isRectClipCovering(child.clip, abBox)) child.clip = undefined;
      // Clip + a single shading = a gradient-filled shape.
      if (child.clip && !child.mask && child.children.length === 1) {
        const only = child.children[0];
        if (only.type === "path" && (only as { __shading?: boolean }).__shading && only.fill) {
          child = shadingToShape(child, only);
        }
      }
      if (child.type === "group") {
        if (!child.children.length) continue;
        if (isPlain(child)) {
          out.push(...child.children);
          continue;
        }
        // A group whose only effect is opacity/blend and has a single child: push the effect down.
        if (!child.clip && !child.mask && child.children.length === 1) {
          const only = child.children[0];
          if (only.blend === "normal" && (only.type !== "group" || !only.mask)) {
            only.opacity *= child.opacity;
            only.blend = child.blend;
            child = only;
          }
        }
      }
    }
    if (child.type === "path") delete (child as { __shading?: boolean }).__shading;
    out.push(child);
  }
  return out;
}

function isRectClipCovering(clip: ClipShape, abBox: BBox): boolean {
  const segs = clip.segs.filter((s) => s.c !== "Z");
  if (segs.length < 4 || segs.length > 5 || segs.some((s) => s.c === "C" || s.c === "Q")) return false;
  const b = segsBBox(clip.segs, clip.m);
  return !!b && bboxContains(b, abBox, 1);
}

function shadingToShape(group: GroupNode, shading: PathNode): PathNode {
  const clip = group.clip!;
  const paint = shading.fill!;
  // gradient -> shading local -> doc -> clip local
  const toClipLocal = mul(inv(clip.m), shading.m);
  const fill =
    paint.kind === "solid" ? paint : { ...paint, gt: paint.gt ? mul(toClipLocal, paint.gt) : toClipLocal };
  return {
    ...shading,
    id: group.id,
    name: undefined,
    segs: clip.segs,
    m: clip.m,
    fill,
    fillRule: clip.rule,
    opacity: shading.opacity * group.opacity,
    blend: group.blend !== "normal" ? group.blend : shading.blend,
  };
}

/** Exposed for the "new document" action. */
export function emptyDoc(width = 595.28, height = 841.89): Doc {
  const layer = makeGroup({ role: "layer", name: "Capa 1", color: LAYER_COLORS[0], expanded: true });
  layer.children.push(makeGroup({ role: "artboard", artboard: 0, name: "Mesa de trabajo 1", expanded: true }));
  return { name: "Sin título", artboards: [{ id: newId("ab"), name: "Mesa de trabajo 1", x: 0, y: 0, width, height }], layers: [layer] };
}
