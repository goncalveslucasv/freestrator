"use client";

import { renderToStaticMarkup } from "react-dom/server";
import { fonts, images } from "./assets";
import { walk } from "./geometry";
import { NodeView, RenderContext, type RenderOptions } from "./render";
import type { Doc, GroupNode, SceneNode } from "./types";

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Layers restricted to the content of one artboard. */
export function layersForArtboard(doc: Doc, index: number): GroupNode[] {
  return doc.layers.map((l) => ({
    ...l,
    children: l.children.filter((c) => !(c.type === "group" && c.role === "artboard" && c.artboard !== index)),
  }));
}

/** Serialises one artboard to a standalone SVG document (images and embedded fonts inlined). */
export async function artboardToSvg(doc: Doc, index: number, opts: { embedImages?: "full" | "display" } = {}): Promise<string> {
  const ab = doc.artboards[index];
  const layers = layersForArtboard(doc, index);
  const used = new Set<string>();
  const usedFonts = new Set<string>();
  const families = new Set<string>();
  const visit = (nodes: SceneNode[]) => {
    for (const [n] of walk(nodes)) {
      if (n.type === "image") used.add(n.asset);
      if (n.type === "text") {
        if (n.font) usedFonts.add(n.font);
        families.add(n.family);
      }
      if (n.type === "group" && n.mask) visit(n.mask.nodes);
    }
  };
  visit(layers);

  const hrefs = new Map<string, string>();
  for (const id of used) {
    const asset = images.get(id);
    if (!asset) continue;
    hrefs.set(id, await blobToDataUrl(opts.embedImages === "display" ? await (await fetch(asset.url)).blob() : asset.blob));
  }

  const renderOpts: RenderOptions = {
    mode: "export",
    artboards: doc.artboards,
    clipArtboards: true,
    imageHref: (id) => hrefs.get(id),
  };
  let css = "";
  for (const id of usedFonts) {
    const f = fonts.get(id);
    if (f?.loadedName && f.data) {
      css += `@font-face{font-family:"${f.loadedName}";src:url(data:font/otf;base64,${bytesToBase64(f.data)});}\n`;
    }
  }
  const imports = [...families]
    .filter((f) => f && f !== "sans-serif")
    .map((f) => `@import url("https://fonts.googleapis.com/css2?family=${encodeURIComponent(f)}:wght@100..900&display=swap");`)
    .join("\n");

  const markup = renderToStaticMarkup(
    <svg
      xmlns="http://www.w3.org/2000/svg"
      xmlnsXlink="http://www.w3.org/1999/xlink"
      width={`${ab.width}pt`}
      height={`${ab.height}pt`}
      viewBox={`${ab.x} ${ab.y} ${ab.width} ${ab.height}`}
    >
      <title>{ab.name}</title>
      {css || imports ? <style dangerouslySetInnerHTML={{ __html: `<![CDATA[\n${imports}\n${css}]]>` }} /> : null}
      <RenderContext.Provider value={renderOpts}>
        {layers.map((l) => (
          <NodeView key={l.id} node={l} />
        ))}
      </RenderContext.Provider>
    </svg>,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n${markup}`;
}

/** Rasterises an artboard to PNG at the given scale (1 = 72 dpi). */
export async function artboardToPng(doc: Doc, index: number, pixelScale = 2): Promise<Blob> {
  const ab = doc.artboards[index];
  const svg = await artboardToSvg(doc, index, { embedImages: "full" });
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(ab.width * pixelScale);
    canvas.height = Math.round(ab.height * pixelScale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function saveBlob(blob: Blob, fileName: string) {
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      const ext = fileName.split(".").pop()!;
      const handle = await picker({
        suggestedName: fileName,
        types: [{ description: ext.toUpperCase(), accept: { [blob.type || "application/octet-stream"]: ["." + ext] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return;
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
