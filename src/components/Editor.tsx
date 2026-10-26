"use client";

import { useEffect, useRef, useState } from "react";
import {
  arrangeSelection,
  clipSelection,
  copySelection,
  deleteSelection,
  duplicateSelection,
  groupSelection,
  newDocument,
  nudgeSelection,
  openFile,
  paste,
  placeReferenceImage,
  releaseClipSelection,
  selectAll,
  ungroupSelection,
  vectorizableImage,
} from "@/lib/actions";
import { restoreBridge, setBridgeEnabled } from "@/lib/bridge";
import { walk } from "@/lib/geometry";
import { locate } from "@/lib/ops";
import { isReferenceLayer } from "@/lib/reference";
import { commit, redo, requestFit, select, setTool, setView, undo, useEditor } from "@/lib/store";
import type { Doc } from "@/lib/types";
import { Canvas } from "./Canvas";
import { ConnectDialog, VectorizeDialog } from "./Dialogs";
import { ArtboardsPanel, LayersPanel } from "./LayersPanel";
import { PropertiesPanel } from "./PropertiesPanel";
import { TOOL_KEYS, Toolbar } from "./Toolbar";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

async function saveAs(kind: "ai" | "pdf" | "svg" | "png") {
  const { doc: current, activeArtboard } = useEditor.getState();
  if (!current) return;
  // The reference photo is a tracing aid, not part of the artwork.
  const doc = { ...current, layers: current.layers.filter((l) => !isReferenceLayer(l)) };
  useEditor.setState({ loading: { message: "Preparando exportación…", fraction: 0 } });
  try {
    const { saveBlob } = await import("@/lib/exportSvg");
    if (kind === "ai" || kind === "pdf") {
      const { exportPdf } = await import("@/lib/exportPdf");
      const bytes = await exportPdf(doc, { onProgress: (message, fraction) => useEditor.setState({ loading: { message, fraction } }) });
      const type = kind === "ai" ? "application/illustrator" : "application/pdf";
      useEditor.setState({ loading: null });
      await saveBlob(new Blob([bytes as BlobPart], { type }), `${doc.name}.${kind}`);
      if (kind === "ai") useEditor.setState({ dirty: false });
    } else {
      const ab = doc.artboards[activeArtboard];
      const { artboardToSvg, artboardToPng } = await import("@/lib/exportSvg");
      const blob =
        kind === "svg"
          ? new Blob([await artboardToSvg(doc, activeArtboard)], { type: "image/svg+xml" })
          : await artboardToPng(doc, activeArtboard, 300 / 72);
      useEditor.setState({ loading: null });
      await saveBlob(blob, `${doc.name} - ${ab.name}.${kind}`);
    }
  } catch (err) {
    console.error(err);
    useEditor.setState({ loading: null, error: `No se pudo exportar: ${err instanceof Error ? err.message : err}` });
  }
}

function setFlagOnSelection(key: "locked" | "visible", value: boolean) {
  const { selection } = useEditor.getState();
  if (!selection.length) return;
  commit((d) => {
    for (const id of selection) {
      const loc = locate(d as Doc, id);
      if (loc) loc.node[key] = value;
    }
  });
  select([]);
}

function resetAll(key: "locked" | "visible", value: boolean) {
  commit((d) => {
    for (const [n] of walk((d as Doc).layers)) if (!(n.type === "group" && n.role)) n[key] = value;
  });
}

function zoomBy(factor: number) {
  const { view } = useEditor.getState();
  const el = document.querySelector(".canvas") as HTMLElement | null;
  const cx = (el?.clientWidth ?? 800) / 2;
  const cy = (el?.clientHeight ?? 600) / 2;
  const zoom = Math.min(64, Math.max(0.02, view.zoom * factor));
  setView({ zoom, panX: cx - ((cx - view.panX) / view.zoom) * zoom, panY: cy - ((cy - view.panY) / view.zoom) * zoom });
}

function actualSize() {
  const { doc, activeArtboard } = useEditor.getState();
  const el = document.querySelector(".canvas") as HTMLElement | null;
  if (!doc || !el) return;
  const ab = doc.artboards[activeArtboard];
  setView({ zoom: 1, panX: el.clientWidth / 2 - (ab.x + ab.width / 2), panY: el.clientHeight / 2 - (ab.y + ab.height / 2) });
}

type MenuItem = { label: string; shortcut?: string; action: () => void; disabled?: boolean; checked?: boolean } | "sep";

