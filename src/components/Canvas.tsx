"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { duplicateSelection, updateNode } from "@/lib/actions";
import { bboxIntersects, ellipseSegs, newId, nodeBBox, rectSegs, segsToD, walk, type BBox } from "@/lib/geometry";
import { about, apply, mul, rotate, scale, toSvg, translate, type Mat } from "@/lib/matrix";
import { artboardAt, getNodes, insertNode, locate, resolveSelectable, selectionBBox, toLocalDelta, transformNodes } from "@/lib/ops";
import { NodeView, RenderContext, type RenderOptions } from "@/lib/render";
import { beginTx, bumpMetrics, commit, endTx, liveFromBase, select, setView, useEditor } from "@/lib/store";
import { editingFont } from "@/lib/text";
import type { Doc, GroupNode, PathNode, SceneNode, Seg, TextNode } from "@/lib/types";

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_CURSOR: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M5 12a7 7 0 1 1 2.05 4.95" fill="none" stroke="white" stroke-width="4"/><path d="M5 12a7 7 0 1 1 2.05 4.95" fill="none" stroke="black" stroke-width="1.6"/><path d="M2 9l3 4 3.5-3.5" fill="none" stroke="black" stroke-width="1.6"/></svg>',
)}") 12 12, crosshair`;

function handlePos(b: BBox, h: Handle): [number, number] {
  const x = h.includes("w") ? b.x : h.includes("e") ? b.x + b.w : b.x + b.w / 2;
  const y = h.includes("n") ? b.y : h.includes("s") ? b.y + b.h : b.y + b.h / 2;
  return [x, y];
}
const opposite = (h: Handle): Handle =>
  h
    .split("")
    .map((c) => ({ n: "s", s: "n", e: "w", w: "e" })[c]!)
    .join("") as Handle;

type Gesture =
  | { type: "move"; start: [number, number]; ids: string[]; moved: boolean }
  | { type: "scale"; handle: Handle; start: [number, number]; box: BBox; ids: string[] }
  | { type: "rotate"; start: [number, number]; center: [number, number]; ids: string[] }
  | { type: "marquee"; start: [number, number]; additive: boolean }
  | { type: "pan"; client: [number, number]; pan: [number, number] }
  | { type: "shape"; kind: "rect" | "ellipse" | "line"; start: [number, number] }
  | { type: "anchor"; nodeId: string; seg: number; part: "end" | "c1" | "c2"; start: [number, number] }
  | { type: "pen"; nodeId: string; anchor: [number, number] }
  | { type: "zoom-drag" };

interface PenState {
  nodeId: string;
  /** Outgoing handle of the last anchor (doc space). */
  out: [number, number] | null;
  first: [number, number];
  firstOut: [number, number] | null;
}

