// Deterministic image vectoriser, shared by the editor ("Vectorizar imagen") and the MCP server.
//
//   pixels ─▶ anti-alias-aware palette ─▶ labels ─▶ speckle merge ─▶ (OCR text removal)
//          ─▶ regions (holes filled, ordered by nesting) ─▶ primitives or fitted beziers
//
// Same input and options always give the same output.

import { newId, type BBox } from "../geometry";
import type { GroupNode, PathNode, SceneNode, Seg } from "../types";
import { labImage, median3 } from "./color";
import { edgeMap, extractPalette, labelPixels, mergeSmallRegions, paletteFromHex } from "./quantize";
import { buildShapes, type Region } from "./regions";
import { applyText, type OcrLine } from "./text";

export type { OcrLine } from "./text";
export { recognizeLines } from "./text";

export type Detail = "low" | "medium" | "high";

export interface VectorizeOptions {
  /** Upper bound for the automatic palette. */
  maxColors?: number;
  /** Exact colours ("#rrggbb"); skips the automatic palette. */
  palette?: string[];
  detail?: Detail;
  /** Replace outlines that are rectangles, rounded rectangles or ellipses by exact shapes. */
  fitShapes?: boolean;
  /** Leave out the colour that covers most of the image border (e.g. paper behind a logo). */
  skipBackground?: boolean;
  /** Text lines from recognizeLines(); they become text nodes. */
  ocr?: OcrLine[];
  /** If tracing would produce more shapes than this, speckle merging gets more aggressive. */
  maxShapes?: number;
}

export interface VectorizeReport {
  palette: { color: string; share: number }[];
  shapes: number;
  primitives: Record<string, number>;
  texts: number;
  segments: number;
}

const PRESETS: Record<Detail, { maxColors: number; mergeDeltaE: number; closeDeltaE: number; edgeDeltaE: number; minArea: (n: number) => number; cornerAngle: number; errorSq: number; smooth: number; hairline: number; cornerWindow: number; median: boolean; straightness: number }> = {
  low: { maxColors: 12, mergeDeltaE: 14, closeDeltaE: 8, edgeDeltaE: 12, minArea: (n) => Math.max(16, n * 4e-5), cornerAngle: 60, errorSq: 4, smooth: 4, hairline: 3, cornerWindow: 8, median: true, straightness: 0.03 },
  medium: { maxColors: 24, mergeDeltaE: 9, closeDeltaE: 6, edgeDeltaE: 10, minArea: (n) => Math.max(6, n * 1e-5), cornerAngle: 55, errorSq: 1.5, smooth: 3, hairline: 2.5, cornerWindow: 6, median: false, straightness: 0.012 },
  high: { maxColors: 40, mergeDeltaE: 6, closeDeltaE: 4, edgeDeltaE: 8, minArea: (n) => Math.max(3, n * 3e-6), cornerAngle: 50, errorSq: 0.5, smooth: 1, hairline: 1.25, cornerWindow: 4, median: false, straightness: 0.006 },
};

const NAMES = { rect: "Rectángulo", roundrect: "Rectángulo redondeado", ellipse: "Elipse" };

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Vectorises opaque RGBA pixels covering `region` (document space) into a group of shapes.
 * `onProgress` gets a message and a 0..1 fraction; the work yields between steps.
 */
