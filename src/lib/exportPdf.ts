"use client";

// Writes the document as a PDF (one page per artboard). Saved with the .ai extension it opens in
// Adobe Illustrator as a PDF-compatible file; layers are kept as optional content groups.

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, PDFString, StandardFonts, type PDFFont, type PDFRef, type PDFDict } from "pdf-lib";
import { fonts, images } from "./assets";
import { nodeBBox, segsBBox } from "./geometry";
import { IDENTITY, apply, mul, type Mat } from "./matrix";
import { layoutText } from "./text";
import type { Doc, GroupNode, Paint, PathNode, SceneNode, Seg, TextNode } from "./types";

const n = (v: number) => {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? "0" : String(r);
};
const mat = (m: Mat) => m.map(n).join(" ");
const rgb = (hex: string) => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0");
  return [0, 2, 4].map((k) => parseInt(full.slice(k, k + 2), 16) / 255);
};

const PDF_BLEND: Record<string, string> = {
  normal: "Normal",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  "color-dodge": "ColorDodge",
  "color-burn": "ColorBurn",
  "hard-light": "HardLight",
  "soft-light": "SoftLight",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

export interface PdfExportOptions {
  onProgress?: (message: string, fraction: number) => void;
}

export async function exportPdf(doc: Doc, opts: PdfExportOptions = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(doc.name);
  pdf.setCreator("Freestrator");
  pdf.setProducer("Freestrator (pdf-lib)");
  const ctx = pdf.context;

  // ---------- shared resources ----------
  const imageRefs = new Map<string, PDFRef>();
  const embeddedFonts = new Map<string, PDFFont | null>();
  const ocgRefs = doc.layers.map((l) => ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of(l.name ?? "Capa") })));

  async function imageRef(assetId: string): Promise<PDFRef | null> {
    if (imageRefs.has(assetId)) return imageRefs.get(assetId)!;
    const asset = images.get(assetId);
    if (!asset) return null;
    let blob = asset.blob;
    if (blob.type !== "image/jpeg" && blob.type !== "image/png") blob = await reencode(blob, asset.hasAlpha);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const img = blob.type === "image/jpeg" ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
    imageRefs.set(assetId, img.ref);
    return img.ref;
  }

  async function embeddedFont(fontId: string): Promise<PDFFont | null> {
    if (embeddedFonts.has(fontId)) return embeddedFonts.get(fontId)!;
    const f = fonts.get(fontId);
    let font: PDFFont | null = null;
    if (f?.data) {
      try {
        font = await pdf.embedFont(f.data, { subset: false });
      } catch (err) {
        console.warn("No se pudo embeber la fuente", f.name, err);
      }
    }
    embeddedFonts.set(fontId, font);
    return font;
  }

  const fallbackFonts = new Map<string, PDFFont>();
  async function fallbackFont(family: string, weight: number | "normal", italic: boolean): Promise<PDFFont> {
    const w = weight === "normal" ? 400 : Math.round(weight / 100) * 100;
    const key = `${family}|${w}|${italic}`;
    if (fallbackFonts.has(key)) return fallbackFonts.get(key)!;
    let font: PDFFont | null = null;
    const bytes = await fetchWebFont(family, w, italic);
    if (bytes) {
      try {
        font = await pdf.embedFont(bytes, { subset: true });
      } catch {
        font = null;
      }
    }
    font ??= await pdf.embedFont(
      w >= 600 ? (italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold) : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica,
    );
    fallbackFonts.set(key, font);
    return font;
  }

  // ---------- per page ----------
  for (let pageIndex = 0; pageIndex < doc.artboards.length; pageIndex++) {
    const ab = doc.artboards[pageIndex];
    opts.onProgress?.(`Escribiendo ${ab.name}…`, pageIndex / doc.artboards.length);
    const page = pdf.addPage([ab.width, ab.height]);
    const res = {
      ExtGState: new Map<string, PDFDict | PDFRef>(),
      XObject: new Map<string, PDFRef>(),
      Font: new Map<string, PDFRef>(),
      Shading: new Map<string, PDFRef>(),
      Properties: new Map<string, PDFRef>(),
    };
    const gsCache = new Map<string, string>();
    let counter = 0;
    const fontNames = new Map<PDFFont, string>();

    const gs = (fillA: number, strokeA: number, blend: string): string | null => {
      if (fillA >= 1 && strokeA >= 1 && blend === "normal") return null;
      const key = `${n(fillA)}|${n(strokeA)}|${blend}`;
      if (!gsCache.has(key)) {
        const name = `GS${counter++}`;
        res.ExtGState.set(name, ctx.obj({ Type: "ExtGState", ca: fillA, CA: strokeA, BM: PDF_BLEND[blend] ?? "Normal" }));
        gsCache.set(key, name);
      }
      return gsCache.get(key)!;
    };

    /** Gradient shading of the colors, or with `alpha` of the stop opacities (gray, for a soft mask). */
    const shading = (paint: Exclude<Paint, { kind: "solid" }>, alpha = false): string => {
      const stops = [...paint.stops].sort((a, b) => a.offset - b.offset);
      if (stops[0].offset > 0) stops.unshift({ ...stops[0], offset: 0 });
      if (stops.at(-1)!.offset < 1) stops.push({ ...stops.at(-1)!, offset: 1 });
      const fns = [];
      const bounds = [];
      for (let i = 0; i < stops.length - 1; i++) {
        const value = (s: (typeof stops)[number]) => (alpha ? [s.opacity ?? 1] : rgb(s.color));
        fns.push(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: value(stops[i]), C1: value(stops[i + 1]), N: 1 }));
        if (i > 0) bounds.push(stops[i].offset);
      }
      const fn =
        fns.length === 1
          ? fns[0]
          : ctx.obj({ FunctionType: 3, Domain: [0, 1], Functions: fns, Bounds: bounds, Encode: fns.flatMap(() => [0, 1]) });
      const ColorSpace = alpha ? "DeviceGray" : "DeviceRGB";
      const dict =
        paint.kind === "linear"
          ? ctx.obj({ ShadingType: 2, ColorSpace, Coords: [paint.x1, paint.y1, paint.x2, paint.y2], Function: fn, Extend: [true, true] })
          : ctx.obj({ ShadingType: 3, ColorSpace, Coords: [paint.fx, paint.fy, paint.fr, paint.cx, paint.cy, paint.r], Function: fn, Extend: [true, true] });
      const name = `Sh${counter++}`;
      res.Shading.set(name, ctx.register(dict));
      return name;
    };

    const fontName = (font: PDFFont) => {
      if (!fontNames.has(font)) {
        const name = `F${counter++}`;
        fontNames.set(font, name);
        res.Font.set(name, font.ref);
      }
      return fontNames.get(font)!;
    };

    const pathOps = (segs: Seg[], m?: Mat) => {
      const p = (x: number, y: number) => (m ? apply(m, x, y) : [x, y]).map(n).join(" ");
      let out = "";
      let cx = 0,
        cy = 0;
      for (const s of segs) {
        const q = s.p;
        if (s.c === "M") out += `${p(q[0], q[1])} m\n`;
        else if (s.c === "L") out += `${p(q[0], q[1])} l\n`;
        else if (s.c === "C") out += `${p(q[0], q[1])} ${p(q[2], q[3])} ${p(q[4], q[5])} c\n`;
        else if (s.c === "Q") {
          const c1 = [cx + (2 / 3) * (q[0] - cx), cy + (2 / 3) * (q[1] - cy)];
          const c2 = [q[2] + (2 / 3) * (q[0] - q[2]), q[3] + (2 / 3) * (q[1] - q[3])];
          out += `${p(c1[0], c1[1])} ${p(c2[0], c2[1])} ${p(q[2], q[3])} c\n`;
        } else if (s.c === "Z") out += "h\n";
        if (q.length) [cx, cy] = [q[q.length - 2], q[q.length - 1]];
      }
      return out;
    };

    const colorOps = (paint: Paint | null, stroke: boolean) => {
      if (!paint) return "";
      const color = paint.kind === "solid" ? paint.color : paint.stops[0]?.color ?? "#000000";
      return `${rgb(color).map(n).join(" ")} ${stroke ? "RG" : "rg"}\n`;
    };

    async function writeNodes(nodes: SceneNode[]): Promise<string> {
      let out = "";
      for (const node of nodes) out += await writeNode(node);
      return out;
    }

    async function writeNode(node: SceneNode): Promise<string> {
      if (!node.visible) return "";
      switch (node.type) {
        case "path":
          return writePath(node);
        case "image": {
          const ref = await imageRef(node.asset);
          if (!ref) return "";
          const name = `Im${counter++}`;
          res.XObject.set(name, ref);
          const g = gs(node.opacity, node.opacity, node.blend);
          return `q\n${g ? `/${g} gs\n` : ""}${mat(mul(node.m, [1, 0, 0, -1, 0, 1]))} cm\n/${name} Do\nQ\n`;
        }
        case "text":
          return writeText(node);
        case "group":
          return writeGroup(node);
      }
    }

    function writePath(p: PathNode): string {
      let out = "q\n";
      const g = gs(p.opacity * p.fillOpacity, p.opacity * p.strokeOpacity, p.blend);
      if (g) out += `/${g} gs\n`;
      out += `${mat(p.m)} cm\n`;
      const eo = p.fillRule === "evenodd";
      const geometry = pathOps(p.segs);
      if (p.fill && p.fill.kind !== "solid") {
        const area = `${geometry}${eo ? "W*" : "W"} n\n${p.fill.gt ? `${mat(p.fill.gt)} cm\n` : ""}`;
        // Stop opacities: a luminosity soft mask painted with the same gradient in gray.
        const mask = p.fill.stops.some((s) => (s.opacity ?? 1) < 1)
          ? softMask(`q\n${area}/${shading(p.fill, true)} sh\nQ\n`, segsBBox(p.segs, IDENTITY))
          : null;
        out += `q\n${mask ? `/${mask} gs\n` : ""}${area}/${shading(p.fill)} sh\nQ\n`;
      }
      const solidFill = p.fill?.kind === "solid";
      const hasStroke = !!p.stroke && p.strokeWidth > 0;
      if (solidFill || hasStroke) {
        out += colorOps(solidFill ? p.fill : null, false);
        if (hasStroke) {
          out += colorOps(p.stroke, true);
          out += `${n(p.strokeWidth)} w ${["butt", "round", "square"].indexOf(p.lineCap)} J ${["miter", "round", "bevel"].indexOf(p.lineJoin)} j ${n(p.miterLimit)} M\n`;
          if (p.dash.length) out += `[${p.dash.map(n).join(" ")}] ${n(p.dashOffset)} d\n`;
        }
        out += geometry;
        out += solidFill && hasStroke ? (eo ? "B*\n" : "B\n") : solidFill ? (eo ? "f*\n" : "f\n") : "S\n";
      }
      return out + "Q\n";
    }

    async function writeText(t: TextNode): Promise<string> {
      const layout = layoutText(t);
      const embedded = t.font ? await embeddedFont(t.font) : null;
      let out = "q\n";
      const g = gs(t.opacity * t.fillOpacity, t.opacity * t.strokeOpacity, t.blend);
      if (g) out += `/${g} gs\n`;
      // Text space is y-down in the document model; PDF text space is y-up.
      out += `${mat(mul(t.m, [1, 0, 0, -1, 0, 0]))} cm\n`;
      const mode = t.fill && t.stroke ? 2 : t.stroke ? 1 : 0;
      out += colorOps(t.fill, false) + colorOps(t.stroke, true);
      if (t.stroke) out += `${n(t.strokeWidth)} w\n`;
      out += `BT\n${mode} Tr\n`;
      const size = t.fontSize;
      const fontAsset = t.font ? fonts.get(t.font) : undefined;
      /** Width of one glyph char, in points; missing glyphs use the advance recorded at import. */
      const advance = (font: PDFFont, ch: string, own: boolean) =>
        own && !hasGlyph(font, ch) ? ((fontAsset?.widths[ch] ?? 250) * size) / 1000 : font.widthOfTextAtSize(ch, size);
      /** Emits glyphs at absolute x positions with one TJ; glyphs the font lacks (e.g. spaces in subsets) are skipped. */
      const run = (font: PDFFont, chars: string[], xs: number[], y: number) => {
        let pos = xs[0] ?? 0;
        let body = "";
        for (let i = 0; i < chars.length; i++) {
          if (!hasGlyph(font, chars[i])) continue;
          const adj = ((pos - xs[i]) * 1000) / size;
          if (Math.abs(adj) > 0.01) body += ` ${n(adj)} `;
          body += font.encodeText(chars[i]).toString();
          pos = xs[i] + font.widthOfTextAtSize(chars[i], size);
        }
        return body ? `/${fontName(font)} ${n(size)} Tf\n1 0 0 1 ${n(xs[0] ?? 0)} ${n(y)} Tm\n[${body}] TJ\n` : "";
      };
      out += "0 Tc\n";
      if (layout.glyphs && embedded) {
        // Keep the exact original glyph positions.
        out += run(embedded, [...layout.glyphs.chars], layout.glyphs.xs, 0);
      } else {
        const lines = layout.lines ?? [[{ text: t.text, embedded: false, family: t.family, weight: t.weight, italic: t.italic }]];
        for (let li = 0; li < lines.length; li++) {
          let x = 0;
          for (const r of lines[li]) {
            const own = r.embedded && !!embedded;
            const font = own ? embedded : await fallbackFont(t.family, r.weight, r.italic);
            const chars = [...(own ? r.text : sanitizeFor(font, r.text))];
            const xs = chars.map((ch) => {
              const at = x;
              x += advance(font, ch, own) + t.letterSpacing;
              return at;
            });
            out += run(font, chars, xs, -li * layout.lineHeight);
          }
        }
      }
      return out + "ET\nQ\n";
    }

    /** ExtGState with a luminosity soft mask drawn by `content` (in the current user space). */
    function softMask(content: string, box: { x: number; y: number; w: number; h: number } | null): string {
      const form = ctx.register(
        ctx.flateStream(content, {
          Type: "XObject",
          Subtype: "Form",
          BBox: box ? [box.x, box.y, box.x + box.w, box.y + box.h] : [-1e5, -1e5, 1e5, 1e5],
          Group: ctx.obj({ S: "Transparency", CS: "DeviceGray" }),
          Resources: resourcesDict(),
        }),
      );
      const name = `GS${counter++}`;
      res.ExtGState.set(name, ctx.obj({ Type: "ExtGState", SMask: ctx.obj({ Type: "Mask", S: "Luminosity", G: form }) }));
      return name;
    }

    async function writeGroup(g: GroupNode): Promise<string> {
      if (g.role === "artboard" && g.artboard !== pageIndex) return "";
      let inner = "";
      if (g.clip) {
        inner += `${pathOps(g.clip.segs, g.clip.m)}${g.clip.rule === "evenodd" ? "W*" : "W"} n\n`;
      }
      if (g.mask) {
        const maskContent = await writeNodes(g.mask.nodes);
        const bbox = groupBox(g.mask.nodes);
        const form = ctx.register(
          ctx.flateStream(maskContent, {
            Type: "XObject",
            Subtype: "Form",
            BBox: bbox,
            Group: ctx.obj({ S: "Transparency", CS: "DeviceRGB" }),
            Resources: resourcesDict(),
          }),
        );
        const name = `GS${counter++}`;
        res.ExtGState.set(
          name,
          ctx.obj({
            Type: "ExtGState",
            SMask: ctx.obj({
              Type: "Mask",
              S: g.mask.type === "alpha" ? "Alpha" : "Luminosity",
              G: form,
              ...(g.mask.backdrop ? { BC: rgb(g.mask.backdrop) } : {}),
            }),
          }),
        );
        inner += `/${name} gs\n`;
      }
      const children = await writeNodes(g.children);
      if (!children.trim()) return "";
      inner += children;
      const needsGroup = g.opacity < 1 || g.blend !== "normal";
      if (!needsGroup) return g.clip || g.mask ? `q\n${inner}Q\n` : inner;
      // Opacity/blending apply to the group as a whole: use a transparency group XObject.
      const form = ctx.register(
        ctx.flateStream(inner, {
          Type: "XObject",
          Subtype: "Form",
          BBox: groupBox([g]),
          Group: ctx.obj({ S: "Transparency", CS: "DeviceRGB" }),
          Resources: resourcesDict(),
        }),
      );
      const name = `Fm${counter++}`;
      res.XObject.set(name, form);
      const state = gs(g.opacity, g.opacity, g.blend);
      return `q\n${state ? `/${state} gs\n` : ""}/${name} Do\nQ\n`;
    }

    /** All page resources, shared by forms (resources are only added, never removed). */
    function resourcesDict() {
      return lazyResources;
    }
    const lazyResources = ctx.obj({});

    // Global (document) space -> page space.
    let content = `q\n1 0 0 -1 ${n(-ab.x)} ${n(ab.y + ab.height)} cm\n`;
    for (let li = 0; li < doc.layers.length; li++) {
      const layer = doc.layers[li];
      const body = await writeNodes(layer.children);
      if (!body.trim()) continue;
      const prop = `OC${li}`;
      res.Properties.set(prop, ocgRefs[li]);
      const g = layer.opacity < 1 ? gs(layer.opacity, layer.opacity, "normal") : null;
      content += `/OC /${prop} BDC\n${g ? `q /${g} gs\n` : ""}${body}${g ? "Q\n" : ""}EMC\n`;
    }
    content += "Q\n";

    // Fill the shared resources dictionary now that everything has been registered.
    const toDict = (m: Map<string, PDFDict | PDFRef>) => {
      const d = ctx.obj({});
      for (const [k, v] of m) d.set(PDFName.of(k), v);
      return d;
    };
    lazyResources.set(PDFName.of("ExtGState"), toDict(res.ExtGState));
    lazyResources.set(PDFName.of("XObject"), toDict(res.XObject));
    lazyResources.set(PDFName.of("Font"), toDict(res.Font));
    lazyResources.set(PDFName.of("Shading"), toDict(res.Shading));
    lazyResources.set(PDFName.of("Properties"), toDict(res.Properties));
    page.node.set(PDFName.of("Resources"), lazyResources);
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(content)));
    page.node.set(PDFName.of("ArtBox"), ctx.obj([0, 0, ab.width, ab.height]));
    page.node.set(PDFName.of("TrimBox"), ctx.obj([0, 0, ab.width, ab.height]));
  }

  // Layers (optional content).
  pdf.catalog.set(
    PDFName.of("OCProperties"),
    ctx.obj({
      OCGs: ocgRefs,
      D: ctx.obj({
        Order: [...ocgRefs].reverse(),
        ON: ocgRefs.filter((_, i) => doc.layers[i].visible),
        OFF: ocgRefs.filter((_, i) => !doc.layers[i].visible),
      }),
    }),
  );

  opts.onProgress?.("Comprimiendo…", 1);
  return pdf.save({ useObjectStreams: true });
}

