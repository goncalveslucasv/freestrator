// Compact text views of the scene for the model: an outline of the tree and plain SVG markup.

import { defaultName, nodeBBox, type BBox } from "../src/lib/geometry";
import { isIdentity, toSvg } from "../src/lib/matrix";
import { isReferenceLayer } from "../src/lib/reference";
import { transformSegs } from "../src/lib/svgImport";
import type { Doc, Paint, SceneNode, Seg } from "../src/lib/types";

const r = (n: number) => Math.round(n * 10) / 10;
export const bboxStr = (b: BBox | null) => (b ? `[${r(b.x)}, ${r(b.y)}, ${r(b.w)}×${r(b.h)}]` : "[vacío]");

const paintStr = (p: Paint | null) => (!p ? "none" : p.kind === "solid" ? p.color : `${p.kind}(${p.stops.map((s) => s.color).join("→")})`);

function countSegs(n: SceneNode): number {
  if (n.type === "path") return n.segs.length;
  if (n.type === "group") return n.children.reduce((a, c) => a + countSegs(c), 0);
  return 0;
}

/** One line per node, indented. Stops after `limit` lines. */
export function outline(nodes: SceneNode[], depth: number, limit = 400): string {
  const lines: string[] = [];
  let hidden = 0;
  const visit = (list: SceneNode[], level: number) => {
    for (let i = list.length - 1; i >= 0; i--) {
      // Topmost first, like the layers panel.
      const n = list[i];
      if (lines.length >= limit) {
        hidden++;
        continue;
      }
      const flags = [!n.visible && "oculto", n.locked && "bloqueado", n.opacity !== 1 && `opacidad ${+n.opacity.toFixed(2)}`, n.blend !== "normal" && n.blend]
        .filter(Boolean)
        .join(", ");
      let desc = `${"  ".repeat(level)}- ${n.id} ${n.type === "group" && n.role ? n.role === "layer" ? "capa" : "mesa" : n.type} "${n.name ?? defaultName(n)}" ${bboxStr(nodeBBox({ ...n, visible: true }))}`;
      if (n.type === "path") {
        desc += ` fill ${paintStr(n.fill)}`;
        if (n.stroke) desc += ` stroke ${paintStr(n.stroke)} ${r(n.strokeWidth)}pt`;
        desc += ` segs=${n.segs.length}`;
      } else if (n.type === "text") desc += ` "${n.text.slice(0, 60)}" ${n.family} ${r(n.fontSize)}pt fill ${paintStr(n.fill)}`;
      else if (n.type === "group") {
        desc += ` (${n.children.length} hijos, ${countSegs(n)} segs)`;
        if (n.clip) desc += " con recorte";
      }
      if (flags) desc += ` {${flags}}`;
      lines.push(desc);
      if (n.type === "group" && level < depth) visit(n.children, level + 1);
    }
  };
  visit(nodes, 0);
  if (hidden) lines.push(`… y ${hidden} nodos más (usá node_id o depth para acotar)`);
  return lines.join("\n");
}

export function docSummary(doc: Doc, extra: { editors: number; selection: string[]; referenceSource: string | null }): string {
  const ref = doc.layers.find(isReferenceLayer);
  const parts = [
    `Documento "${doc.name}". Unidades: pt, origen arriba a la izquierda, y hacia abajo.`,
    `Mesas de trabajo: ${doc.artboards.map((a, i) => `#${i} "${a.name}" x=${r(a.x)} y=${r(a.y)} ${r(a.width)}×${r(a.height)}`).join("; ")}`,
    ref ? `Referencia: ${bboxStr(nodeBBox({ ...ref, visible: true }))}${extra.referenceSource ? ` (${extra.referenceSource})` : ""}` : "Referencia: ninguna",
    `Editor conectado: ${extra.editors ? "sí" : "no"}${extra.selection.length ? ` · selección en el editor: ${extra.selection.join(", ")}` : ""}`,
  ];
  return parts.join("\n");
}

const fmt = (n: number, p: number) => +n.toFixed(p);

/** Plain SVG for the given nodes, transforms baked into the path data (document coordinates). */
export function nodesToSvg(nodes: SceneNode[], precision = 1): string {
  const attrs = (o: Record<string, string | number | undefined>) =>
    Object.entries(o)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "&quot;")}"`)
      .join("");
  const d = (segs: Seg[]) => segs.map((s) => s.c + s.p.map((v) => fmt(v, precision)).join(" ")).join("");
  const paint = (p: Paint | null) => (!p ? "none" : p.kind === "solid" ? p.color : (p.stops[0]?.color ?? "none"));
  const out: string[] = [];
  const visit = (n: SceneNode, ind: string) => {
    const common = { "data-id": n.id, "data-name": n.name, opacity: n.opacity !== 1 ? fmt(n.opacity, 3) : undefined, visibility: n.visible ? undefined : "hidden" };
    switch (n.type) {
      case "path":
        out.push(
          `${ind}<path${attrs({
            ...common,
            d: d(isIdentity(n.m) ? n.segs : transformSegs(n.segs, n.m)),
            fill: paint(n.fill),
            "fill-opacity": n.fillOpacity !== 1 ? fmt(n.fillOpacity, 3) : undefined,
            "fill-rule": n.fillRule !== "nonzero" ? n.fillRule : undefined,
            stroke: n.stroke ? paint(n.stroke) : undefined,
            "stroke-width": n.stroke ? fmt(n.strokeWidth, 2) : undefined,
            "stroke-linecap": n.stroke && n.lineCap !== "butt" ? n.lineCap : undefined,
            "stroke-linejoin": n.stroke && n.lineJoin !== "miter" ? n.lineJoin : undefined,
          })}/>`,
        );
        break;
      case "text":
        out.push(
          `${ind}<text${attrs({ ...common, transform: toSvg(n.m), "font-family": n.family, "font-size": fmt(n.fontSize, 2), "font-weight": n.weight !== 400 ? n.weight : undefined, fill: paint(n.fill), "text-anchor": n.align !== "start" ? n.align : undefined })}>${n.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`,
        );
        break;
      case "image":
        out.push(`${ind}<!-- imagen ${n.id} ${bboxStr(nodeBBox(n))} -->`);
        break;
      case "group":
        out.push(`${ind}<g${attrs(common)}>${n.clip ? " <!-- con máscara de recorte, omitida -->" : ""}`);
        for (const c of n.children) visit(c, ind + "  ");
        out.push(`${ind}</g>`);
    }
  };
  for (const n of nodes) visit(n, "");
  return out.join("\n");
}
