// Freestrator MCP server: lets Claude draw, vectorise a reference photo and check its work.
// Run with `npm run mcp` (stdio). See mcp/README.md.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { z } from "zod";
import { images } from "../src/lib/assets";
import { exportPdf } from "../src/lib/exportPdf";
import { artboardToSvg } from "../src/lib/exportSvg";
import { newId, nodeBBox, nodesBBox, transformNode, type BBox } from "../src/lib/geometry";
import { emptyDoc } from "../src/lib/importer";
import { mul, scale, translate } from "../src/lib/matrix";
import { arrange, deleteNodes, ensureSublayer, getNodes, groupNodes, locate, topmostIds, ungroupNodes } from "../src/lib/ops";
import { drawingLayer, isReferenceLayer, placeReference } from "../src/lib/reference";
import { BRIDGE_PORT } from "../src/lib/sync";
import { parseColor, parsePathData, parseTransform, svgToNodes, type XmlNode } from "../src/lib/svgImport";
import type { Doc, GroupNode, SceneNode } from "../src/lib/types";
import { recognizeLines, vectorizeRaster, type Detail, type OcrLine } from "../src/lib/vectorize";
import { selectInEditor, startBridge } from "./bridge";
import { bboxStr, docSummary, nodesToSvg, outline } from "./describe";
import { log } from "./log";
import { compareRasters, referenceBBox, referenceOnly, renderPair, renderRegion, toPng } from "./raster";
import { session, withoutReference } from "./session";

const INSTRUCTIONS = `Freestrator es un editor vectorial (tipo Illustrator). Estas tools editan el documento abierto; si el editor web (https://freestrator.vercel.app, menú Claude › Conectar con Claude) está conectado, los cambios se ven en vivo y get_document muestra lo que el usuario seleccionó ahí.

Sistema de coordenadas: puntos (pt), origen arriba a la izquierda de la mesa de trabajo #0, y hacia abajo.

Flujo recomendado para replicar una imagen:
1. set_reference con la ruta (o URL) de la foto. Ajusta la mesa de trabajo a la proporción de la foto. Si el usuario colocó la foto desde el editor (Claude › Colocar imagen de referencia), ya está.
2. Elegí el enfoque:
   - Empezá casi siempre con vectorize (determinista: paleta automática sin halos, formas exactas, ocr=true para texto editable). Ajustá detail o pasá "palette" si hace falta.
   - Para logos o íconos que tienen que quedar perfectos, corregí o redibujá piezas con add_svg (formas exactas, curvas limpias).
3. compare: devuelve [referencia | tu render | mapa de error] y las celdas con más error (con el color esperado vs el obtenido). Corregí esas zonas y volvé a comparar.
4. Limpieza: get_svg para leer trazados, add_svg con replace_id para reemplazar formas, update_nodes para colores/nombres, group_nodes para organizar. Poné nombres descriptivos ("ojo izquierdo", "fondo").
5. save en .ai (la referencia no se exporta).

Todo es deshacible con undo.`;

const server = new McpServer({ name: "freestrator", version: process.env.FREESTRATOR_MCP_VERSION ?? "dev" }, { instructions: INSTRUCTIONS });

// ---------- helpers ----------

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });
const image = (png: Buffer, caption: string): CallToolResult => ({
  content: [
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    { type: "text", text: caption },
  ],
});

/** Runs a tool body, turning exceptions into tool errors the model can read. */
function tool<A>(fn: (args: A) => Promise<CallToolResult> | CallToolResult) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      log(err);
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  };
}

const expandPath = (p: string) => {
  const home = p.startsWith("~") ? homedir() + p.slice(1) : p;
  return isAbsolute(home) ? home : resolve(process.cwd(), home);
};

const regionSchema = z
  .object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() })
  .describe("Región en coordenadas del documento (pt)");

function artboardBBox(doc: Doc, i = 0): BBox {
  const ab = doc.artboards[i] ?? doc.artboards[0];
  return { x: ab.x, y: ab.y, w: ab.width, h: ab.height };
}

