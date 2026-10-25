"use client";

import { create } from "zustand";
import { produce, type Draft } from "immer";
import type { Doc, Paint, SceneNode } from "./types";

export type Tool =
  | "select"
  | "direct"
  | "pen"
  | "rect"
  | "ellipse"
  | "line"
  | "text"
  | "eyedropper"
  | "hand"
  | "zoom";

export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

export interface EditorState {
  doc: Doc | null;
  selection: string[];
  tool: Tool;
  view: View;
  activeArtboard: number;
  activeLayer: string | null;
  clipArtboards: boolean;
  isolation: string | null;
  editingText: string | null;
  past: Doc[];
  future: Doc[];
  /** Document at the start of the current interactive gesture. */
  txBase: Doc | null;
  metricsVersion: number;
  loading: { message: string; fraction: number } | null;
  error: string | null;
  dirty: boolean;
  defaultFill: Paint | null;
  defaultStroke: Paint | null;
  defaultStrokeWidth: number;
  clipboard: SceneNode[];
  /** Bumped to ask the canvas to fit an artboard in view. */
  fitRequest: { artboard: number; nonce: number } | null;
}

const HISTORY_LIMIT = 100;

export const useEditor = create<EditorState>(() => ({
  doc: null,
  selection: [],
  tool: "select",
  view: { zoom: 1, panX: 0, panY: 0 },
  activeArtboard: 0,
  activeLayer: null,
  clipArtboards: true,
  isolation: null,
  editingText: null,
  past: [],
  future: [],
  txBase: null,
  metricsVersion: 0,
  loading: null,
  error: null,
  dirty: false,
  defaultFill: { kind: "solid", color: "#ffffff" },
  defaultStroke: { kind: "solid", color: "#000000" },
  defaultStrokeWidth: 1,
  clipboard: [],
  fitRequest: null,
}));

const set = useEditor.setState;
const get = useEditor.getState;

export function loadDoc(doc: Doc) {
  set({
    doc,
    selection: [],
    past: [],
    future: [],
    txBase: null,
    isolation: null,
    editingText: null,
    activeArtboard: 0,
    activeLayer: doc.layers.at(-1)?.id ?? null,
    dirty: false,
    loading: null,
    error: null,
    fitRequest: { artboard: 0, nonce: Math.random() },
  });
}

let lastCoalesce: { key: string; at: number } | null = null;

/**
 * Applies an undoable change to the document. Consecutive commits with the same `coalesce` key
 * (e.g. dragging a colour picker) are merged into a single undo step.
 */
export function commit(recipe: (draft: Draft<Doc>) => void, coalesce?: string) {
  const { doc, past } = get();
  if (!doc) return;
  const next = produce(doc, recipe);
  if (next === doc) return;
  const now = Date.now();
  const merge = coalesce && lastCoalesce?.key === coalesce && now - lastCoalesce.at < 1500 && past.length;
  lastCoalesce = coalesce ? { key: coalesce, at: now } : null;
  set({ doc: next, past: merge ? past : [...past, doc].slice(-HISTORY_LIMIT), future: [], dirty: true });
}

/** Interactive gestures: begin, update from the base document, end (one undo step). */
export function beginTx() {
  const { doc } = get();
  set({ txBase: doc });
}

export function liveFromBase(recipe: (draft: Draft<Doc>) => void) {
  const { txBase } = get();
  if (!txBase) return;
  set({ doc: produce(txBase, recipe) });
}

export function endTx() {
  const { txBase, doc, past } = get();
  if (!txBase) return;
  if (doc !== txBase) set({ past: [...past, txBase].slice(-HISTORY_LIMIT), future: [], dirty: true });
  set({ txBase: null });
}

export function cancelTx() {
  const { txBase } = get();
  if (txBase) set({ doc: txBase, txBase: null });
}

export function undo() {
  const { past, doc, future } = get();
  if (!past.length || !doc) return;
  set({ doc: past.at(-1)!, past: past.slice(0, -1), future: [doc, ...future], dirty: true });
  pruneSelection();
}

export function redo() {
  const { past, doc, future } = get();
  if (!future.length || !doc) return;
  set({ doc: future[0], past: [...past, doc], future: future.slice(1), dirty: true });
  pruneSelection();
}

function pruneSelection() {
  const { doc, selection } = get();
  if (!doc) return;
  const ids = new Set<string>();
  const visit = (nodes: SceneNode[]) => {
    for (const n of nodes) {
      ids.add(n.id);
      if (n.type === "group") visit(n.children);
    }
  };
  visit(doc.layers);
  set({ selection: selection.filter((id) => ids.has(id)) });
}

export const select = (ids: string[]) => set({ selection: ids });
export const setTool = (tool: Tool) => set({ tool, editingText: null });
export const setView = (view: View) => set({ view });
let metricsFrame = 0;
/** Text measurements changed: re-render overlays once per frame. */
export function bumpMetrics() {
  if (metricsFrame) return;
  metricsFrame = requestAnimationFrame(() => {
    metricsFrame = 0;
    set((s) => ({ metricsVersion: s.metricsVersion + 1 }));
  });
}
export const requestFit = (artboard: number) =>
  set({ activeArtboard: artboard, fitRequest: { artboard, nonce: Math.random() } });
