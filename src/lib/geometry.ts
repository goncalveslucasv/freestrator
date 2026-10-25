import { apply, mul, type Mat } from "./matrix";
import type { Seg, SceneNode, GroupNode, Doc } from "./types";

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const fmt = (n: number) => +n.toFixed(4);

export function segsToD(segs: Seg[]): string {
  let d = "";
  for (const s of segs) d += s.c + (s.p.length ? s.p.map(fmt).join(" ") : "") + " ";
  return d.trim();
}

export function rectSegs(x: number, y: number, w: number, h: number): Seg[] {
  return [
    { c: "M", p: [x, y] },
    { c: "L", p: [x + w, y] },
    { c: "L", p: [x + w, y + h] },
    { c: "L", p: [x, y + h] },
    { c: "Z", p: [] },
  ];
}

const K = 0.5522847498;
export function ellipseSegs(cx: number, cy: number, rx: number, ry: number): Seg[] {
  return [
    { c: "M", p: [cx + rx, cy] },
    { c: "C", p: [cx + rx, cy + K * ry, cx + K * rx, cy + ry, cx, cy + ry] },
    { c: "C", p: [cx - K * rx, cy + ry, cx - rx, cy + K * ry, cx - rx, cy] },
    { c: "C", p: [cx - rx, cy - K * ry, cx - K * rx, cy - ry, cx, cy - ry] },
    { c: "C", p: [cx + K * rx, cy - ry, cx + rx, cy - K * ry, cx + rx, cy] },
    { c: "Z", p: [] },
  ];
}

/** Extremes of a 1D cubic bezier on t ∈ (0, 1). */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      ts.push((-b + sq) / (2 * a), (-b - sq) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
};

/** Exact bounding box of a path after applying `m`. */
export function segsBBox(segs: Seg[], m: Mat): BBox | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  let cx = 0,
    cy = 0,
    lx = 0,
    ly = 0;
  for (const s of segs) {
    const p = s.p;
    if (s.c === "M" || s.c === "L") {
      [lx, ly] = [p[0], p[1]];
      [cx, cy] = apply(m, lx, ly);
      add(cx, cy);
    } else if (s.c === "C" || s.c === "Q") {
      // Quadratics are elevated to cubics; affine maps preserve beziers.
      const c = s.c === "Q" ? quadToCubic(lx, ly, p) : p;
      [lx, ly] = [c[4], c[5]];
      const [ax, ay] = apply(m, c[0], c[1]);
      const [bx, by] = apply(m, c[2], c[3]);
      const [ex, ey] = apply(m, c[4], c[5]);
      add(ex, ey);
      for (const t of cubicExtrema(cx, ax, bx, ex)) add(cubicAt(cx, ax, bx, ex, t), cubicAt(cy, ay, by, ey, t));
      for (const t of cubicExtrema(cy, ay, by, ey)) add(cubicAt(cx, ax, bx, ex, t), cubicAt(cy, ay, by, ey, t));
      cx = ex;
      cy = ey;
    }
  }
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Elevates a quadratic segment starting at (x0, y0) to cubic control points. */
export function quadToCubic(x0: number, y0: number, p: number[]): number[] {
  const [qx, qy, x, y] = p;
  return [x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y];
}