function requireNode(doc: Doc, id: string) {
  const loc = locate(doc, id);
  if (!loc) throw new Error(`No existe el nodo ${id}. Usá get_document para ver los ids.`);
  return loc;
}

const paintFrom = (v: string | null) => {
  if (v === null || v === "none") return null;
  const c = parseColor(v);
  if (!c) throw new Error(`Color inválido: ${v}`);
  return { paint: { kind: "solid" as const, color: c.color }, alpha: c.alpha };
};

function parseSvg(markup: string): XmlNode {
  const src = /^\s*(<\?xml[^>]*>\s*)?(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(markup)
    ? markup
    : `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${markup}</svg>`;
  const errors: string[] = [];
  const dom = new DOMParser({
    onError: (level, msg) => {
      if (level !== "warning") errors.push(msg);
    },
  }).parseFromString(src, "image/svg+xml");
  if (errors.length || !dom.documentElement) throw new Error(`SVG inválido: ${errors[0] ?? "documento vacío"}`);
  return dom.documentElement as unknown as XmlNode;
}

// ---------- document ----------

server.registerTool(
  "get_document",
  {
    title: "Ver documento",
    description:
      "Resumen del documento: mesas de trabajo, referencia, selección en el editor y el árbol de capas/objetos (ids, tipo, nombre, [x, y, ancho×alto], relleno, trazo). Los objetos de más arriba se listan primero.",
    inputSchema: {
      node_id: z.string().optional().describe("Mostrar solo este nodo y sus hijos"),
      depth: z.number().int().min(0).max(20).default(4).describe("Niveles de grupos a expandir"),
    },
  },
  tool(({ node_id, depth }: { node_id?: string; depth: number }) => {
    const doc = session.doc;
    const roots = node_id ? [requireNode(doc, node_id).node] : doc.layers;
    return text(`${docSummary(doc, session)}\n\n${outline(roots, depth)}`);
  }),
);

server.registerTool(
  "new_document",
  {
    title: "Documento nuevo",
    description: "Reemplaza el documento por uno vacío con una mesa de trabajo del tamaño indicado (pt).",
    inputSchema: {
      width: z.number().positive().default(1000),
      height: z.number().positive().default(1000),
      name: z.string().default("Sin título"),
    },
  },
  tool(({ width, height, name }: { width: number; height: number; name: string }) => {
    const doc = emptyDoc(width, height);
    doc.name = name;
    session.setDoc(doc, "claude", "Documento nuevo");
    session.referenceSource = null;
    return text(`Documento nuevo "${name}" de ${width}×${height} pt.`);
  }),
);

// ---------- reference ----------

server.registerTool(
  "set_reference",
  {
    title: "Colocar foto de referencia",
    description:
      "Carga una imagen (ruta local o URL http/https) como referencia en una capa bloqueada al fondo, que no se exporta. Por defecto adapta la mesa de trabajo #0 a la proporción de la imagen. Devuelve una vista previa.",
    inputSchema: {
      source: z.string().describe("Ruta absoluta del archivo (PNG, JPEG, WebP, GIF, TIFF, AVIF) o URL"),
      opacity: z.number().min(0).max(1).default(0.35).describe("Opacidad de la capa de referencia en el editor"),
      resize_artboard: z.boolean().default(true),
      long_side: z.number().positive().default(1000).describe("Lado largo de la mesa de trabajo al adaptarla (pt)"),
    },
  },
  tool(async ({ source, opacity, resize_artboard, long_side }: { source: string; opacity: number; resize_artboard: boolean; long_side: number }) => {
    let input: Buffer;
    if (/^https?:\/\//i.test(source)) {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`No se pudo descargar la imagen (${res.status})`);
      input = Buffer.from(await res.arrayBuffer());
    } else {
      input = await readFile(expandPath(source));
    }
    // Upright, capped at 2048 px: plenty for tracing and light to sync.
    const pipeline = sharp(input).rotate().resize(2048, 2048, { fit: "inside", withoutEnlargement: true });
    const meta = await sharp(input).metadata();
    const hasAlpha = !!meta.hasAlpha;
    const { data, info } = await (hasAlpha ? pipeline.png() : pipeline.jpeg({ quality: 92 })).toBuffer({ resolveWithObject: true });
    const id = newId("img");
    const blob = new Blob([new Uint8Array(data)], { type: hasAlpha ? "image/png" : "image/jpeg" });
    images.set(id, { id, blob, url: URL.createObjectURL(blob), width: info.width, height: info.height, hasAlpha });

    session.mutate("Colocar referencia", (d) => {
      placeReference(d, id, info.width, info.height, { opacity, resizeArtboard: resize_artboard ? long_side : false });
    });
    session.referenceSource = source;
    const ab = session.doc.artboards[0];
    const preview = await sharp(data).resize(768, 768, { fit: "inside" }).png().toBuffer();
    return image(
      preview,
      `Referencia cargada (${info.width}×${info.height} px). Mesa de trabajo #0: ${ab.width}×${ab.height} pt; la imagen ocupa ${bboxStr(referenceBBox(session.doc))}.`,
    );
  }),
);

// ---------- drawing ----------

server.registerTool(
  "add_svg",
  {
    title: "Dibujar con SVG",
    description: `Agrega formas escritas en SVG. Soporta path (todos los comandos, incluidos arcos), rect (rx/ry), circle, ellipse, line, polyline, polygon, g, text/tspan, use, linearGradient/radialGradient, clip-path, transform, opacity, mix-blend-mode, style="" y reglas <style> simples.
Las coordenadas son del documento (pt). Si el SVG raíz tiene viewBox, ese viewBox se ajusta a la mesa de trabajo #0.
Usá data-name o id para nombrar los objetos. Los grupos <g> se conservan como grupos.
Con replace_id, el contenido reemplaza a ese nodo en la misma posición de apilamiento; con parent_id se agrega dentro de ese grupo (arriba de todo).`,
    inputSchema: {
      svg: z.string().describe("Fragmento SVG (<path .../><circle .../>…) o documento <svg> completo"),
      parent_id: z.string().optional(),
      replace_id: z.string().optional(),
    },
  },
  tool(({ svg, parent_id, replace_id }: { svg: string; parent_id?: string; replace_id?: string }) => {
    const ab = session.doc.artboards[0];
    const root = parseSvg(svg);
    const { nodes, warnings, viewBox } = svgToNodes(root, { viewport: { width: ab.width, height: ab.height } });
    if (!nodes.length) throw new Error(`El SVG no produjo ninguna forma.${warnings.length ? " " + warnings.join(" ") : ""}`);
    if (viewBox && (viewBox.x !== ab.x || viewBox.y !== ab.y || viewBox.width !== ab.width || viewBox.height !== ab.height)) {
      const k = Math.min(ab.width / viewBox.width, ab.height / viewBox.height);
      const D = mul(translate(ab.x + (ab.width - viewBox.width * k) / 2, ab.y + (ab.height - viewBox.height * k) / 2), mul(scale(k), translate(-viewBox.x, -viewBox.y)));
      for (const n of nodes) transformNode(n, D);
    }
    session.mutate("Dibujar SVG", (d) => {
      if (replace_id) {
        const loc = requireNode(d, replace_id);
        loc.list.splice(loc.index, 1, ...nodes);
      } else if (parent_id) {
        const parent = requireNode(d, parent_id).node;
        if (parent.type !== "group") throw new Error(`${parent_id} no es un grupo.`);
        parent.children.push(...nodes);
      } else {
        ensureSublayer(d, drawingLayer(d), 0).children.push(...nodes);
      }
    });
    selectInEditor(nodes.map((n) => n.id));
    const list = nodes.map((n) => `- ${n.id} ${n.type} "${n.name ?? ""}" ${bboxStr(nodeBBox(n))}`).join("\n");
    return text(`Agregados ${nodes.length} objeto(s):\n${list}${warnings.length ? `\nAvisos:\n- ${warnings.join("\n- ")}` : ""}`);
  }),
);

const updateSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  fill: z.string().nullable().optional().describe('Color CSS o "none"/null. En grupos se aplica a todos los objetos de adentro'),
  stroke: z.string().nullable().optional(),
  stroke_width: z.number().min(0).optional(),
  opacity: z.number().min(0).max(1).optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  d: z.string().optional().describe("Nuevos datos de trazado (solo path), en coordenadas del documento"),
  transform: z.string().optional().describe('Transformación SVG aplicada en coordenadas del documento, p. ej. "translate(10 0)" o "rotate(15 200 200)"'),
  text: z.string().optional().describe("Nuevo contenido (solo text)"),
  font_size: z.number().positive().optional(),
  font_family: z.string().optional(),
});

