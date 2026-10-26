// Turns a label map into editable shapes. Each connected region becomes one shape with its holes
// filled (what shows through a hole is drawn on top of it), ordered by nesting depth. To avoid
// hairline gaps between neighbours, a shape also reaches 1 px under the neighbours drawn after it.

import type { Seg } from "../types";
import { fitPrimitive, type PrimitiveKind } from "./shapes";
import { fitContour, traceContours, type FitOptions } from "./trace";

export interface Region {
  label: number;
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  depth: number;
  touchesBorder: boolean;
}

export interface Shape {
  region: Region;
  /** Outline in label-map pixel coordinates. */
  segs: Seg[];
  primitive?: PrimitiveKind;
}

/** 4-connected regions of equal label. */
export function findRegions(labels: Uint8Array, W: number, H: number) {
  const n = W * H;
  const comp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const regions: Region[] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const id = regions.length;
    const label = labels[s];
    let head = 0,
      size = 0;
    queue[size++] = s;
    comp[s] = id;
    let x0 = W,
      y0 = H,
      x1 = 0,
      y1 = 0;
    while (head < size) {
      const p = queue[head++];
      const x = p % W,
        y = (p - x) / W;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const visit = (q: number) => {
        if (labels[q] === label && comp[q] < 0) {
          comp[q] = id;
          queue[size++] = q;
        }
      };
      if (x > 0) visit(p - 1);
      if (x + 1 < W) visit(p + 1);
      if (y > 0) visit(p - W);
      if (y + 1 < H) visit(p + W);
    }
    regions.push({ label, area: size, x0, y0, x1: x1 + 1, y1: y1 + 1, depth: 0, touchesBorder: x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1 });
  }
  return { comp, regions };
}

/** Region `id` with its holes filled, as a mask over its bounding box plus `pad` pixels. */
function filledMask(comp: Int32Array, W: number, H: number, r: Region, id: number, pad: number) {
  const w = r.x1 - r.x0 + 2 * pad,
    h = r.y1 - r.y0 + 2 * pad;
  const ox = r.x0 - pad,
    oy = r.y0 - pad;
  const mask = new Uint8Array(w * h);
  for (let y = Math.max(0, oy); y < Math.min(H, oy + h); y++) {
    for (let x = Math.max(0, ox); x < Math.min(W, ox + w); x++) if (comp[y * W + x] === id) mask[(y - oy) * w + (x - ox)] = 1;
  }
  // Flood the outside from the frame; whatever isn't reached is the region or one of its holes.
  const outside = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let size = 0;
  const seed = (i: number) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      queue[size++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  for (let head = 0; head < size; head++) {
    const p = queue[head];
    const x = p % w;
    if (x > 0) seed(p - 1);
    if (x + 1 < w) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p + w < w * h) seed(p + w);
  }
  for (let i = 0; i < w * h; i++) mask[i] = outside[i] ? 0 : 1;
  return { mask, w, h, ox, oy };
}

export interface ShapeOptions {
  fit: FitOptions;
  fitShapes: boolean;
  /** Regions to leave out (e.g. the background). */
  skip?: (r: Region) => boolean;
}

export function buildShapes(labels: Uint8Array, W: number, H: number, opts: ShapeOptions): { shapes: Shape[]; regions: Region[] } {
  const { comp, regions } = findRegions(labels, W, H);

  // Nesting depth: how many regions have this one inside a hole.
  const stamp = new Int32Array(regions.length).fill(-1);
  regions.forEach((r, id) => {
    if (r.x1 - r.x0 < 3 || r.y1 - r.y0 < 3) return;
    const f = filledMask(comp, W, H, r, id, 0);
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        if (!f.mask[y * f.w + x]) continue;
        const other = comp[(y + f.oy) * W + x + f.ox];
        if (other !== id && stamp[other] !== id) {
          stamp[other] = id;
          regions[other].depth++;
        }
      }
    }
  });

  const order = regions.map((_, i) => i).sort((a, b) => regions[a].depth - regions[b].depth || regions[b].area - regions[a].area || a - b);
  const rank = new Int32Array(regions.length);
  order.forEach((id, i) => (rank[id] = i));

  const shapes: Shape[] = [];
  for (const id of order) {
    const r = regions[id];
    if (opts.skip?.(r)) continue;
    const f = filledMask(comp, W, H, r, id, 2);
    const shift = (segs: Seg[]) => segs.map((s) => ({ c: s.c, p: s.p.map((v, k) => v + (k % 2 ? f.oy : f.ox)) }));
    const outer = (contours: ReturnType<typeof traceContours>) => contours.reduce((a, b) => (b.area > (a?.area ?? 0) ? b : a), contours[0]);

    if (opts.fitShapes) {
      const c = outer(traceContours(f.mask, f.w, f.h));
      const prim = c && fitPrimitive(c);
      if (prim) {
        shapes.push({ region: r, segs: shift(prim.segs), primitive: prim.kind });
        continue;
      }
    }

    // Reach 1 px under neighbours that are drawn later.
    const grown = f.mask.slice();
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        if (f.mask[y * f.w + x]) continue;
        const gx = x + f.ox,
          gy = y + f.oy;
        if (gx < 0 || gy < 0 || gx >= W || gy >= H || rank[comp[gy * W + gx]] < rank[id]) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) {
          for (let dx = -1; dx <= 1 && !near; dx++) {
            const xx = x + dx,
              yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < f.w && yy < f.h && f.mask[yy * f.w + xx]) near = true;
          }
        }
        if (near) grown[y * f.w + x] = 1;
      }
    }
    const c = outer(traceContours(grown, f.w, f.h));
    if (c) shapes.push({ region: r, segs: shift(fitContour(c, opts.fit)) });
  }
  return { shapes, regions };
}