export function transformBBox(b: BBox, m: Mat): BBox {
  const pts = [apply(m, b.x, b.y), apply(m, b.x + b.w, b.y), apply(m, b.x, b.y + b.h), apply(m, b.x + b.w, b.y + b.h)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function unionBBox(a: BBox | null, b: BBox | null): BBox | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function intersectBBox(a: BBox | null, b: BBox | null): BBox | null {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 < x || y2 < y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

export const bboxIntersects = (a: BBox, b: BBox) =>
  a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

export const bboxContains = (outer: BBox, inner: BBox, eps = 0.5) =>
  inner.x >= outer.x - eps &&
  inner.y >= outer.y - eps &&
  inner.x + inner.w <= outer.x + outer.w + eps &&
  inner.y + inner.h <= outer.y + outer.h + eps;

/** Local bounding boxes of rendered text, measured from the DOM (keyed by node id). */
export const textMetrics = new Map<string, BBox>();

export function textLocalBBox(n: Extract<SceneNode, { type: "text" }>): BBox {
  const measured = textMetrics.get(n.id);
  if (measured) return measured;
  const lines = n.text.split("\n");
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const w = n.glyphs ? (n.glyphs.xs.at(-1) ?? 0) + n.fontSize * 0.6 : longest * n.fontSize * 0.6;
  return { x: 0, y: -n.fontSize * 0.8, w, h: n.fontSize * (1 + (lines.length - 1) * 1.2) };
}

export function nodeBBox(n: SceneNode): BBox | null {
  if (!n.visible) return null;
  switch (n.type) {
    case "path": {
      const b = segsBBox(n.segs, n.m);
      if (!b || !n.stroke || !n.strokeWidth) return b;
      const half = (n.strokeWidth * Math.sqrt(Math.abs(n.m[0] * n.m[3] - n.m[1] * n.m[2]))) / 2;
      return { x: b.x - half, y: b.y - half, w: b.w + 2 * half, h: b.h + 2 * half };
    }
    case "image":
      return transformBBox({ x: 0, y: 0, w: 1, h: 1 }, n.m);
    case "text":
      return transformBBox(textLocalBBox(n), n.m);
    case "group": {
      let b: BBox | null = null;
      for (const c of n.children) b = unionBBox(b, nodeBBox(c));
      if (n.clip) b = intersectBBox(b, segsBBox(n.clip.segs, n.clip.m));
      return b;
    }
  }
}

export function nodesBBox(nodes: SceneNode[]): BBox | null {
  let b: BBox | null = null;
  for (const n of nodes) b = unionBBox(b, nodeBBox(n));
  return b;
}

/** Applies a document-space transform `D` to a node (in place, for use inside immer drafts). */
export function transformNode(n: SceneNode, D: Mat) {
  switch (n.type) {
    case "path":
    case "image":
    case "text":
      // Paints live in node-local space, so they follow the node automatically.
      n.m = mul(D, n.m);
      break;
    case "group":
      for (const c of n.children) transformNode(c, D);
      if (n.clip) n.clip.m = mul(D, n.clip.m);
      if (n.mask) for (const c of n.mask.nodes) transformNode(c, D);
      break;
  }
}

// ---------- tree helpers ----------

export function* walk(nodes: SceneNode[], parent: GroupNode | null = null): Generator<[SceneNode, GroupNode | null]> {
  for (const n of nodes) {
    yield [n, parent];
    if (n.type === "group") yield* walk(n.children, n);
  }
}

export function findNode(doc: Doc, id: string): SceneNode | null {
  for (const [n] of walk(doc.layers)) if (n.id === id) return n;
  return null;
}

export function parentMap(doc: Doc): Map<string, GroupNode | null> {
  const map = new Map<string, GroupNode | null>();
  for (const [n, p] of walk(doc.layers)) map.set(n.id, p);
  return map;
}

let idCounter = 0;
export const newId = (prefix = "n") => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/** Deep clone with fresh ids. */
export function cloneNode<T extends SceneNode>(n: T): T {
  const copy = structuredClone(n);
  const reid = (x: SceneNode) => {
    x.id = newId();
    if (x.type === "group") {
      x.children.forEach(reid);
      x.mask?.nodes.forEach(reid);
    }
  };
  reid(copy);
  return copy;
}

export function defaultName(n: SceneNode): string {
  if (n.name) return n.name;
  switch (n.type) {
    case "path":
      return "<Trazado>";
    case "image":
      return "<Imagen>";
    case "text":
      return n.text.slice(0, 40) || "<Texto>";
    case "group":
      if (n.clip) return "<Grupo de recorte>";
      if (n.mask) return "<Grupo con máscara>";
      return "<Grupo>";
  }
}