server.registerTool(
  "update_nodes",
  {
    title: "Modificar objetos",
    description: "Cambia propiedades de uno o más objetos: nombre, relleno, trazo, opacidad, visibilidad, bloqueo, trazado (d), transformación, texto.",
    inputSchema: { updates: z.array(updateSchema).min(1) },
  },
  tool(({ updates }: { updates: z.infer<typeof updateSchema>[] }) => {
    session.mutate("Modificar objetos", (d) => {
      for (const u of updates) {
        const node = requireNode(d, u.id).node;
        if (u.name !== undefined) node.name = u.name;
        if (u.opacity !== undefined) node.opacity = u.opacity;
        if (u.visible !== undefined) node.visible = u.visible;
        if (u.locked !== undefined) node.locked = u.locked;
        const leaves = (n: SceneNode): SceneNode[] => (n.type === "group" ? n.children.flatMap(leaves) : [n]);
        for (const leaf of leaves(node)) {
          if (leaf.type !== "path" && leaf.type !== "text") continue;
          if (u.fill !== undefined) {
            const p = paintFrom(u.fill);
            leaf.fill = p?.paint ?? null;
            if (p) leaf.fillOpacity = p.alpha;
          }
          if (u.stroke !== undefined) {
            const p = paintFrom(u.stroke);
            leaf.stroke = p?.paint ?? null;
            if (p) leaf.strokeOpacity = p.alpha;
          }
          if (u.stroke_width !== undefined) leaf.strokeWidth = u.stroke_width;
        }
        if (u.d !== undefined) {
          if (node.type !== "path") throw new Error(`${u.id} no es un trazado.`);
          node.segs = parsePathData(u.d);
          node.m = [1, 0, 0, 1, 0, 0];
        }
        if (node.type === "text") {
          if (u.text !== undefined) {
            node.text = u.text;
            delete node.glyphs;
          }
          if (u.font_size !== undefined) node.fontSize = u.font_size;
          if (u.font_family !== undefined) {
            node.family = u.font_family;
            delete node.font;
            delete node.glyphs;
          }
        }
        if (u.transform) transformNode(node, parseTransform(u.transform));
      }
    });
    return text(`Actualizados ${updates.length} objeto(s).`);
  }),
);

