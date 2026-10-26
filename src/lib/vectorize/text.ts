// Text detection (OCR with tesseract.js, runs locally in the browser and in Node) and its use in the
// vectoriser: recognised lines become editable text nodes, and their pixels are painted over with
// the background colour so they aren't traced as shapes too.

import type { BBox } from "../geometry";
import { newId } from "../geometry";
import type { TextNode } from "../types";
import type { PaletteColor } from "./quantize";

export interface OcrLine {
  text: string;
  confidence: number;
  /** Document coordinates. */
  bbox: BBox;
  baseline: number;
  words: BBox[];
}

/** Maps OCR raster pixels to document coordinates. */
export interface OcrTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

type TesseractInput = Parameters<typeof import("tesseract.js").recognize>[0];

/**
 * Recognises text lines. `image` is whatever tesseract accepts in the current environment (canvas or
 * Blob in the browser, an encoded image Buffer in Node). Language data is downloaded on first use.
 */
export async function recognizeLines(
  image: TesseractInput,
  map: OcrTransform,
  opts: { langs?: string; cachePath?: string; minConfidence?: number } = {},
): Promise<OcrLine[]> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker(opts.langs ?? "eng+spa", 1, opts.cachePath ? { cachePath: opts.cachePath } : {});
  try {
    const { data } = await worker.recognize(image, {}, { blocks: true });
    const box = (b: { x0: number; y0: number; x1: number; y1: number }): BBox => ({
      x: b.x0 * map.scaleX + map.offsetX,
      y: b.y0 * map.scaleY + map.offsetY,
      w: (b.x1 - b.x0) * map.scaleX,
      h: (b.y1 - b.y0) * map.scaleY,
    });
    const lines: OcrLine[] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          const words = line.words.filter((w) => w.text.trim());
          if (!words.length) continue;
          // Tesseract may join side-by-side columns into one line: split at wide gaps.
          const height = line.rowAttributes?.rowHeight || line.bbox.y1 - line.bbox.y0;
          const runs: (typeof words)[] = [[words[0]]];
          for (let i = 1; i < words.length; i++) {
            if (words[i].bbox.x0 - words[i - 1].bbox.x1 > height * 1.6) runs.push([]);
            runs.at(-1)!.push(words[i]);
          }
          const bl = line.baseline;
          for (const run of runs) {
            const text = run.map((w) => w.text.trim()).join(" ");
            const confidence = run.reduce((a, w) => a + w.confidence, 0) / run.length;
            // Only confident text: doubtful words stay as traced shapes.
            if (confidence < (opts.minConfidence ?? 75) || run.some((w) => w.confidence < 55)) continue;
            // Mostly letters and digits, with at least one real word.
            const alnum = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
            if (alnum < 2 || alnum < text.replace(/\s/g, "").length * 0.7 || !/[\p{L}\p{N}]{2,}/u.test(text)) continue;
            if (alnum < 4 && confidence < 85) continue;
            const x0 = Math.min(...run.map((w) => w.bbox.x0)),
              y0 = Math.min(...run.map((w) => w.bbox.y0));
            const x1 = Math.max(...run.map((w) => w.bbox.x1)),
              y1 = Math.max(...run.map((w) => w.bbox.y1));
            // Baseline at the run's left edge (tesseract gives a line through the baseline).
            const baseY = bl.x1 !== bl.x0 ? bl.y0 + ((x0 - bl.x0) * (bl.y1 - bl.y0)) / (bl.x1 - bl.x0) : bl.y0;
            lines.push({
              text,
              confidence,
              bbox: box({ x0, y0, x1, y1 }),
              baseline: baseY * map.scaleY + map.offsetY,
              words: run.map((w) => box(w.bbox)),
            });
          }
        }
      }
    }
    return lines;
  } finally {
    await worker.terminate();
  }
}

type Measure = (text: string, size: number, bold: boolean) => number;

/** Text width with Helvetica metrics (pdf-lib's standard fonts work in the browser and in Node). */
async function helveticaMeasure(): Promise<Measure> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  return (text, size, isBold) => {
    const font = isBold ? bold : regular;
    try {
      return font.widthOfTextAtSize(text, size);
    } catch {
      // Characters outside WinAnsi: approximate.
      return text.length * size * 0.55;
    }
  };
}

/**
 * Applies OCR lines to the label map: each confident line becomes a text node, and its word boxes
 * are filled with the surrounding colour. Returns the text nodes (document space).
 */
