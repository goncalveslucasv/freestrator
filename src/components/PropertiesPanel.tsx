"use client";

import { useRef } from "react";
import {
  alignSelection,
  arrangeSelection,
  clipSelection,
  flipSelection,
  groupSelection,
  releaseClipSelection,
  rotateSelection,
  setSelectionBox,
  ungroupSelection,
  updateSelected,
} from "@/lib/actions";
import { ensureWebFont, fonts, images } from "@/lib/assets";
import { segsBBox, textLocalBBox } from "@/lib/geometry";
import { IDENTITY } from "@/lib/matrix";
import { getNodes, selectionBBox, topmostIds } from "@/lib/ops";
import { commit, useEditor } from "@/lib/store";
import type { BlendMode, Paint, SceneNode, TextNode } from "@/lib/types";
import { replaceImage } from "@/lib/imageReplace";
import { ColorField, NumberField, Section } from "./fields";

export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: "Normal",
  multiply: "Multiplicar",
  screen: "Trama",
  overlay: "Superponer",
  darken: "Oscurecer",
  lighten: "Aclarar",
  "color-dodge": "Sobreexponer color",
  "color-burn": "Subexponer color",
  "hard-light": "Luz fuerte",
  "soft-light": "Luz suave",
  difference: "Diferencia",
  exclusion: "Exclusión",
  hue: "Tono",
  saturation: "Saturación",
  color: "Color",
  luminosity: "Luminosidad",
};

const FONT_CHOICES = ["Inter", "Roboto", "Montserrat", "Poppins", "Playfair Display", "Lora", "Oswald", "Bebas Neue", "Syne", "Space Grotesk", "DM Sans", "Archivo"];

/** All leaves (non-group nodes) below the given nodes. */
function leaves(nodes: SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];
  const visit = (n: SceneNode) => (n.type === "group" ? n.children.forEach(visit) : out.push(n));
  nodes.forEach(visit);
  return out;
}

const same = <T,>(values: T[]): T | null => (values.length && values.every((v) => JSON.stringify(v) === JSON.stringify(values[0])) ? values[0] : null);