server.registerTool(
  "delete_nodes",
  {
    title: "Eliminar objetos",
    description: "Elimina objetos por id.",
    inputSchema: { ids: z.array(z.string()).min(1) },
  },
  tool(({ ids }: { ids: string[] }) => {
    const missing = ids.filter((id) => !locate(session.doc, id));
    session.mutate("Eliminar", (d) => deleteNodes(d, ids));
    return text(`Eliminados ${ids.length - missing.length} objeto(s).${missing.length ? ` No encontrados: ${missing.join(", ")}` : ""}`);
  }),
);

server.registerTool(
  "group_nodes",
  {
    title: "Agrupar / desagrupar",
    description: "Agrupa objetos (quedan en la posición del de más arriba) o desarma grupos.",
    inputSchema: {
      ids: z.array(z.string()).min(1),
      ungroup: z.boolean().default(false),
      name: z.string().optional().describe("Nombre del grupo nuevo"),
    },
  },
  tool(({ ids, ungroup, name }: { ids: string[]; ungroup: boolean; name?: string }) => {
    if (ungroup) {
      const out = session.mutate("Desagrupar", (d) => ungroupNodes(d, ids));
      return text(`Desagrupado. Objetos sueltos: ${out.join(", ")}`);
    }
    const id = session.mutate("Agrupar", (d) => groupNodes(d, ids, name ? { name } : {}));
    if (!id) throw new Error("No se pudo agrupar (¿ids inexistentes o en capas distintas?).");
    return text(`Grupo creado: ${id}`);
  }),
);