export async function applyText(
  lines: OcrLine[],
  labels: Uint8Array,
  W: number,
  H: number,
  palette: PaletteColor[],
  toPx: (x: number, y: number) => [number, number],
  pixels: Uint8Array | Uint8ClampedArray,
  lab: Float32Array,
): Promise<TextNode[]> {
  if (!lines.length) return [];
  const measure = await helveticaMeasure();
  const nodes: TextNode[] = [];
  const counts = new Int32Array(256);
  for (const line of lines) {
    let textLabel = -1;
    let ink = 0,
      boxArea = 0;
    const boxes: { x0: number; y0: number; x1: number; y1: number; bg: number }[] = [];
    let plausible = true;
    for (const w of line.words) {
      const [ax, ay] = toPx(w.x, w.y);
      const [bx, by] = toPx(w.x + w.w, w.y + w.h);
      const x0 = Math.max(0, Math.floor(ax) - 1),
        y0 = Math.max(0, Math.floor(ay) - 1);
      const x1 = Math.min(W, Math.ceil(bx) + 1),
        y1 = Math.min(H, Math.ceil(by) + 1);
      if (x1 <= x0 || y1 <= y0) continue;
      // Background: most common colour on the ring around the box.
      counts.fill(0);
      for (let x = Math.max(0, x0 - 1); x < Math.min(W, x1 + 1); x++) {
        if (y0 > 0) counts[labels[(y0 - 1) * W + x]]++;
        if (y1 < H) counts[labels[y1 * W + x]]++;
      }
      for (let y = y0; y < y1; y++) {
        if (x0 > 0) counts[labels[y * W + x0 - 1]]++;
        if (x1 < W) counts[labels[y * W + x1]]++;
      }
      const bg = counts.indexOf(Math.max(...counts));
      // Inside: background plus (mostly) one ink colour, or it isn't plain text.
      counts.fill(0);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) counts[labels[y * W + x]]++;
      const area = (x1 - x0) * (y1 - y0);
      let colours = 0,
        best = -1,
        bc = 0;
      for (let l = 0; l < 256; l++) {
        if (counts[l] > area * 0.1) colours++;
        if (l !== bg && counts[l] > bc) {
          bc = counts[l];
          best = l;
        }
      }
      if (colours > 4 || best < 0) {
        plausible = false;
        break;
      }
      if (textLabel < 0) textLabel = best;
      ink += bc;
      boxArea += area;
      boxes.push({ x0, y0, x1, y1, bg });
    }
    if (!plausible || !boxes.length || textLabel < 0) continue;

    // Ink colour: the pixels that differ most from the background (the true stroke colour, which
    // the palette may lack when the text is small and blurry).
    const bgLab = palette[boxes[0].bg].lab;
    const diffs: { d: number; i: number }[] = [];
    for (const b of boxes) {
      for (let y = b.y0; y < b.y1; y++) {
        for (let x = b.x0; x < b.x1; x++) {
          const i = y * W + x;
          diffs.push({ d: Math.hypot(lab[i * 3] - bgLab[0], lab[i * 3 + 1] - bgLab[1], lab[i * 3 + 2] - bgLab[2]), i });
        }
      }
    }
    diffs.sort((a, b) => b.d - a.d || a.i - b.i);
    const top = diffs.slice(0, Math.max(1, Math.round(diffs.length * 0.08)));
    const rgb = [0, 1, 2].map((c) => top.reduce((a, t) => a + pixels[t.i * 4 + c], 0) / top.length);
    const color = "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

    const bold = ink / boxArea > 0.3;
    // From the box height: cap height ≈ 0.72 em and descenders ≈ 0.21 em in Helvetica; x-height
    // ≈ 0.52 em when there are no tall letters.
    const tall = /[A-ZÁÉÍÓÚÑ0-9bdfhklt]/.test(line.text);
    const desc = /[gjpqyQ,;]/.test(line.text) ? 0.21 : 0;
    const byHeight = line.bbox.h / ((tall ? 0.72 : 0.52) + desc);
    // The size implied by the width must agree, or the box holds more than plain text.
    const byWidth = (byHeight * line.bbox.w) / measure(line.text, byHeight, bold);
    if (byHeight < 3 || byWidth / byHeight > 1.45 || byWidth / byHeight < 0.65) continue;
    const fontSize = Math.min(byHeight * 1.2, Math.max(byHeight * 0.85, byWidth));
    const baseline = line.bbox.y + line.bbox.h - desc * fontSize;
    const natural = measure(line.text, fontSize, bold);
    const gaps = Math.max(1, [...line.text].length - 1);
    const letterSpacing = Math.max(-0.05 * fontSize, Math.min(0.12 * fontSize, (line.bbox.w - natural) / gaps));
    for (const b of boxes) for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) labels[y * W + x] = b.bg;
    nodes.push({
      id: newId(),
      type: "text",
      name: line.text.slice(0, 40),
      visible: true,
      locked: false,
      opacity: 1,
      blend: "normal",
      m: [1, 0, 0, 1, line.bbox.x, baseline],
      text: line.text,
      fontSize: +fontSize.toFixed(2),
      family: "Helvetica",
      weight: bold ? 700 : 400,
      italic: false,
      letterSpacing: +letterSpacing.toFixed(3),
      fill: { kind: "solid", color },
      fillOpacity: 1,
      stroke: null,
      strokeOpacity: 1,
      strokeWidth: 1,
      align: "start",
    });
  }
  return nodes;
}
