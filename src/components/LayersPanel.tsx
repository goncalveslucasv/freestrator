"use client";

import { useMemo, useState } from "react";
import { defaultName, newId } from "@/lib/geometry";
import { locate, moveNode } from "@/lib/ops";
import { commit, requestFit, select, useEditor } from "@/lib/store";
import type { Doc, GroupNode, SceneNode } from "@/lib/types";

const Eye = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 24 24" width="14" height="14" style={{ opacity: on ? 1 : 0.25 }}>
    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="12" cy="12" r="3" fill="currentColor" />
  </svg>
);
const Lock = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 24 24" width="13" height="13" style={{ opacity: on ? 1 : 0.15 }}>
    <rect x="5" y="11" width="14" height="9" rx="1.5" fill="currentColor" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2" />
  </svg>
);

function kindIcon(n: SceneNode) {
  if (n.type === "group") return n.role === "artboard" ? "▭" : n.clip ? "◩" : "❒";
  return { path: "✎", image: "🖼", text: "T" }[n.type];
}

export function LayersPanel() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const activeLayer = useEditor((s) => s.activeLayer);
  const activeArtboard = useEditor((s) => s.activeArtboard);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: "above" | "below" | "inside" } | null>(null);

  // Ancestors of the selection are always shown expanded.
  const forced = useMemo(() => {
    const set = new Set<string>();
    if (!doc) return set;
    for (const id of selection) locate(doc, id)?.path.forEach((p) => set.add(p.id));
    return set;
  }, [doc, selection]);

  if (!doc) return null;
  const isOpen = (n: GroupNode) => {
    if (forced.has(n.id) || expanded.has(n.id)) return true;
    if (collapsed.has(n.id)) return false;
    if (n.role === "artboard") return n.artboard === activeArtboard;
    return n.role === "layer" && n.expanded !== false;
  };

  const toggle = (n: GroupNode) => {
    const open = isOpen(n);
    setExpanded((s) => {
      const next = new Set(s);
      if (open) next.delete(n.id);
      else next.add(n.id);
      return next;
    });
    setCollapsed((s) => {
      const next = new Set(s);
      if (open) next.add(n.id);
      else next.delete(n.id);
      return next;
    });
  };

  const setFlag = (id: string, key: "visible" | "locked", value: boolean) =>
    commit((d) => {
      const loc = locate(d as Doc, id);
      if (loc) loc.node[key] = value;
    });

  const rows: React.ReactNode[] = [];
  const renderNode = (n: SceneNode, depth: number, layer: GroupNode) => {
    const isGroup = n.type === "group";
    const open = isGroup && isOpen(n as GroupNode);
    const selected = selection.includes(n.id);
    const isLayer = isGroup && (n as GroupNode).role === "layer";
    rows.push(
      <div
        key={n.id}
        className={`layer-row ${selected ? "selected" : ""} ${isLayer ? "is-layer" : ""} ${isLayer && activeLayer === n.id ? "active-layer" : ""} ${drop?.id === n.id ? "drop-" + drop.pos : ""}`}
        style={{ paddingLeft: 4 + depth * 14 }}
        draggable={renaming !== n.id}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/x-node", n.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("text/x-node")) return;
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const t = (e.clientY - r.top) / r.height;
          const pos = isGroup && t > 0.3 && t < 0.7 && !isLayer ? "inside" : t < 0.5 ? "above" : "below";
          setDrop({ id: n.id, pos });
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={(e) => {
          e.preventDefault();
          const src = e.dataTransfer.getData("text/x-node");
          const target = drop;
          setDrop(null);
          if (src && target) commit((d) => moveNode(d as Doc, src, target.id, target.pos));
        }}
        onClick={(e) => {
          if (isLayer) {
            useEditor.setState({ activeLayer: n.id });
            return;
          }
          if (isGroup && (n as GroupNode).role === "artboard") {
            requestFit((n as GroupNode).artboard ?? 0);
            return;
          }
          useEditor.setState({ activeLayer: layer.id });
          select(e.shiftKey || e.metaKey ? (selected ? selection.filter((x) => x !== n.id) : [...selection, n.id]) : [n.id]);
        }}
        onDoubleClick={() => setRenaming(n.id)}
      >
        <button className="icon-btn" title={n.visible ? "Ocultar" : "Mostrar"} onClick={(e) => (e.stopPropagation(), setFlag(n.id, "visible", !n.visible))}>
          <Eye on={n.visible} />
        </button>
        <button className="icon-btn" title={n.locked ? "Desbloquear" : "Bloquear"} onClick={(e) => (e.stopPropagation(), setFlag(n.id, "locked", !n.locked))}>
          <Lock on={n.locked} />
        </button>
        {isLayer ? <span className="layer-color" style={{ background: (n as GroupNode).color }} /> : null}
        <span className="chev-btn" onClick={(e) => (e.stopPropagation(), isGroup && toggle(n as GroupNode))}>
          {isGroup && (n as GroupNode).children.length ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="kind">{isLayer ? "" : kindIcon(n)}</span>
        {renaming === n.id ? (
          <input
            className="rename"
            autoFocus
            defaultValue={defaultName(n)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={(e) => {
              const name = e.target.value.trim();
              setRenaming(null);
              commit((d) => {
                const loc = locate(d as Doc, n.id);
                if (loc) loc.node.name = name || undefined;
              });
            }}
          />
        ) : (
          <span className="name">{defaultName(n)}</span>
        )}
        {selected ? <span className="sel-dot" style={{ background: layer.color }} /> : null}
      </div>,
    );
    if (open) {
      const kids = (n as GroupNode).children;
      for (let i = kids.length - 1; i >= 0; i--) renderNode(kids[i], depth + 1, layer);
    }
  };
  for (let i = doc.layers.length - 1; i >= 0; i--) renderNode(doc.layers[i], 0, doc.layers[i]);

  return (
    <div className="layers">
      <div className="layer-list">{rows}</div>
      <div className="panel-footer">
        <span>{doc.layers.length} capas</span>
        <button
          className="btn"
          title="Crear capa nueva"
          onClick={() => {
            const layer: GroupNode = {
              id: newId(),
              type: "group",
              role: "layer",
              name: `Capa ${doc.layers.length + 1}`,
              visible: true,
              locked: false,
              opacity: 1,
              blend: "normal",
              children: [],
              color: ["#4f8cff", "#ff4f6d", "#3ecf8e", "#ffb547", "#b97cff"][doc.layers.length % 5],
              expanded: true,
            };
            commit((d) => void d.layers.push(layer));
            useEditor.setState({ activeLayer: layer.id });
          }}
        >
          + Capa
        </button>
        <button
          className="btn"
          title="Eliminar la capa activa"
          disabled={doc.layers.length < 2}
          onClick={() => {
            commit((d) => {
              d.layers = d.layers.filter((l) => l.id !== activeLayer);
            });
            useEditor.setState({ activeLayer: useEditor.getState().doc!.layers.at(-1)!.id });
          }}
        >
          🗑
        </button>
      </div>
    </div>
  );
}

export function ArtboardsPanel() {
  const doc = useEditor((s) => s.doc);
  const active = useEditor((s) => s.activeArtboard);
  if (!doc) return null;
  return (
    <div className="artboards">
      {doc.artboards.map((ab, i) => (
        <div key={ab.id} className={`ab-row ${i === active ? "selected" : ""}`} onClick={() => requestFit(i)}>
          <span className="ab-index">{i + 1}</span>
          <input
            className="ab-name"
            value={ab.name}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              commit((d) => {
                d.artboards[i].name = e.target.value;
              }, `abname:${i}`)
            }
          />
          <span className="ab-size">
            {Math.round(ab.width)}×{Math.round(ab.height)}
          </span>
        </div>
      ))}
    </div>
  );
}