export function PropertiesPanel() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const activeArtboard = useEditor((s) => s.activeArtboard);
  useEditor((s) => s.metricsVersion);
  if (!doc) return null;
  const nodes = getNodes(doc, topmostIds(doc, selection));
  const ab = doc.artboards[activeArtboard] ?? doc.artboards[0];

  if (!nodes.length) {
    return (
      <div className="panel-scroll">
        <Section title="Documento">
          <div className="hint">Sin selección. Hacé clic en un objeto para editarlo, o doble clic para entrar a un grupo.</div>
          <div className="row">
            <NumberField label="An" value={ab.width} onChange={(v) => resizeArtboard(activeArtboard, { width: v })} suffix="pt" />
            <NumberField label="Al" value={ab.height} onChange={(v) => resizeArtboard(activeArtboard, { height: v })} suffix="pt" />
          </div>
          <div className="hint small">
            {doc.artboards.length} mesas de trabajo · {doc.layers.length} capas
          </div>
        </Section>
        <DefaultsSection />
      </div>
    );
  }

  const box = selectionBBox(doc, selection);
  const ls = leaves(nodes);
  const styled = ls.filter((n): n is Extract<SceneNode, { type: "path" | "text" }> => n.type === "path" || n.type === "text");
  const texts = ls.filter((n): n is TextNode => n.type === "text");
  const single = nodes.length === 1 ? nodes[0] : null;
  const opacity = same(nodes.map((n) => n.opacity));
  const blend = same(nodes.map((n) => n.blend));
  const fill = same(styled.map((n) => n.fill));
  const stroke = same(styled.map((n) => n.stroke));
  const strokeWidth = same(styled.filter((n) => n.stroke).map((n) => n.strokeWidth));

  const kind =
    nodes.length > 1
      ? `${nodes.length} objetos`
      : single!.type === "group"
        ? single!.clip
          ? "Grupo de recorte"
          : "Grupo"
        : { path: "Trazado", image: "Imagen", text: "Texto" }[single!.type];

  return (
    <div className="panel-scroll">
      <div className="panel-kind">{kind}</div>
      {box ? (
        <Section title="Transformar">
          <div className="row">
            <NumberField label="X" value={box.x - ab.x} onChange={(v) => setSelectionBox({ x: v + ab.x })} suffix="pt" />
            <NumberField label="Y" value={box.y - ab.y} onChange={(v) => setSelectionBox({ y: v + ab.y })} suffix="pt" />
          </div>
          <div className="row">
            <NumberField label="An" value={box.w} min={0.01} onChange={(v) => setSelectionBox({ w: v }, keepRatio())} suffix="pt" />
            <NumberField label="Al" value={box.h} min={0.01} onChange={(v) => setSelectionBox({ h: v }, keepRatio())} suffix="pt" />
          </div>
          <div className="row">
            <NumberField label="∠" value={0} onChange={(v) => v && rotateSelection(-v)} suffix="°" title="Rotar (grados, antihorario)" />
            <button className="btn icon" title="Reflejar horizontalmente" onClick={() => flipSelection("h")}>
              ⇋
            </button>
            <button className="btn icon" title="Reflejar verticalmente" onClick={() => flipSelection("v")}>
              ⇵
            </button>
          </div>
        </Section>
      ) : null}

      {single?.type === "text" || texts.length ? <TextSection texts={texts} /> : null}

      {styled.length ? (
        <Section title="Apariencia">
          <PaintRow label="Relleno" paint={fill} mixed={fill === null && styled.some((n) => n.fill)} onChange={(p) => updateSelected((n) => {
            if (n.type === "path" || n.type === "text") n.fill = p as typeof n.fill;
          }, true, "fill")} nodes={styled} />
          <PaintRow label="Trazo" paint={stroke} mixed={stroke === null && styled.some((n) => n.stroke)} onChange={(p) => updateSelected((n) => {
            if (n.type === "path" || n.type === "text") {
              n.stroke = p as typeof n.stroke;
              if (p && !n.strokeWidth) n.strokeWidth = 1;
            }
          }, true, "stroke")} nodes={styled} />
          {styled.some((n) => n.stroke) ? (
            <div className="row">
              <NumberField label="Grosor" value={strokeWidth} min={0} step={0.25} suffix="pt" onChange={(v) => updateSelected((n) => {
                if (n.type === "path" || n.type === "text") n.strokeWidth = v;
              }, true, "sw")} />
              <select
                className="select"
                title="Remate"
                value={same(styled.filter((n) => n.type === "path").map((n) => (n as { lineCap: string }).lineCap)) ?? ""}
                onChange={(e) => updateSelected((n) => {
                  if (n.type === "path") n.lineCap = e.target.value as typeof n.lineCap;
                })}
              >
                <option value="">Remate…</option>
                <option value="butt">Extremo plano</option>
                <option value="round">Redondeado</option>
                <option value="square">Proyectado</option>
              </select>
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section title="Transparencia">
        <div className="row">
          <select className="select" value={blend ?? ""} onChange={(e) => updateSelected((n) => void (n.blend = e.target.value as BlendMode), false)}>
            {blend === null ? <option value="">Mixto</option> : null}
            {Object.entries(BLEND_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <NumberField label="Opac." value={opacity === null ? null : opacity * 100} min={0} max={100} suffix="%" precision={0} onChange={(v) => updateSelected((n) => void (n.opacity = v / 100), false, "opacity")} />
        </div>
      </Section>

      {single?.type === "image" ? <ImageSection assetId={single.asset} /> : null}

      <Section title="Alinear">
        <div className="row align-row">
          {(
            [
              ["left", "⫷", "Alinear a la izquierda"],
              ["hcenter", "⫼", "Centrar horizontalmente"],
              ["right", "⫸", "Alinear a la derecha"],
              ["top", "⊤", "Alinear arriba"],
              ["vcenter", "⊝", "Centrar verticalmente"],
              ["bottom", "⊥", "Alinear abajo"],
            ] as const
          ).map(([mode, icon, title]) => (
            <button key={mode} className="btn icon" title={title + (nodes.length > 1 ? " (a la selección)" : " (a la mesa de trabajo)")} onClick={() => alignSelection(mode)}>
              {icon}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Organizar">
        <div className="row wrap">
          <button className="btn" onClick={() => arrangeSelection("front")} title="⇧⌘]">Al frente</button>
          <button className="btn" onClick={() => arrangeSelection("forward")} title="⌘]">Adelante</button>
          <button className="btn" onClick={() => arrangeSelection("backward")} title="⌘[">Atrás</button>
          <button className="btn" onClick={() => arrangeSelection("back")} title="⇧⌘[">Al fondo</button>
        </div>
        <div className="row wrap">
          <button className="btn" onClick={groupSelection} title="⌘G">Agrupar</button>
          <button className="btn" onClick={ungroupSelection} disabled={!nodes.some((n) => n.type === "group")} title="⇧⌘G">Desagrupar</button>
          <button className="btn" onClick={clipSelection} disabled={nodes.length < 2} title="⌘7">Crear máscara</button>
          <button className="btn" onClick={releaseClipSelection} disabled={!nodes.some((n) => n.type === "group" && n.clip)} title="⌥⌘7">Soltar máscara</button>
        </div>
      </Section>
    </div>
  );
}

let shiftHeld = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => (shiftHeld = e.shiftKey));
  window.addEventListener("keyup", (e) => (shiftHeld = e.shiftKey));
}
const keepRatio = () => shiftHeld;

function resizeArtboard(index: number, size: { width?: number; height?: number }) {
  commit((d) => {
    Object.assign(d.artboards[index], size);
  });
}

function PaintRow({
  label,
  paint,
  mixed,
  onChange,
  nodes,
}: {
  label: string;
  paint: Paint | null;
  mixed: boolean;
  onChange: (p: Paint | null) => void;
  nodes: SceneNode[];
}) {
  const toGradient = () => {
    // Horizontal gradient across the first node's local bounds.
    const n = nodes[0];
    const b = n.type === "path" ? segsBBox(n.segs, IDENTITY) : n.type === "text" ? textLocalBBox(n) : null;
    const base = paint?.kind === "solid" ? paint.color : "#ffffff";
    const x = b?.x ?? 0;
    const w = b?.w ?? 100;
    const y = (b?.y ?? 0) + (b?.h ?? 0) / 2;
    onChange({ kind: "linear", x1: x, y1: y, x2: x + w, y2: y, stops: [{ offset: 0, color: base }, { offset: 1, color: "#000000" }] });
  };
  return (
    <div className="paint-row">
      <div className="row">
        <span className="field-label wide">{label}</span>
        {mixed ? (
          <span className="mixed">Mixto</span>
        ) : paint === null ? (
          <span className="mixed">Ninguno</span>
        ) : paint.kind === "solid" ? (
          <ColorField value={paint.color} onChange={(c) => onChange({ kind: "solid", color: c })} />
        ) : (
          <span
            className="gradient-preview"
            style={{ background: `linear-gradient(90deg, ${paint.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(", ")})` }}
          />
        )}
        <span className="paint-buttons">
          <button className={`btn mini ${paint?.kind === "solid" ? "on" : ""}`} title="Color sólido" onClick={() => onChange({ kind: "solid", color: paint && paint.kind !== "solid" ? paint.stops[0].color : "#000000" })}>
            ■
          </button>
          <button className={`btn mini ${paint && paint.kind !== "solid" ? "on" : ""}`} title="Degradado" onClick={toGradient}>
            ◧
          </button>
          <button className={`btn mini ${paint === null && !mixed ? "on" : ""}`} title="Ninguno" onClick={() => onChange(null)}>
            ⧄
          </button>
        </span>
      </div>
      {paint && paint.kind !== "solid" ? (
        <div className="stops">
          <div className="row">
            <select
              className="select"
              value={paint.kind}
              onChange={(e) => {
                if (e.target.value === paint.kind) return;
                if (paint.kind === "linear") {
                  const cx = (paint.x1 + paint.x2) / 2;
                  const cy = (paint.y1 + paint.y2) / 2;
                  const r = Math.hypot(paint.x2 - paint.x1, paint.y2 - paint.y1) / 2;
                  onChange({ kind: "radial", stops: paint.stops, cx, cy, r, fx: cx, fy: cy, fr: 0, gt: paint.gt });
                } else {
                  onChange({ kind: "linear", stops: paint.stops, x1: paint.cx - paint.r, y1: paint.cy, x2: paint.cx + paint.r, y2: paint.cy, gt: paint.gt });
                }
              }}
            >
              <option value="linear">Lineal</option>
              <option value="radial">Radial</option>
            </select>
            <button className="btn" title="Invertir degradado" onClick={() => onChange({ ...paint, stops: paint.stops.map((s) => ({ ...s, offset: 1 - s.offset })).reverse() })}>
              Invertir
            </button>
          </div>
          {paint.stops.map((s, i) => (
            <div className="row" key={i}>
              <ColorField value={s.color} onChange={(c) => onChange({ ...paint, stops: paint.stops.map((x, k) => (k === i ? { ...x, color: c } : x)) })} />
              <NumberField value={s.offset * 100} min={0} max={100} precision={0} suffix="%" onChange={(v) => onChange({ ...paint, stops: paint.stops.map((x, k) => (k === i ? { ...x, offset: v / 100 } : x)).sort((a, b) => a.offset - b.offset) })} />
              <button className="btn mini" title="Quitar parada" disabled={paint.stops.length <= 2} onClick={() => onChange({ ...paint, stops: paint.stops.filter((_, k) => k !== i) })}>
                ×
              </button>
            </div>
          ))}
          <button
            className="btn"
            onClick={() => {
              const last = paint.stops.at(-1)!;
              const prev = paint.stops.at(-2) ?? last;
              const stops = [...paint.stops.slice(0, -1), { offset: (prev.offset + last.offset) / 2, color: prev.color }, last];
              onChange({ ...paint, stops });
            }}
          >
            + Parada
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TextSection({ texts }: { texts: TextNode[] }) {
  const t = texts[0];
  const size = same(texts.map((n) => n.fontSize));
  const spacing = same(texts.map((n) => n.letterSpacing));
  const docFonts = [...fonts.values()];
  const fontKey = (n: TextNode) => (n.font ? `font:${n.font}` : `family:${n.family}`);
  const current = same(texts.map(fontKey));
  const single = texts.length === 1;
  return (
    <Section title="Carácter">
      {single ? (
        <textarea
          className="text-content"
          value={t.text}
          rows={Math.min(6, t.text.split("\n").length + 1)}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) =>
            updateSelected((n) => {
              if (n.type !== "text") return;
              n.text = e.target.value;
              n.glyphs = undefined;
            }, true, "text")
          }
        />
      ) : null}
      <select
        className="select full"
        value={current ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          updateSelected((n) => {
            if (n.type !== "text") return;
            n.glyphs = undefined;
            if (v.startsWith("font:")) {
              const f = fonts.get(v.slice(5));
              n.font = f?.id;
              if (f) {
                n.family = f.family;
                n.weight = f.weight;
                n.italic = f.italic;
              }
            } else {
              n.font = undefined;
              n.family = v.slice(7);
            }
          });
          if (v.startsWith("family:")) ensureWebFont(v.slice(7));
        }}
      >
        {current === null ? <option value="">Mixto</option> : null}
        {docFonts.length ? (
          <optgroup label="Fuentes del documento">
            {docFonts.map((f) => (
              <option key={f.id} value={`font:${f.id}`}>
                {f.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        <optgroup label="Google Fonts">
          {[...new Set([...docFonts.map((f) => f.family), ...FONT_CHOICES, ...texts.filter((n) => !n.font).map((n) => n.family)])].map((f) => (
            <option key={f} value={`family:${f}`}>
              {f}
            </option>
          ))}
        </optgroup>
      </select>
      <div className="row">
        <NumberField
          label="Tam."
          value={size}
          min={0.5}
          step={1}
          suffix="pt"
          onChange={(v) =>
            updateSelected((n) => {
              if (n.type !== "text") return;
              const k = v / n.fontSize;
              n.fontSize = v;
              n.letterSpacing *= k;
              if (n.glyphs) n.glyphs.xs = n.glyphs.xs.map((x) => x * k);
            }, true, "fontsize")
          }
        />
        <NumberField
          label="Track."
          value={spacing}
          step={0.1}
          suffix="pt"
          onChange={(v) =>
            updateSelected((n) => {
              if (n.type !== "text") return;
              const delta = v - n.letterSpacing;
              n.letterSpacing = v;
              if (n.glyphs) n.glyphs.xs = n.glyphs.xs.map((x, i) => x + delta * i);
            }, true, "tracking")
          }
        />
      </div>
      {!texts.some((n) => n.font && fonts.get(n.font)?.loadedName) ? (
        <div className="row">
          <select className="select" value={same(texts.map((n) => n.weight)) ?? ""} onChange={(e) => updateSelected((n) => {
            if (n.type === "text") n.weight = Number(e.target.value);
          })}>
            {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
              <option key={w} value={w}>
                Peso {w}
              </option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={texts.every((n) => n.italic)} onChange={(e) => updateSelected((n) => {
              if (n.type === "text") n.italic = e.target.checked;
            })} />
            Cursiva
          </label>
        </div>
      ) : null}
      {texts.some((n) => n.glyphs) ? <div className="hint small">Texto original del archivo: se conserva el espaciado exacto hasta que lo edites.</div> : null}
    </Section>
  );
}

function ImageSection({ assetId }: { assetId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const asset = images.get(assetId);
  return (
    <Section title="Imagen">
      {asset ? (
        <div className="hint small">
          {asset.width} × {asset.height} px {asset.hasAlpha ? "· con transparencia" : ""}
        </div>
      ) : null}
      <button className="btn" onClick={() => input.current?.click()}>
        Reemplazar imagen…
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          await replaceImage(file);
        }}
      />
    </Section>
  );
}

function DefaultsSection() {
  const fill = useEditor((s) => s.defaultFill);
  const stroke = useEditor((s) => s.defaultStroke);
  const width = useEditor((s) => s.defaultStrokeWidth);
  return (
    <Section title="Estilo para objetos nuevos">
      <PaintRow label="Relleno" paint={fill} mixed={false} nodes={[]} onChange={(p) => useEditor.setState({ defaultFill: p?.kind === "solid" ? p : p ? { kind: "solid", color: p.stops[0].color } : null })} />
      <PaintRow label="Trazo" paint={stroke} mixed={false} nodes={[]} onChange={(p) => useEditor.setState({ defaultStroke: p?.kind === "solid" ? p : p ? { kind: "solid", color: p.stops[0].color } : null })} />
      <div className="row">
        <NumberField label="Grosor" value={width} min={0} step={0.25} suffix="pt" onChange={(v) => useEditor.setState({ defaultStrokeWidth: v })} />
      </div>
    </Section>
  );
}