function Menu({ title, items }: { title: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className={`menu-title ${open ? "open" : ""}`} onClick={() => setOpen(!open)}>
        {title}
      </button>
      {open ? (
        <div className="menu-pop">
          {items.map((it, i) =>
            it === "sep" ? (
              <div key={i} className="menu-sep" />
            ) : (
              <button
                key={i}
                className="menu-item"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.action();
                }}
              >
                <span className="check-mark">{it.checked ? "✓" : ""}</span>
                <span>{it.label}</span>
                <span className="shortcut">{it.shortcut}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

export function Editor() {
  const doc = useEditor((s) => s.doc);
  const loading = useEditor((s) => s.loading);
  const error = useEditor((s) => s.error);
  const selection = useEditor((s) => s.selection);
  const clipArtboards = useEditor((s) => s.clipArtboards);
  const zoom = useEditor((s) => s.view.zoom);
  const activeArtboard = useEditor((s) => s.activeArtboard);
  const dirty = useEditor((s) => s.dirty);
  const pastLen = useEditor((s) => s.past.length);
  const futureLen = useEditor((s) => s.future.length);
  const [tab, setTab] = useState<"props" | "artboards">("props");
  const bridge = useEditor((s) => s.bridge);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<"vectorize" | "connect" | null>(null);

  const open = () => fileInput.current?.click();

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      const st = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      if (mod) {
        if (key === "o") return run(open);
        if (key === "s") return run(() => saveAs(e.shiftKey ? "pdf" : "ai"));
        if (!st.doc) return;
        if (key === "z") return run(e.shiftKey ? redo : undo);
        if (key === "y") return run(redo);
        if (key === "c") return run(() => copySelection());
        if (key === "x") return run(() => copySelection(true));
        if (key === "v") return run(() => paste(e.shiftKey));
        if (key === "d") return run(() => duplicateSelection());
        if (key === "a") return run(e.shiftKey ? () => select([]) : selectAll);
        if (key === "g") return run(e.shiftKey ? ungroupSelection : groupSelection);
        if (key === "7") return run(e.altKey ? releaseClipSelection : clipSelection);
        if (key === "2") return run(() => (e.altKey ? resetAll("locked", false) : setFlagOnSelection("locked", true)));
        if (key === "3") return run(() => (e.altKey ? resetAll("visible", true) : setFlagOnSelection("visible", false)));
        if (e.code === "BracketRight") return run(() => arrangeSelection(e.shiftKey ? "front" : "forward"));
        if (e.code === "BracketLeft") return run(() => arrangeSelection(e.shiftKey ? "back" : "backward"));
        if (key === "=" || key === "+") return run(() => zoomBy(1.5));
        if (key === "-") return run(() => zoomBy(1 / 1.5));
        if (key === "0") return run(() => requestFit(st.activeArtboard));
        if (key === "1") return run(actualSize);
        return;
      }
      if (!st.doc) return;
      if (key === "backspace" || key === "delete") return run(deleteSelection);
      if (key === "escape") {
        if (st.isolation) useEditor.setState({ isolation: null });
        return run(() => select([]));
      }
      if (key.startsWith("arrow")) {
        const step = e.shiftKey ? 10 : 1;
        const [dx, dy] = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[key]!;
        return run(() => nudgeSelection(dx, dy));
      }
      if (key === "x" && !e.altKey) {
        return run(() => useEditor.setState((s) => ({ defaultFill: s.defaultStroke, defaultStroke: s.defaultFill })));
      }
      const tool = TOOL_KEYS[key] ?? (e.key === "\\" ? "line" : undefined);
      if (tool && !e.altKey) run(() => setTool(tool));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    // Test/debug handle, development only.
    if (process.env.NODE_ENV !== "production") import("@/lib/debug").then((m) => m.installDebugHandle());
  }, []);

  useEffect(restoreBridge, []);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (useEditor.getState().dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const hasSel = selection.length > 0;
  const fileMenu: MenuItem[] = [
    { label: "Nuevo documento", action: newDocument },
    { label: "Abrir…", shortcut: `${MOD}O`, action: open },
    "sep",
    { label: "Guardar como .ai", shortcut: `${MOD}S`, action: () => saveAs("ai"), disabled: !doc },
    { label: "Exportar PDF", shortcut: `⇧${MOD}S`, action: () => saveAs("pdf"), disabled: !doc },
    { label: "Exportar SVG (mesa activa)", action: () => saveAs("svg"), disabled: !doc },
    { label: "Exportar PNG 300 ppp (mesa activa)", action: () => saveAs("png"), disabled: !doc },
  ];
  const editMenu: MenuItem[] = [
    { label: "Deshacer", shortcut: `${MOD}Z`, action: undo, disabled: !pastLen },
    { label: "Rehacer", shortcut: `⇧${MOD}Z`, action: redo, disabled: !futureLen },
    "sep",
    { label: "Cortar", shortcut: `${MOD}X`, action: () => copySelection(true), disabled: !hasSel },
    { label: "Copiar", shortcut: `${MOD}C`, action: () => copySelection(), disabled: !hasSel },
    { label: "Pegar", shortcut: `${MOD}V`, action: () => paste(), disabled: !doc },
    { label: "Pegar en el lugar", shortcut: `⇧${MOD}V`, action: () => paste(true), disabled: !doc },
    { label: "Duplicar", shortcut: `${MOD}D`, action: () => duplicateSelection(), disabled: !hasSel },
    { label: "Eliminar", shortcut: "⌫", action: deleteSelection, disabled: !hasSel },
    "sep",
    { label: "Seleccionar todo", shortcut: `${MOD}A`, action: selectAll, disabled: !doc },
    { label: "Deseleccionar", shortcut: `⇧${MOD}A`, action: () => select([]), disabled: !hasSel },
  ];
  const objectMenu: MenuItem[] = [
    { label: "Agrupar", shortcut: `${MOD}G`, action: groupSelection, disabled: !hasSel },
    { label: "Desagrupar", shortcut: `⇧${MOD}G`, action: ungroupSelection, disabled: !hasSel },
    "sep",
    { label: "Traer al frente", shortcut: `⇧${MOD}]`, action: () => arrangeSelection("front"), disabled: !hasSel },
    { label: "Hacia adelante", shortcut: `${MOD}]`, action: () => arrangeSelection("forward"), disabled: !hasSel },
    { label: "Hacia atrás", shortcut: `${MOD}[`, action: () => arrangeSelection("backward"), disabled: !hasSel },
    { label: "Enviar al fondo", shortcut: `⇧${MOD}[`, action: () => arrangeSelection("back"), disabled: !hasSel },
    "sep",
    { label: "Crear máscara de recorte", shortcut: `${MOD}7`, action: clipSelection, disabled: selection.length < 2 },
    { label: "Soltar máscara de recorte", shortcut: `⌥${MOD}7`, action: releaseClipSelection, disabled: !hasSel },
    "sep",
    { label: "Bloquear selección", shortcut: `${MOD}2`, action: () => setFlagOnSelection("locked", true), disabled: !hasSel },
    { label: "Desbloquear todo", shortcut: `⌥${MOD}2`, action: () => resetAll("locked", false), disabled: !doc },
    { label: "Ocultar selección", shortcut: `${MOD}3`, action: () => setFlagOnSelection("visible", false), disabled: !hasSel },
    { label: "Mostrar todo", shortcut: `⌥${MOD}3`, action: () => resetAll("visible", true), disabled: !doc },
    "sep",
    { label: "Vectorizar imagen…", action: () => setDialog("vectorize"), disabled: !doc || !vectorizableImage() },
  ];
  const viewMenu: MenuItem[] = [
    { label: "Acercar", shortcut: `${MOD}+`, action: () => zoomBy(1.5), disabled: !doc },
    { label: "Alejar", shortcut: `${MOD}-`, action: () => zoomBy(1 / 1.5), disabled: !doc },
    { label: "Encajar mesa de trabajo", shortcut: `${MOD}0`, action: () => requestFit(activeArtboard), disabled: !doc },
    { label: "Tamaño real", shortcut: `${MOD}1`, action: actualSize, disabled: !doc },
    "sep",
    {
      label: "Recortar a las mesas de trabajo",
      checked: clipArtboards,
      action: () => useEditor.setState({ clipArtboards: !clipArtboards }),
    },
  ];

  const claudeMenu: MenuItem[] = [
    { label: "Conectar con Claude…", checked: bridge !== "off", action: () => setDialog("connect") },
    { label: "Colocar imagen de referencia…", action: () => referenceInput.current?.click() },
    { label: "Vectorizar imagen…", action: () => setDialog("vectorize"), disabled: !doc || !vectorizableImage() },
    "sep",
    { label: "Desconectar", action: () => setBridgeEnabled(false), disabled: bridge === "off" },
  ];

  return (
    <div
      className={`app ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        const file = e.dataTransfer.files?.[0];
        setDragOver(false);
        if (file) {
          e.preventDefault();
          openFile(file);
        }
      }}
    >
      <header className="menubar">
        <div className="brand">
          <span className="logo">Fs</span>
        </div>
        <Menu title="Archivo" items={fileMenu} />
        <Menu title="Edición" items={editMenu} />
        <Menu title="Objeto" items={objectMenu} />
        <Menu title="Ver" items={viewMenu} />
        <Menu title="Claude" items={claudeMenu} />
        <div className="doc-title">
          {doc ? (
            <>
              {doc.name}
              {dirty ? " •" : ""} <span className="muted">@ {Math.round(zoom * 100)}%</span>
            </>
          ) : (
            "Freestrator"
          )}
        </div>
        {doc ? (
          <button className="btn primary" onClick={() => saveAs("ai")}>
            Guardar .ai
          </button>
        ) : null}
      </header>

      <input
        ref={fileInput}
        type="file"
        accept=".ai,.pdf,application/pdf,application/illustrator,application/postscript"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) openFile(file);
        }}
      />
      <input
        ref={referenceInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) placeReferenceImage(file);
        }}
      />

      {doc ? (
        <main className="workspace">
          <Toolbar />
          <Canvas />
          <aside className="sidebar">
            <div className="tabs">
              <button className={tab === "props" ? "active" : ""} onClick={() => setTab("props")}>
                Propiedades
              </button>
              <button className={tab === "artboards" ? "active" : ""} onClick={() => setTab("artboards")}>
                Mesas de trabajo
              </button>
            </div>
            <div className="sidebar-top">{tab === "props" ? <PropertiesPanel /> : <ArtboardsPanel />}</div>
            <div className="tabs">
              <button className="active">Capas</button>
            </div>
            <div className="sidebar-bottom">
              <LayersPanel />
            </div>
          </aside>
        </main>
      ) : (
        <Welcome onOpen={open} />
      )}

      {doc ? (
        <footer className="statusbar">
          <select value={Math.round(zoom * 100)} onChange={(e) => zoomBy(Number(e.target.value) / 100 / zoom)}>
            {[...new Set([Math.round(zoom * 100), 10, 25, 50, 66, 100, 150, 200, 300, 400, 800])].sort((a, b) => a - b).map((z) => (
              <option key={z} value={z}>
                {z}%
              </option>
            ))}
          </select>
          <button className="btn mini" disabled={activeArtboard === 0} onClick={() => requestFit(activeArtboard - 1)}>
            ◀
          </button>
          <span>
            Mesa {activeArtboard + 1} de {doc.artboards.length}
          </span>
          <button className="btn mini" disabled={activeArtboard >= doc.artboards.length - 1} onClick={() => requestFit(activeArtboard + 1)}>
            ▶
          </button>
          <span className="muted">{selection.length ? `${selection.length} seleccionado(s)` : "Sin selección"}</span>
          {bridge !== "off" ? (
            <button className={`bridge-status ${bridge}`} title="Conexión con Claude (servidor MCP local)" onClick={() => setDialog("connect")}>
              {bridge === "on" ? "● Claude conectado" : "○ Esperando a Claude…"}
            </button>
          ) : null}
          <span className="muted right">Espacio: mano · Doble clic: entrar al grupo / editar texto · ⇧: proporcional · ⌥: duplicar</span>
        </footer>
      ) : null}

      {loading ? (
        <div className="modal">
          <div className="modal-card">
            <div className="spinner" />
            <div>{loading.message}</div>
            <div className="progress">
              <div style={{ width: `${Math.round(loading.fraction * 100)}%` }} />
            </div>
          </div>
        </div>
      ) : null}
      {dialog === "vectorize" ? <VectorizeDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "connect" ? <ConnectDialog onClose={() => setDialog(null)} /> : null}
      {error ? (
        <div className="toast error" onClick={() => useEditor.setState({ error: null })}>
          {error}
          <span className="muted"> (clic para cerrar)</span>
        </div>
      ) : null}
      {dragOver ? <div className="drop-hint">Soltá el archivo .ai para abrirlo</div> : null}
    </div>
  );
}

function Welcome({ onOpen }: { onOpen: () => void }) {
  return (
    <main className="welcome">
      <div className="welcome-card">
        <div className="welcome-logo">Fs</div>
        <h1>Freestrator</h1>
        <p>Abrí, editá y guardá archivos de Adobe Illustrator (.ai) directamente en el navegador.</p>
        <div className="welcome-actions">
          <button className="btn primary big" onClick={onOpen}>
            Abrir archivo .ai…
          </button>
          <button className="btn big" onClick={newDocument}>
            Nuevo documento
          </button>
        </div>
        <p className="muted small">
          También podés arrastrar un archivo a esta ventana. Funciona con archivos .ai guardados con «Crear archivo compatible con PDF» (la opción por defecto) y con PDF. El archivo no sale de tu computadora.
        </p>
      </div>
    </main>
  );
}