server.registerTool(
  "arrange_nodes",
  {
    title: "Ordenar",
    description: "Cambia el orden de apilamiento dentro de su grupo/capa.",
    inputSchema: {
      ids: z.array(z.string()).min(1),
      mode: z.enum(["front", "forward", "backward", "back"]),
    },
  },
  tool(({ ids, mode }: { ids: string[]; mode: "front" | "forward" | "backward" | "back" }) => {
    session.mutate("Ordenar", (d) => arrange(d, ids, mode));
    return text("Listo.");
  }),
);

server.registerTool(
  "get_svg",
  {
    title: "Leer como SVG",
    description:
      "Devuelve objetos como SVG con las transformaciones aplicadas (coordenadas del documento) y data-id en cada elemento. Útil para leer trazados y reescribirlos con add_svg + replace_id.",
    inputSchema: {
      ids: z.array(z.string()).optional().describe("Por defecto, todo menos la referencia"),
      precision: z.number().int().min(0).max(4).default(1).describe("Decimales"),
      max_chars: z.number().int().positive().default(30000),
    },
  },
  tool(({ ids, precision, max_chars }: { ids?: string[]; precision: number; max_chars: number }) => {
    const doc = session.doc;
    const nodes = ids ? getNodes(doc, topmostIds(doc, ids)) : withoutReference(doc).layers;
    let svg = nodesToSvg(nodes, precision);
    if (svg.length > max_chars) svg = `${svg.slice(0, max_chars)}\n<!-- recortado: ${svg.length - max_chars} caracteres más; pedí ids concretos -->`;
    return text(svg);
  }),
);

// ---------- vectorising ----------