export async function vectorizeRaster(
  image: { pixels: Uint8Array | Uint8ClampedArray; width: number; height: number },
  region: BBox,
  options: VectorizeOptions = {},
  onProgress: (message: string, fraction: number) => void = () => {},
): Promise<{ group: GroupNode; report: VectorizeReport }> {
  const preset = PRESETS[options.detail ?? "medium"];
  const { width: W, height: H } = image;
  const n = W * H;
  const pixels = preset.median ? median3(image.pixels, W, H) : image.pixels;

  onProgress("Analizando colores…", 0.05);
  await tick();
  const lab = labImage(pixels, n);
  const edges = edgeMap(lab, W, H, preset.edgeDeltaE);
  const palette = options.palette?.length
    ? paletteFromHex(options.palette)
    : extractPalette(pixels, edges, n, { maxColors: options.maxColors ?? preset.maxColors, mergeDeltaE: preset.mergeDeltaE, minShare: 0.0003 });

  onProgress("Asignando colores…", 0.2);
  await tick();
  const base = labelPixels(lab, edges, W, H, palette, preset.closeDeltaE);

  const sx = region.w / W,
    sy = region.h / H;
  const toPx = (x: number, y: number): [number, number] => [(x - region.x) / sx, (y - region.y) / sy];

  let texts: SceneNode[] = [];
  let labels = base;
  let shapes: ReturnType<typeof buildShapes>["shapes"] = [];
  let regions: Region[] = [];
  const maxShapes = options.maxShapes ?? 3000;
  let minArea = preset.minArea(n);
  for (let attempt = 0; attempt < 6; attempt++) {
    labels = base.slice();
    onProgress("Limpiando manchas…", 0.35);
    await tick();
    mergeSmallRegions(labels, W, H, minArea, palette, preset.hairline);
    if (options.ocr?.length) {
      onProgress("Ubicando textos…", 0.45);
      await tick();
      texts = await applyText(options.ocr, labels, W, H, palette, toPx, pixels, lab);
    }
    onProgress("Trazando formas…", 0.55);
    await tick();
    const border = borderLabel(labels, W, H);
    ({ shapes, regions } = buildShapes(labels, W, H, {
      fit: { cornerAngle: preset.cornerAngle, errorSq: preset.errorSq, smooth: preset.smooth, cornerWindow: preset.cornerWindow, straightness: preset.straightness },
      fitShapes: options.fitShapes ?? true,
      skip: options.skipBackground ? (r) => r.label === border && r.touchesBorder && r.depth === 0 : undefined,
    }));
    if (shapes.length <= maxShapes) break;
    minArea *= 3;
  }

  onProgress("Armando el resultado…", 0.95);
  await tick();
  const toDoc = (segs: Seg[]): Seg[] => segs.map((s) => ({ c: s.c, p: s.p.map((v, k) => +(k % 2 ? region.y + v * sy : region.x + v * sx).toFixed(2)) }));
  const primitives: Record<string, number> = {};
  let segments = 0;
  const children: SceneNode[] = shapes.map((s) => {
    const color = palette[s.region.label].hex;
    if (s.primitive) primitives[s.primitive] = (primitives[s.primitive] ?? 0) + 1;
    segments += s.segs.length;
    const node: PathNode = {
      id: newId(),
      type: "path",
      name: `${s.primitive ? NAMES[s.primitive] : "Forma"} ${color}`,
      visible: true,
      locked: false,
      opacity: 1,
      blend: "normal",
      segs: toDoc(s.segs),
      m: [1, 0, 0, 1, 0, 0],
      fill: { kind: "solid", color },
      fillOpacity: 1,
      fillRule: "nonzero",
      stroke: null,
      strokeOpacity: 1,
      strokeWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      miterLimit: 4,
      dash: [],
      dashOffset: 0,
    };
    return node;
  });
  if (texts.length) {
    children.push({ id: newId(), type: "group", name: "Textos", visible: true, locked: false, opacity: 1, blend: "normal", children: texts, expanded: false });
  }

  const counts = new Float64Array(palette.length);
  for (const r of regions) counts[r.label] += r.area;
  const report: VectorizeReport = {
    palette: palette.map((p, i) => ({ color: p.hex, share: +((counts[i] / n) * 100).toFixed(1) })).filter((p) => p.share > 0),
    shapes: shapes.length,
    primitives,
    texts: texts.length,
    segments,
  };
  const group: GroupNode = { id: newId(), type: "group", name: "Vectorizado", visible: true, locked: false, opacity: 1, blend: "normal", children, expanded: false };
  return { group, report };
}

/** Most common label along the image border. */
function borderLabel(labels: Uint8Array, W: number, H: number): number {
  const counts = new Int32Array(256);
  for (let x = 0; x < W; x++) {
    counts[labels[x]]++;
    counts[labels[(H - 1) * W + x]]++;
  }
  for (let y = 0; y < H; y++) {
    counts[labels[y * W]]++;
    counts[labels[y * W + W - 1]]++;
  }
  return counts.indexOf(Math.max(...counts));
}