export function Canvas() {
  const doc = useEditor((s) => s.doc)!;
  const view = useEditor((s) => s.view);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const clipArtboards = useEditor((s) => s.clipArtboards);
  const isolation = useEditor((s) => s.isolation);
  const editingText = useEditor((s) => s.editingText);
  const fitRequest = useEditor((s) => s.fitRequest);
  useEditor((s) => s.metricsVersion);

  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const gesture = useRef<Gesture | null>(null);
  const [marquee, setMarquee] = useState<BBox | null>(null);
  const [shapePreview, setShapePreview] = useState<{ kind: "rect" | "ellipse" | "line"; a: [number, number]; b: [number, number] } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [cursorDoc, setCursorDoc] = useState<[number, number] | null>(null);
  const [space, setSpace] = useState(false);
  const [pen, setPen] = useState<PenState | null>(null);
  const [activeCursor, setActiveCursor] = useState<string | null>(null);
  const [gesturing, setGesturing] = useState(false);
  const startGesture = (g: Gesture) => {
    gesture.current = g;
    setGesturing(true);
  };

  // ---------- view helpers ----------
  const toDoc = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      const r = ref.current!.getBoundingClientRect();
      const { zoom, panX, panY } = useEditor.getState().view;
      return [(clientX - r.left - panX) / zoom, (clientY - r.top - panY) / zoom];
    },
    [],
  );
  const screenM: Mat = [view.zoom, 0, 0, view.zoom, view.panX, view.panY];
  const toScreenBox = (b: BBox): BBox => ({ x: b.x * view.zoom + view.panX, y: b.y * view.zoom + view.panY, w: b.w * view.zoom, h: b.h * view.zoom });

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Fit an artboard when asked.
  useEffect(() => {
    if (!fitRequest || !ref.current) return;
    const ab = doc.artboards[fitRequest.artboard];
    if (!ab) return;
    const el = ref.current;
    const pad = 48;
    const zoom = Math.min((el.clientWidth - pad * 2) / ab.width, (el.clientHeight - pad * 2) / ab.height);
    setView({
      zoom,
      panX: el.clientWidth / 2 - (ab.x + ab.width / 2) * zoom,
      panY: el.clientHeight / 2 - (ab.y + ab.height / 2) * zoom,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest]);

  // Wheel: pan, ctrl/cmd + wheel (or pinch): zoom at cursor.
  useEffect(() => {
    const el = ref.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { zoom, panX, panY } = useEditor.getState().view;
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        const next = Math.min(64, Math.max(0.02, zoom * Math.exp(-e.deltaY * 0.01)));
        setView({ zoom: next, panX: sx - ((sx - panX) / zoom) * next, panY: sy - ((sy - panY) / zoom) * next });
      } else {
        setView({ zoom, panX: panX - e.deltaX, panY: panY - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Space bar = temporary hand tool.
  useEffect(() => {
    const typing = (e: KeyboardEvent) => (e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]");
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e)) {
        e.preventDefault();
        setSpace(true);
      }
      if ((e.key === "Enter" || e.key === "Escape") && !typing(e)) setPen(null);
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpace(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);


  const zoomAt = (factor: number, sx: number, sy: number) => {
    const { zoom, panX, panY } = useEditor.getState().view;
    const next = Math.min(64, Math.max(0.02, zoom * factor));
    setView({ zoom: next, panX: sx - ((sx - panX) / zoom) * next, panY: sy - ((sy - panY) / zoom) * next });
  };

  // ---------- hit testing ----------
  const hitId = (target: EventTarget | null): string | null => {
    const el = (target as Element | null)?.closest?.("[data-id]");
    return el?.getAttribute("data-id") ?? null;
  };
  const resolveHit = (target: EventTarget | null, mode: "top" | "leaf") => {
    const id = hitId(target);
    if (!id) return null;
    const d = useEditor.getState().doc!;
    return resolveSelectable(d, id, mode, useEditor.getState().isolation);
  };

  // ---------- pointer handling ----------
  const onPointerDown = (e: RPointerEvent) => {
    if (e.button === 2) return;
    const target = e.target as Element;
    if (target.closest("textarea")) return;
    ref.current!.setPointerCapture(e.pointerId);
    const p = toDoc(e.clientX, e.clientY);
    const st = useEditor.getState();
    const d = st.doc!;
    const effectiveTool = space || e.button === 1 ? "hand" : st.tool;
    // Leaving the pen tool finishes the path being drawn.
    if (effectiveTool !== "pen" && pen) setPen(null);

    const abEl = target.closest("[data-artboard]");
    if (abEl) useEditor.setState({ activeArtboard: Number(abEl.getAttribute("data-artboard")) });
    else {
      const hitAb = artboardAt(d, p[0], p[1], -1);
      if (hitAb >= 0 && hitAb !== st.activeArtboard) useEditor.setState({ activeArtboard: hitAb });
    }

    if (effectiveTool === "hand") {
      startGesture({ type: "pan", client: [e.clientX, e.clientY], pan: [st.view.panX, st.view.panY] });
      setActiveCursor("grabbing");
      return;
    }
    if (effectiveTool === "zoom") {
      const r = ref.current!.getBoundingClientRect();
      zoomAt(e.altKey ? 0.5 : 2, e.clientX - r.left, e.clientY - r.top);
      return;
    }

    if (st.editingText) {
      // Clicking elsewhere ends text editing (textarea blur commits).
      useEditor.setState({ editingText: null });
    }

    if (effectiveTool === "select" || effectiveTool === "direct") {
      const handle = target.closest("[data-handle]")?.getAttribute("data-handle");
      if (handle) {
        const box = selectionBBox(d, st.selection);
        if (!box) return;
        beginTx();
        if (handle.startsWith("rot-")) {
          startGesture({ type: "rotate", start: p, center: [box.x + box.w / 2, box.y + box.h / 2], ids: st.selection });
          setActiveCursor(ROTATE_CURSOR);
        } else if (handle.startsWith("anchor:")) {
          const [, nodeId, seg, part] = handle.split(":");
          startGesture({ type: "anchor", nodeId, seg: Number(seg), part: part as "end" | "c1" | "c2", start: p });
        } else {
          startGesture({ type: "scale", handle: handle as Handle, start: p, box, ids: st.selection });
          setActiveCursor(HANDLE_CURSOR[handle as Handle]);
        }
        return;
      }
      const id = resolveHit(target, effectiveTool === "select" ? "top" : "leaf");
      if (id) {
        let ids = st.selection;
        if (e.shiftKey) {
          ids = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
          select(ids);
          return;
        }
        if (!ids.includes(id)) {
          ids = [id];
          select(ids);
        }
        if (e.altKey) {
          duplicateSelection([0, 0]);
          ids = useEditor.getState().selection;
        }
        beginTx();
        startGesture({ type: "move", start: p, ids, moved: false });
        return;
      }
      if (!e.shiftKey) select([]);
      startGesture({ type: "marquee", start: p, additive: e.shiftKey });
      return;
    }

    if (effectiveTool === "rect" || effectiveTool === "ellipse" || effectiveTool === "line") {
      startGesture({ type: "shape", kind: effectiveTool, start: p });
      setShapePreview({ kind: effectiveTool, a: p, b: p });
      return;
    }

    if (effectiveTool === "text") {
      const hit = resolveHit(target, "leaf");
      const hitNode = hit ? locate(d, hit)?.node : null;
      if (hitNode?.type === "text") {
        select([hitNode.id]);
        useEditor.setState({ editingText: hitNode.id });
        return;
      }
      const ab = artboardAt(d, p[0], p[1], st.activeArtboard);
      const firstFont = [...walk(d.layers)].map(([n]) => n).find((n): n is TextNode => n.type === "text");
      const node: TextNode = {
        id: newId(),
        type: "text",
        visible: true,
        locked: false,
        opacity: 1,
        blend: "normal",
        m: [1, 0, 0, 1, p[0], p[1]],
        text: "",
        fontSize: firstFont ? Math.round(firstFont.fontSize) : 24,
        font: firstFont?.font,
        family: firstFont?.family ?? "Inter",
        weight: firstFont?.weight ?? 400,
        italic: false,
        letterSpacing: 0,
        fill: st.defaultFill?.kind === "solid" && st.defaultFill.color.toLowerCase() !== "#ffffff" ? st.defaultFill : { kind: "solid", color: "#000000" },
        fillOpacity: 1,
        stroke: null,
        strokeOpacity: 1,
        strokeWidth: 1,
      };
      commit((dd) => insertNode(dd as Doc, node, st.activeLayer, ab, st.isolation));
      select([node.id]);
      useEditor.setState({ editingText: node.id });
      return;
    }

    if (effectiveTool === "eyedropper") {
      const id = resolveHit(target, "leaf");
      const src = id ? locate(d, id)?.node : null;
      if (!src || src.type === "group" || src.type === "image") return;
      if (st.selection.length) {
        commit((dd) => {
          for (const n of getNodes(dd as Doc, st.selection)) {
            const apply = (x: SceneNode) => {
              if (x.type === "group") x.children.forEach(apply);
              else if (x.type === "path" || x.type === "text") {
                x.fill = src.fill;
                x.stroke = src.stroke;
                x.strokeWidth = src.strokeWidth;
                x.fillOpacity = src.fillOpacity;
              }
            };
            apply(n);
          }
        });
      } else {
        useEditor.setState({ defaultFill: src.fill, defaultStroke: src.stroke, defaultStrokeWidth: src.strokeWidth });
      }
      return;
    }

    if (effectiveTool === "pen") {
      // Close the path when clicking on its first anchor.
      if (pen) {
        const [fx, fy] = pen.first;
        const dist = Math.hypot((fx - p[0]) * st.view.zoom, (fy - p[1]) * st.view.zoom);
        if (dist < 8) {
          commit((dd) => {
            const n = locate(dd as Doc, pen.nodeId)?.node as PathNode | undefined;
            if (!n) return;
            const inH: [number, number] | null = pen.firstOut ? [2 * fx - pen.firstOut[0], 2 * fy - pen.firstOut[1]] : null;
            if (pen.out || inH) {
              const c1 = pen.out ?? lastPoint(n.segs);
              const c2 = inH ?? [fx, fy];
              n.segs.push({ c: "C", p: [...c1, ...c2, fx, fy] });
            } else n.segs.push({ c: "L", p: [fx, fy] });
            n.segs.push({ c: "Z", p: [] });
          });
          setPen(null);
          return;
        }
        beginTx();
        liveFromBase((dd) => {
          const n = locate(dd as Doc, pen.nodeId)?.node as PathNode | undefined;
          if (!n) return;
          if (pen.out) n.segs.push({ c: "C", p: [...pen.out, p[0], p[1], p[0], p[1]] });
          else n.segs.push({ c: "L", p: [p[0], p[1]] });
        });
        startGesture({ type: "pen", nodeId: pen.nodeId, anchor: p });
        setPen({ ...pen, out: null });
        return;
      }
      const ab = artboardAt(d, p[0], p[1], st.activeArtboard);
      const node: PathNode = {
        ...basePath(st.defaultFill, st.defaultStroke, st.defaultStrokeWidth),
        fill: null,
        stroke: st.defaultStroke ?? { kind: "solid", color: "#000000" },
        segs: [{ c: "M", p: [p[0], p[1]] }],
        m: [1, 0, 0, 1, 0, 0],
      };
      commit((dd) => insertNode(dd as Doc, node, st.activeLayer, ab, st.isolation));
      select([node.id]);
      beginTx();
      startGesture({ type: "pen", nodeId: node.id, anchor: p });
      setPen({ nodeId: node.id, out: null, first: p, firstOut: null });
    }
  };

  const onPointerMove = (e: RPointerEvent) => {
    const p = toDoc(e.clientX, e.clientY);
    setCursorDoc(p);
    const g = gesture.current;
    if (!g) {
      const st = useEditor.getState();
      if (st.tool === "select" || st.tool === "direct") {
        const id = resolveHit(e.target, st.tool === "select" ? "top" : "leaf");
        if (id !== hover) setHover(id);
      } else if (hover) setHover(null);
      return;
    }
    switch (g.type) {
      case "pan": {
        const { zoom } = useEditor.getState().view;
        setView({ zoom, panX: g.pan[0] + e.clientX - g.client[0], panY: g.pan[1] + e.clientY - g.client[1] });
        break;
      }
      case "move": {
        let dx = p[0] - g.start[0];
        let dy = p[1] - g.start[1];
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy) * 2) dy = 0;
          else if (Math.abs(dy) > Math.abs(dx) * 2) dx = 0;
          else {
            const m = (Math.abs(dx) + Math.abs(dy)) / 2;
            dx = Math.sign(dx) * m;
            dy = Math.sign(dy) * m;
          }
        }
        if (!g.moved && Math.hypot(dx, dy) * useEditor.getState().view.zoom < 2) break;
        g.moved = true;
        liveFromBase((d) => transformNodes(d as Doc, g.ids, translate(dx, dy)));
        break;
      }
      case "scale": {
        const fromCenter = e.altKey;
        const [hx, hy] = handlePos(g.box, g.handle);
        const [ax, ay] = fromCenter ? [g.box.x + g.box.w / 2, g.box.y + g.box.h / 2] : handlePos(g.box, opposite(g.handle));
        const safe = (v: number) => (Math.abs(v) < 1e-3 ? 1e-3 * Math.sign(v || 1) : v);
        let sx = g.handle === "n" || g.handle === "s" ? 1 : safe((p[0] - ax) / (hx - ax || 1));
        let sy = g.handle === "e" || g.handle === "w" ? 1 : safe((p[1] - ay) / (hy - ay || 1));
        if (e.shiftKey) {
          if (g.handle.length === 2) {
            const s = Math.max(Math.abs(sx), Math.abs(sy));
            sx = s * Math.sign(sx);
            sy = s * Math.sign(sy);
          } else if (g.handle === "n" || g.handle === "s") sx = Math.abs(sy);
          else sy = Math.abs(sx);
        }
        liveFromBase((d) => transformNodes(d as Doc, g.ids, about(scale(sx, sy), ax, ay)));
        break;
      }
      case "rotate": {
        const [cx, cy] = g.center;
        let a = Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(g.start[1] - cy, g.start[0] - cx);
        if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
        liveFromBase((d) => transformNodes(d as Doc, g.ids, about(rotate(a), cx, cy)));
        break;
      }
      case "marquee": {
        const x = Math.min(g.start[0], p[0]);
        const y = Math.min(g.start[1], p[1]);
        setMarquee({ x, y, w: Math.abs(p[0] - g.start[0]), h: Math.abs(p[1] - g.start[1]) });
        break;
      }
      case "shape": {
        let b: [number, number] = p;
        if (e.shiftKey) {
          const dx = p[0] - g.start[0];
          const dy = p[1] - g.start[1];
          if (g.kind === "line") {
            const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(dx, dy);
            b = [g.start[0] + Math.cos(ang) * len, g.start[1] + Math.sin(ang) * len];
          } else {
            const s = Math.max(Math.abs(dx), Math.abs(dy));
            b = [g.start[0] + s * Math.sign(dx || 1), g.start[1] + s * Math.sign(dy || 1)];
          }
        }
        let a = g.start;
        if (e.altKey && g.kind !== "line") a = [2 * g.start[0] - b[0], 2 * g.start[1] - b[1]];
        setShapePreview({ kind: g.kind, a, b });
        break;
      }
      case "anchor": {
        const dx = p[0] - g.start[0];
        const dy = p[1] - g.start[1];
        liveFromBase((d) => {
          const n = locate(d as Doc, g.nodeId)?.node;
          if (!n || n.type !== "path") return;
          const [lx, ly] = toLocalDelta(n.m, dx, dy);
          moveSegPoint(n.segs, g.seg, g.part, lx, ly);
        });
        break;
      }
      case "pen": {
        // Dragging after placing an anchor pulls out symmetric handles.
        const [ax, ay] = g.anchor;
        if (Math.hypot(p[0] - ax, p[1] - ay) * useEditor.getState().view.zoom < 3) break;
        const out: [number, number] = [p[0], p[1]];
        const inH: [number, number] = [2 * ax - p[0], 2 * ay - p[1]];
        liveFromBase((d) => {
          const n = locate(d as Doc, g.nodeId)?.node as PathNode | undefined;
          if (!n) return;
          const last = n.segs.at(-1)!;
          if (n.segs.length === 1) return;
          if (last.c === "L") n.segs[n.segs.length - 1] = { c: "C", p: [...prevPoint(n.segs, n.segs.length - 1), inH[0], inH[1], ax, ay] };
          else if (last.c === "C") last.p = [last.p[0], last.p[1], inH[0], inH[1], ax, ay];
        });
        setPen((prev) => (prev ? { ...prev, out, firstOut: isFirstAnchor(prev, g.anchor) ? out : prev.firstOut } : prev));
        break;
      }
    }
  };

  const onPointerUp = (e: RPointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    setGesturing(false);
    setActiveCursor(null);
    if (!g) return;
    const st = useEditor.getState();
    const d = st.doc!;
    switch (g.type) {
      case "move":
      case "scale":
      case "rotate":
      case "anchor":
        endTx();
        break;
      case "pen":
        endTx();
        break;
      case "marquee": {
        setMarquee(null);
        const p = toDoc(e.clientX, e.clientY);
        const box: BBox = { x: Math.min(g.start[0], p[0]), y: Math.min(g.start[1], p[1]), w: Math.abs(p[0] - g.start[0]), h: Math.abs(p[1] - g.start[1]) };
        if (box.w * st.view.zoom < 3 && box.h * st.view.zoom < 3) {
          if (!g.additive && st.isolation && !hitId(e.target)) useEditor.setState({ isolation: null });
          break;
        }
        const hits = marqueeHits(d, box, st.tool === "direct" ? "leaf" : "top", st.isolation);
        select(g.additive ? [...new Set([...st.selection, ...hits])] : hits);
        break;
      }
      case "shape": {
        const prev = shapePreview;
        setShapePreview(null);
        if (!prev) break;
        const [x0, y0] = prev.a;
        const [x1, y1] = prev.b;
        const w = Math.abs(x1 - x0);
        const h = Math.abs(y1 - y0);
        if (Math.hypot(w, h) * st.view.zoom < 3) break;
        const x = Math.min(x0, x1);
        const y = Math.min(y0, y1);
        const ab = artboardAt(d, g.start[0], g.start[1], st.activeArtboard);
        const node: PathNode = {
          ...basePath(st.defaultFill, st.defaultStroke, st.defaultStrokeWidth),
          name: g.kind === "rect" ? "<Rectángulo>" : g.kind === "ellipse" ? "<Elipse>" : "<Línea>",
          m: [1, 0, 0, 1, x, y],
          segs:
            g.kind === "rect"
              ? rectSegs(0, 0, w, h)
              : g.kind === "ellipse"
                ? ellipseSegs(w / 2, h / 2, w / 2, h / 2)
                : [
                    { c: "M", p: [x0 - x, y0 - y] },
                    { c: "L", p: [x1 - x, y1 - y] },
                  ],
        };
        if (g.kind === "line") node.fill = null;
        commit((dd) => insertNode(dd as Doc, node, st.activeLayer, ab, st.isolation));
        select([node.id]);
        break;
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const st = useEditor.getState();
    if (st.tool !== "select" && st.tool !== "direct") return;
    const d = st.doc!;
    // Pointer capture retargets the event to the canvas, so hit-test by position.
    const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.closest(".content [data-id]"));
    const leaf = hitId(under ?? null);
    if (!leaf) {
      useEditor.setState({ isolation: null });
      return;
    }
    const leafNode = locate(d, leaf)?.node;
    if (leafNode?.type === "text") {
      select([leaf]);
      useEditor.setState({ editingText: leaf });
      return;
    }
    // Enter the group (isolation mode) and select the child under the cursor.
    const top = resolveSelectable(d, leaf, "top", st.isolation);
    const topNode = top ? locate(d, top)?.node : null;
    if (topNode?.type === "group") {
      useEditor.setState({ isolation: topNode.id });
      const inner = resolveSelectable(d, leaf, "top", topNode.id);
      select(inner ? [inner] : []);
    }
  };

  // ---------- overlays ----------
  const renderOpts = useMemo<RenderOptions>(
    () => ({
      mode: "screen",
      artboards: doc.artboards,
      clipArtboards,
      hidden: editingText ? new Set([editingText]) : undefined,
      onTextMeasured: bumpMetrics,
    }),
    [doc.artboards, clipArtboards, editingText],
  );

  const selBox = selection.length ? selectionBBox(doc, selection) : null;
  const layerColor = (id: string) => (locate(doc, id)?.path[0]?.color as string | undefined) ?? "#4f8cff";
  const selColor = selection.length ? layerColor(selection[0]) : "#4f8cff";
  const showTransformBox = (tool === "select" || (tool === "direct" && selection.length > 1)) && selBox && !editingText;
  const directPaths =
    tool === "direct" || tool === "pen" ? getNodes(doc, selection).filter((n): n is PathNode => n.type === "path") : [];

  const cursor =
    activeCursor ??
    (space
      ? "grab"
      : {
          select: "default",
          direct: "default",
          pen: "crosshair",
          rect: "crosshair",
          ellipse: "crosshair",
          line: "crosshair",
          text: "text",
          eyedropper: "copy",
          hand: "grab",
          zoom: "zoom-in",
        }[tool]);

  return (
    <div
      ref={ref}
      className="canvas"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg width={size.w} height={size.h} className="canvas-svg">
        <defs>
          <filter id="ab-shadow" x="-10%" y="-10%" width="120%" height="120%">
            <feDropShadow dx="0" dy="1" stdDeviation="3" floodOpacity="0.35" />
          </filter>
        </defs>
        <g transform={`translate(${view.panX} ${view.panY}) scale(${view.zoom})`}>
          {doc.artboards.map((ab, i) => (
            <rect key={ab.id} data-artboard={i} x={ab.x} y={ab.y} width={ab.width} height={ab.height} fill="#fff" filter="url(#ab-shadow)" />
          ))}
          <RenderContext.Provider value={renderOpts}>
            <g className={isolation ? "content isolating" : "content"}>
              {doc.layers.map((l) => (
                <NodeView key={l.id} node={l} />
              ))}
            </g>
          </RenderContext.Provider>
        </g>

        {/* ---- screen-space overlay ---- */}
        <g className="overlay">
          {doc.artboards.map((ab, i) => (
            <g key={ab.id}>
              <rect
                x={ab.x * view.zoom + view.panX}
                y={ab.y * view.zoom + view.panY}
                width={ab.width * view.zoom}
                height={ab.height * view.zoom}
                fill="none"
                stroke={i === useEditor.getState().activeArtboard ? "#1d1d1d" : "rgba(0,0,0,0.25)"}
                strokeWidth={i === useEditor.getState().activeArtboard ? 1.5 : 1}
              />
              <text
                x={ab.x * view.zoom + view.panX}
                y={ab.y * view.zoom + view.panY - 6}
                className="ab-label"
                data-artboard={i}
                style={{ pointerEvents: "all" }}
              >
                {i + 1} - {ab.name}
              </text>
            </g>
          ))}

          {hover && !selection.includes(hover) && !gesturing ? <Outline doc={doc} id={hover} screenM={screenM} color={layerColor(hover)} width={2} /> : null}

          {selection.map((id) => (
            <Outline key={id} doc={doc} id={id} screenM={screenM} color={layerColor(id)} width={1} boxOnly={tool === "select" && selection.length > 0} />
          ))}

          {showTransformBox && selBox ? <TransformBox box={toScreenBox(selBox)} color={selColor} /> : null}

          {directPaths.map((n) => (
            <Anchors key={n.id} node={n} screenM={screenM} color={layerColor(n.id)} />
          ))}

          {pen && tool === "pen" && cursorDoc && !gesturing ? (
            <PenPreview doc={doc} pen={pen} cursor={cursorDoc} screenM={screenM} />
          ) : null}

          {marquee ? (
            <rect
              x={toScreenBox(marquee).x}
              y={toScreenBox(marquee).y}
              width={toScreenBox(marquee).w}
              height={toScreenBox(marquee).h}
              fill="rgba(79,140,255,0.08)"
              stroke="#4f8cff"
              strokeDasharray="4 3"
            />
          ) : null}

          {shapePreview ? <ShapePreview preview={shapePreview} screenM={screenM} /> : null}
        </g>
      </svg>

      {editingText ? <TextEditor id={editingText} screenM={screenM} /> : null}
      {isolation ? <IsolationBar doc={doc} id={isolation} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function basePath(fill: PathNode["fill"], stroke: PathNode["stroke"], strokeWidth: number): PathNode {
  return {
    id: newId(),
    type: "path",
    visible: true,
    locked: false,
    opacity: 1,
    blend: "normal",
    segs: [],
    m: [1, 0, 0, 1, 0, 0],
    fill,
    fillOpacity: 1,
    fillRule: "nonzero",
    stroke,
    strokeOpacity: 1,
    strokeWidth,
    lineCap: "butt",
    lineJoin: "miter",
    miterLimit: 10,
    dash: [],
    dashOffset: 0,
  };
}

function lastPoint(segs: Seg[]): [number, number] {
  for (let i = segs.length - 1; i >= 0; i--) {
    const p = segs[i].p;
    if (p.length) return [p[p.length - 2], p[p.length - 1]];
  }
  return [0, 0];
}

function prevPoint(segs: Seg[], i: number): [number, number] {
  return lastPoint(segs.slice(0, i));
}

function isFirstAnchor(pen: PenState, anchor: [number, number]) {
  return pen.first[0] === anchor[0] && pen.first[1] === anchor[1];
}

/** Moves an anchor (with its handles) or a single control point of a path, in local units. */
function moveSegPoint(segs: Seg[], i: number, part: "end" | "c1" | "c2", dx: number, dy: number) {
  const s = segs[i];
  if (!s) return;
  const shift = (seg: Seg | undefined, k: number) => {
    if (!seg || seg.p.length <= k + 1) return;
    seg.p[k] += dx;
    seg.p[k + 1] += dy;
  };
  if (part === "c1") return shift(s, 0);
  if (part === "c2") return shift(s, 2);
  const endK = s.p.length - 2;
  shift(s, endK);
  if (s.c === "C") shift(s, 2);
  if (segs[i + 1]?.c === "C") shift(segs[i + 1], 0);
  // Closed subpath: the closing anchor coincides with the starting M.
  if (s.c === "M") {
    let j = i + 1;
    while (j < segs.length && segs[j].c !== "M" && segs[j].c !== "Z") j++;
    const last = segs[j - 1];
    if (segs[j]?.c === "Z" && j - 1 > i && last.p.length) {
      const lk = last.p.length - 2;
      if (Math.abs(last.p[lk] - (s.p[0] - dx)) < 1e-6 && Math.abs(last.p[lk + 1] - (s.p[1] - dy)) < 1e-6) {
        shift(last, lk);
        if (last.c === "C") shift(last, 2);
      }
    }
  }
}

function marqueeHits(doc: Doc, box: BBox, mode: "top" | "leaf", isolation: string | null): string[] {
  const out = new Set<string>();
  for (const [n] of walk(doc.layers)) {
    if (n.type === "group") continue;
    const b = nodeBBox(n);
    if (!b || !bboxIntersects(b, box)) continue;
    const id = resolveSelectable(doc, n.id, mode, isolation);
    if (id) out.add(id);
  }
  return [...out];
}

function Outline({ doc, id, screenM, color, width, boxOnly }: { doc: Doc; id: string; screenM: Mat; color: string; width: number; boxOnly?: boolean }) {
  const node = locate(doc, id)?.node;
  if (!node) return null;
  if (node.type === "path" && !boxOnly) {
    return <path d={segsToD(node.segs)} transform={toSvg(mul(screenM, node.m))} fill="none" stroke={color} strokeWidth={width} vectorEffect="non-scaling-stroke" />;
  }
  const b = nodeBBox(node);
  if (!b) return null;
  const [x, y] = apply(screenM, b.x, b.y);
  return <rect x={x} y={y} width={b.w * screenM[0]} height={b.h * screenM[3]} fill="none" stroke={color} strokeWidth={width} opacity={boxOnly ? 0.6 : 1} />;
}

function TransformBox({ box, color }: { box: BBox; color: string }) {
  return (
    <g>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="none" stroke={color} strokeWidth={1} />
      {(["nw", "ne", "se", "sw"] as Handle[]).map((h) => {
        const [x, y] = handlePos(box, h);
        return <circle key={"r" + h} data-handle={"rot-" + h} cx={x} cy={y} r={16} fill="transparent" style={{ cursor: ROTATE_CURSOR, pointerEvents: "all" }} />;
      })}
      {HANDLES.map((h) => {
        const [x, y] = handlePos(box, h);
        return (
          <rect
            key={h}
            data-handle={h}
            x={x - 4}
            y={y - 4}
            width={8}
            height={8}
            fill="#fff"
            stroke={color}
            strokeWidth={1}
            style={{ cursor: HANDLE_CURSOR[h], pointerEvents: "all" }}
          />
        );
      })}
    </g>
  );
}

function Anchors({ node, screenM, color }: { node: PathNode; screenM: Mat; color: string }) {
  const M = mul(screenM, node.m);
  const items: React.ReactNode[] = [];
  let prev: [number, number] = [0, 0];
  node.segs.forEach((s, i) => {
    if (!s.p.length) return;
    const k = s.p.length - 2;
    const [ex, ey] = apply(M, s.p[k], s.p[k + 1]);
    if (s.c === "C") {
      const [c1x, c1y] = apply(M, s.p[0], s.p[1]);
      const [c2x, c2y] = apply(M, s.p[2], s.p[3]);
      items.push(
        <g key={"h" + i}>
          <line x1={prev[0]} y1={prev[1]} x2={c1x} y2={c1y} stroke={color} strokeWidth={1} />
          <line x1={ex} y1={ey} x2={c2x} y2={c2y} stroke={color} strokeWidth={1} />
          <circle data-handle={`anchor:${node.id}:${i}:c1`} cx={c1x} cy={c1y} r={3.5} fill={color} style={{ pointerEvents: "all", cursor: "move" }} />
          <circle data-handle={`anchor:${node.id}:${i}:c2`} cx={c2x} cy={c2y} r={3.5} fill={color} style={{ pointerEvents: "all", cursor: "move" }} />
        </g>,
      );
    }
    items.push(
      <rect
        key={"a" + i}
        data-handle={`anchor:${node.id}:${i}:end`}
        x={ex - 3.5}
        y={ey - 3.5}
        width={7}
        height={7}
        fill="#fff"
        stroke={color}
        style={{ pointerEvents: "all", cursor: "move" }}
      />,
    );
    prev = [ex, ey];
  });
  return (
    <g>
      <path d={segsToD(node.segs)} transform={toSvg(M)} fill="none" stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {items}
    </g>
  );
}

function PenPreview({ doc, pen, cursor, screenM }: { doc: Doc; pen: PenState; cursor: [number, number]; screenM: Mat }) {
  const node = locate(doc, pen.nodeId)?.node;
  if (!node || node.type !== "path") return null;
  const last = lastPoint(node.segs);
  const [ax, ay] = apply(screenM, last[0], last[1]);
  const [bx, by] = apply(screenM, cursor[0], cursor[1]);
  const [fx, fy] = apply(screenM, pen.first[0], pen.first[1]);
  const nearFirst = Math.hypot(bx - fx, by - fy) < 8 && node.segs.length > 1;
  let d = `M${ax} ${ay} L${bx} ${by}`;
  if (pen.out) {
    const [ox, oy] = apply(screenM, pen.out[0], pen.out[1]);
    d = `M${ax} ${ay} C${ox} ${oy} ${bx} ${by} ${bx} ${by}`;
  }
  return (
    <g>
      <path d={d} fill="none" stroke="#4f8cff" strokeWidth={1} />
      {nearFirst ? <circle cx={fx} cy={fy} r={6} fill="none" stroke="#4f8cff" /> : null}
    </g>
  );
}

function ShapePreview({ preview, screenM }: { preview: { kind: "rect" | "ellipse" | "line"; a: [number, number]; b: [number, number] }; screenM: Mat }) {
  const [ax, ay] = apply(screenM, ...preview.a);
  const [bx, by] = apply(screenM, ...preview.b);
  const x = Math.min(ax, bx);
  const y = Math.min(ay, by);
  const w = Math.abs(bx - ax);
  const h = Math.abs(by - ay);
  const props = { fill: "none", stroke: "#4f8cff", strokeWidth: 1 };
  if (preview.kind === "line") return <line x1={ax} y1={ay} x2={bx} y2={by} {...props} />;
  if (preview.kind === "ellipse") return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...props} />;
  return <rect x={x} y={y} width={w} height={h} {...props} />;
}

function TextEditor({ id, screenM }: { id: string; screenM: Mat }) {
  const node = useEditor((s) => (s.doc ? locate(s.doc, id)?.node : null)) as TextNode | null;
  const [value, setValue] = useState(node?.text ?? "");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const committed = useRef(false);

  useEffect(() => {
    taRef.current?.focus();
    taRef.current?.select();
  }, []);

  if (!node || node.type !== "text") return null;
  const finish = () => {
    if (committed.current) return;
    committed.current = true;
    const current = locate(useEditor.getState().doc!, id)?.node as TextNode | undefined;
    if (current) {
      if (!value.trim()) {
        commit((d) => {
          const loc = locate(d as Doc, id);
          if (loc) loc.list.splice(loc.index, 1);
        });
        select([]);
      } else if (value !== current.text) {
        updateNode(id, (n) => {
          if (n.type !== "text") return;
          n.text = value;
          n.glyphs = undefined;
        });
      }
    }
    useEditor.setState({ editingText: null });
  };
  const M = mul(screenM, node.m);
  const lines = value.split("\n");
  const fill = node.fill?.kind === "solid" ? node.fill.color : node.fill ? node.fill.stops[0]?.color : "#000";
  return (
    <textarea
      ref={taRef}
      className="text-editor"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={finish}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          finish();
        }
      }}
      rows={lines.length}
      style={{
        transform: `matrix(${M.join(",")}) translateY(${-node.fontSize * 0.95}px)`,
        fontSize: node.fontSize,
        lineHeight: 1.2,
        letterSpacing: node.letterSpacing,
        color: fill,
        width: `${Math.max(2, ...lines.map((l) => l.length + 1)) * node.fontSize * 0.62}px`,
        ...editingFont(node),
      }}
    />
  );
}

function IsolationBar({ doc, id }: { doc: Doc; id: string }) {
  const loc = locate(doc, id);
  if (!loc) return null;
  const names = [...loc.path, loc.node].map((n) => n.name ?? (n.type === "group" ? (n as GroupNode).clip ? "<Grupo de recorte>" : "<Grupo>" : n.type));
  return (
    <div className="isolation-bar" onPointerDown={(e) => e.stopPropagation()}>
      <button onClick={() => useEditor.setState({ isolation: null, selection: [id] })}>← Salir del grupo</button>
      <span>{names.join(" › ")}</span>
    </div>
  );
}