server.registerTool(
  "vectorize",
  {
    title: "Vectorizar referencia",
    description: `Vectoriza la imagen de referencia (o una región) de forma determinista: paleta automática que ignora el antialiasing, limpieza de manchas, una forma por región (con huecos rellenos y apiladas según anidamiento), rectángulos/elipses/rectángulos redondeados exactos y, con ocr=true, texto real editable. Crea un grupo "Vectorizado" arriba de todo en la capa de dibujo.
Consejos: detail="low" para logos e íconos simples, "high" para ilustraciones con detalle. Si la paleta automática se queda corta o mezcla colores, pasá "palette". Para un área con mucho detalle, usá region + replace_previous=false.`,
    inputSchema: {
      detail: z.enum(["low", "medium", "high"]).default("medium"),
      max_colors: z.number().int().min(2).max(64).optional().describe("Tope de la paleta automática (por defecto según detail)"),
      palette: z.array(z.string()).max(64).optional().describe("Paleta exacta (colores CSS); reemplaza la automática"),
      fit_shapes: z.boolean().default(true).describe("Reemplazar contornos que son rectángulos, rectángulos redondeados o elipses por figuras exactas"),
      ocr: z.boolean().default(false).describe("Detectar texto y crearlo como texto editable (la primera vez descarga ~10 MB de datos de idioma)"),
      skip_background: z.boolean().default(false).describe("Omitir el color que ocupa el borde de la imagen (fondo)"),
      region: regionSchema.optional().describe("Por defecto, toda la referencia"),
      resolution: z.number().int().min(100).max(3000).default(1200).describe("Lado largo, en px, de la imagen que se analiza"),
      replace_previous: z.boolean().default(true).describe('Borrar grupos "Vectorizado" anteriores'),
    },
  },
  tool(async (a: {
    detail: Detail;
    max_colors?: number;
    palette?: string[];
    fit_shapes: boolean;
    ocr: boolean;
    skip_background: boolean;
    region?: BBox;
    resolution: number;
    replace_previous: boolean;
  }) => {
    const ref = referenceOnly(session.doc);
    const refBox = referenceBBox(session.doc);
    if (!ref || !refBox) throw new Error("No hay imagen de referencia. Usá set_reference primero.");
    const region = a.region ?? refBox;
    const t0 = Date.now();
    const raster = await renderRegion(ref, region, a.resolution);
    let ocrLines: OcrLine[] | undefined;
    if (a.ocr) {
      // Small text needs more pixels than the shapes do.
      const big = await renderRegion(ref, region, Math.min(3200, Math.max(2400, a.resolution * 2)));
      const cachePath = join(homedir(), ".cache", "freestrator", "tesseract");
      await mkdir(cachePath, { recursive: true });
      ocrLines = await recognizeLines(
        await toPng(big),
        { scaleX: region.w / big.width, scaleY: region.h / big.height, offsetX: region.x, offsetY: region.y },
        { cachePath },
      );
    }
    const palette = a.palette?.map((c) => {
      const p = parseColor(c);
      if (!p) throw new Error(`Color inválido en palette: ${c}`);
      return p.color;
    });
    const { group, report } = await vectorizeRaster(raster, region, {
      detail: a.detail,
      maxColors: a.max_colors,
      palette,
      fitShapes: a.fit_shapes,
      skipBackground: a.skip_background,
      ocr: ocrLines,
    });
    session.mutate("Vectorizar", (d) => {
      if (a.replace_previous) {
        const old: string[] = [];
        for (const layer of d.layers) {
          if (isReferenceLayer(layer)) continue;
          const visit = (g: GroupNode) => {
            for (const c of g.children) {
              if (c.type !== "group") continue;
              if (c.name === "Vectorizado") old.push(c.id);
              else visit(c);
            }
          };
          visit(layer);
        }
        deleteNodes(d, old);
      }
      ensureSublayer(d, drawingLayer(d), 0).children.push(group);
    });
    selectInEditor([group.id]);

    const { art, photo } = await renderPair(session.doc, region, 300);
    const cmp = await compareRasters(art, photo);
    const prims = Object.entries(report.primitives).map(([k, v]) => `${v} ${k}`).join(", ");
    return text(
      `Grupo ${group.id} "Vectorizado": ${report.shapes} formas${prims ? ` (exactas: ${prims})` : ""}, ${report.segments} segmentos` +
        `${a.ocr ? `, ${report.texts} líneas de texto` : ""} (${Date.now() - t0} ms).\n` +
        `Paleta: ${report.palette.map((p) => `${p.color} ${p.share}%`).join(", ")}\n` +
        `Parecido con la referencia: ΔE medio ${cmp.meanDeltaE}, ${cmp.matchPercent}% de píxeles coinciden. Usá compare para ver el detalle.`,
    );
  }),
);

// ---------- seeing ----------

server.registerTool(
  "render",
  {
    title: "Ver render",
    description: "Renderiza el documento (o una región) a PNG para ver cómo quedó. Por defecto sin la referencia.",
    inputSchema: {
      region: regionSchema.optional().describe("Por defecto, la mesa de trabajo"),
      artboard: z.number().int().min(0).default(0),
      max_size: z.number().int().min(64).max(2048).default(1024).describe("Lado largo en px"),
      show_reference: z.boolean().default(false),
    },
  },
  tool(async ({ region, artboard, max_size, show_reference }: { region?: BBox; artboard: number; max_size: number; show_reference: boolean }) => {
    const doc = show_reference ? session.doc : withoutReference(session.doc);
    const box = region ?? artboardBBox(doc, artboard);
    const r = await renderRegion(doc, box, max_size, artboard);
    return image(await toPng(r), `Región ${bboxStr(box)} a ${r.width}×${r.height} px (${(r.width / box.w).toFixed(2)} px/pt).`);
  }),
);