function groupBox(nodes: SceneNode[]): number[] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const node of nodes) {
    const b = nodeBBox(node);
    if (!b) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (x0 === Infinity) return [0, 0, 1, 1];
  const pad = 2;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/** Whether an embedded font has a real glyph (not .notdef) for the character. */
function hasGlyph(font: PDFFont, ch: string): boolean {
  const fk = (font as unknown as { embedder?: { font?: { hasGlyphForCodePoint?: (cp: number) => boolean } } }).embedder?.font;
  if (!fk?.hasGlyphForCodePoint) return true; // standard 14 fonts
  return fk.hasGlyphForCodePoint(ch.codePointAt(0)!);
}

/** Drops characters a font can't encode (standard 14 fonts only cover WinAnsi). */
function sanitizeFor(font: PDFFont, text: string): string {
  try {
    font.encodeText(text);
    return text;
  } catch {
    return [...text]
      .map((ch) => {
        try {
          font.encodeText(ch);
          return ch;
        } catch {
          return "";
        }
      })
      .join("");
  }
}

const webFontCache = new Map<string, Promise<Uint8Array | null>>();
/** Fetches a TTF of a Google font family through Fontsource's CDN (used for edited text). */
function fetchWebFont(family: string, weight: number, italic: boolean): Promise<Uint8Array | null> {
  const key = `${family}|${weight}|${italic}`;
  if (!webFontCache.has(key)) {
    const slug = family.toLowerCase().trim().replace(/\s+/g, "-");
    const style = italic ? "italic" : "normal";
    const tryWeights = [...new Set([weight, 400])];
    webFontCache.set(
      key,
      (async () => {
        for (const w of tryWeights) {
          for (const subset of ["latin", "latin-ext"]) {
            try {
              const res = await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/${subset}-${w}-${style}.ttf`);
              if (res.ok) return new Uint8Array(await res.arrayBuffer());
            } catch {
              // try next
            }
          }
        }
        return null;
      })(),
    );
  }
  return webFontCache.get(key)!;
}

async function reencode(blob: Blob, alpha: boolean): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  return canvas.convertToBlob({ type: alpha ? "image/png" : "image/jpeg", quality: 0.92 });
}
