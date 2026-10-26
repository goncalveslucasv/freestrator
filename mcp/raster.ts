// Rasterisation for the MCP tools: renders the scene with resvg (same SVG as the editor's export)
// and compares it against the reference photo.

import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { nodeBBox, type BBox } from "../src/lib/geometry";
import { artboardToSvg } from "../src/lib/exportSvg";
import type { Doc, GroupNode, SceneNode } from "../src/lib/types";
import { isReferenceLayer } from "../src/lib/reference";
import { hex, rgbToLab } from "../src/lib/vectorize/color";
import { withoutReference } from "./session";

export interface Raster {
  width: number;
  height: number;
  /** RGBA, opaque (rendered over white). */
  pixels: Uint8Array;
  /** Document region shown. */
  region: BBox;
}

const fmt = (n: number) => +n.toFixed(3);

/** Renders a document region to RGBA pixels. The longest side of the output is `maxSize` px. */
export async function renderRegion(doc: Doc, region: BBox, maxSize: number, artboard = 0): Promise<Raster> {
  let svg = await artboardToSvg(doc, artboard, { embedImages: "full" });
  // resvg crops isolated groups wrongly when the viewBox doesn't start at the origin.
  svg = svg.replace(/isolation:\s*isolate;?/g, "");
  svg = svg.replace(/<svg([^>]*)>/, (_, attrs: string) => {
    const rest = attrs.replace(/\s(width|height|viewBox)="[^"]*"/g, "");
    return `<svg${rest} width="${fmt(region.w)}" height="${fmt(region.h)}" viewBox="${fmt(region.x)} ${fmt(region.y)} ${fmt(region.w)} ${fmt(region.h)}">`;
  });
  const k = maxSize / Math.max(region.w, region.h);
  const resvg = new Resvg(svg, {
    background: "white",
    fitTo: region.w >= region.h ? { mode: "width", value: Math.max(1, Math.round(region.w * k)) } : { mode: "height", value: Math.max(1, Math.round(region.h * k)) },
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" },
  });
  const img = resvg.render();
  return { width: img.width, height: img.height, pixels: new Uint8Array(img.pixels), region };
}

export const toPng = (r: Pick<Raster, "width" | "height" | "pixels">) =>
  sharp(Buffer.from(r.pixels), { raw: { width: r.width, height: r.height, channels: 4 } }).png().toBuffer();

/** Only the reference layer, fully opaque and visible. */
export function referenceOnly(doc: Doc): Doc | null {
  const layer = doc.layers.find(isReferenceLayer);
  if (!layer) return null;
  const show = (n: SceneNode): SceneNode =>
    n.type === "group" ? { ...n, visible: true, opacity: 1, children: n.children.map(show) } : { ...n, visible: true, opacity: 1 };
  return { ...doc, layers: [show(layer) as GroupNode] };
}

export function referenceBBox(doc: Doc): BBox | null {
  const layer = referenceOnly(doc)?.layers[0];
  return layer ? nodeBBox(layer) : null;
}

/** The artwork (without the reference) and the reference, rendered over the same region. */
export async function renderPair(doc: Doc, region: BBox, maxSize: number) {
  const ref = referenceOnly(doc);
  if (!ref) throw new Error("No hay imagen de referencia. Usá set_reference primero.");
  const [art, photo] = await Promise.all([renderRegion(withoutReference(doc), region, maxSize), renderRegion(ref, region, maxSize)]);
  return { art, photo };
}

// ---------- comparison ----------

export interface CompareResult {
  /** Mean CIE76 ΔE over all pixels (0 = identical, ~2 = barely visible, >20 = clearly different). */
  meanDeltaE: number;
  /** Share of pixels with ΔE < 10. */
  matchPercent: number;
  /** Worst cells of a grid over the region, in document coordinates. */
  worst: { x: number; y: number; w: number; h: number; deltaE: number; expected: string; got: string }[];
  image: Buffer;
}

export async function compareRasters(art: Raster, photo: Raster, grid = 8): Promise<CompareResult> {
  const { width: W, height: H, region } = art;
  const n = W * H;
  const dE = new Float32Array(n);
  let sum = 0;
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const a = rgbToLab(art.pixels[i * 4], art.pixels[i * 4 + 1], art.pixels[i * 4 + 2]);
    const b = rgbToLab(photo.pixels[i * 4], photo.pixels[i * 4 + 1], photo.pixels[i * 4 + 2]);
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    dE[i] = d;
    sum += d;
    if (d < 10) ok++;
  }

  // Grid cells, square-ish in pixels.
  const cell = Math.max(W, H) / grid;
  const cols = Math.max(1, Math.round(W / cell));
  const rows = Math.max(1, Math.round(H / cell));
  const cells: CompareResult["worst"] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * W) / cols),
        x1 = Math.floor(((cx + 1) * W) / cols);
      const y0 = Math.floor((cy * H) / rows),
        y1 = Math.floor(((cy + 1) * H) / rows);
      let s = 0,
        c = 0;
      const ea = [0, 0, 0],
        ga = [0, 0, 0];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * W + x;
          s += dE[i];
          c++;
          for (let k = 0; k < 3; k++) {
            ea[k] += photo.pixels[i * 4 + k];
            ga[k] += art.pixels[i * 4 + k];
          }
        }
      }
      if (!c) continue;
      const sx = region.w / W;
      const sy = region.h / H;
      cells.push({
        x: Math.round(region.x + x0 * sx),
        y: Math.round(region.y + y0 * sy),
        w: Math.round((x1 - x0) * sx),
        h: Math.round((y1 - y0) * sy),
        deltaE: +(s / c).toFixed(1),
        expected: hex(ea[0] / c, ea[1] / c, ea[2] / c),
        got: hex(ga[0] / c, ga[1] / c, ga[2] / c),
      });
    }
  }
  cells.sort((a, b) => b.deltaE - a.deltaE);

  // Heat map: the photo in faded grey, error in red.
  const heat = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const g = 0.3 * photo.pixels[i * 4] + 0.59 * photo.pixels[i * 4 + 1] + 0.11 * photo.pixels[i * 4 + 2];
    const base = 255 - (255 - g) * 0.3;
    const t = Math.min(1, dE[i] / 40);
    heat[i * 4] = base * (1 - t) + 230 * t;
    heat[i * 4 + 1] = base * (1 - t) + 30 * t;
    heat[i * 4 + 2] = base * (1 - t) + 30 * t;
    heat[i * 4 + 3] = 255;
  }

  const gap = 8;
  const panel = (pixels: Uint8Array) => sharp(Buffer.from(pixels), { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const [p1, p2, p3] = await Promise.all([panel(photo.pixels), panel(art.pixels), panel(heat)]);
  const image = await sharp({ create: { width: W * 3 + gap * 2, height: H, channels: 4, background: "#808080" } })
    .composite([
      { input: p1, left: 0, top: 0 },
      { input: p2, left: W + gap, top: 0 },
      { input: p3, left: 2 * (W + gap), top: 0 },
    ])
    .png()
    .toBuffer();

  return { meanDeltaE: +(sum / n).toFixed(2), matchPercent: +((ok / n) * 100).toFixed(1), worst: cells.slice(0, 6), image };
}