server.registerTool(
  "compare",
  {
    title: "Comparar con la referencia",
    description:
      "Compara el dibujo con la foto de referencia. Devuelve una imagen [referencia | dibujo | mapa de error en rojo], el ΔE medio (0 = idéntico; <5 muy parecido; >20 muy distinto), el % de píxeles que coinciden y las celdas con más error, con su región, el color esperado y el obtenido.",
    inputSchema: {
      region: regionSchema.optional().describe("Por defecto, toda la referencia"),
      max_size: z.number().int().min(64).max(1024).default(400).describe("Lado largo de cada panel en px"),
      grid: z.number().int().min(2).max(24).default(8),
    },
  },
  tool(async ({ region, max_size, grid }: { region?: BBox; max_size: number; grid: number }) => {
    const box = region ?? referenceBBox(session.doc);
    if (!box) throw new Error("No hay imagen de referencia. Usá set_reference primero.");
    const { art, photo } = await renderPair(session.doc, box, max_size);
    const cmp = await compareRasters(art, photo, grid);
    const worst = cmp.worst.map((c) => `- [${c.x}, ${c.y}, ${c.w}×${c.h}] ΔE ${c.deltaE}: esperado ${c.expected}, obtenido ${c.got}`).join("\n");
    return image(cmp.image, `ΔE medio ${cmp.meanDeltaE} · ${cmp.matchPercent}% de píxeles coinciden.\nZonas con más error:\n${worst}`);
  }),
);

// ---------- history & files ----------

server.registerTool(
  "undo",
  {
    title: "Deshacer",
    description: "Deshace los últimos cambios (de Claude o del editor).",
    inputSchema: { steps: z.number().int().min(1).max(50).default(1) },
  },
  tool(({ steps }: { steps: number }) => text(`Deshechos ${session.undo(steps)} paso(s).`)),
);

server.registerTool(
  "save",
  {
    title: "Guardar",
    description: "Guarda el documento. El formato sale de la extensión: .ai (Illustrator, compatible con PDF), .pdf, .svg o .png (mesa de trabajo #0 a 300 ppp). La referencia no se incluye.",
    inputSchema: {
      path: z.string().describe("Ruta del archivo (absoluta recomendada; ~ se expande)"),
      artboard: z.number().int().min(0).default(0).describe("Para .svg y .png"),
    },
  },
  tool(async ({ path, artboard }: { path: string; artboard: number }) => {
    const file = expandPath(path);
    const ext = extname(file).toLowerCase();
    const doc = withoutReference(session.doc);
    if (ext === ".ai" || ext === ".pdf") await writeFile(file, await exportPdf(doc));
    else if (ext === ".svg") await writeFile(file, await artboardToSvg(doc, artboard));
    else if (ext === ".png") {
      const ab = artboardBBox(doc, artboard);
      await writeFile(file, await toPng(await renderRegion(doc, ab, Math.round((Math.max(ab.w, ab.h) * 300) / 72), artboard)));
    } else throw new Error("Extensión no soportada: usá .ai, .pdf, .svg o .png");
    const box = nodesBBox(doc.layers);
    return text(`Guardado en ${file}${box ? ` (contenido ${bboxStr(box)})` : ""}.`);
  }),
);

// ---------- start ----------

startBridge(Number(process.env.FREESTRATOR_BRIDGE_PORT) || BRIDGE_PORT);
server.connect(new StdioServerTransport()).then(
  () => log("Servidor MCP listo (stdio)"),
  (err) => {
    log(err);
    process.exit(1);
  },
);
