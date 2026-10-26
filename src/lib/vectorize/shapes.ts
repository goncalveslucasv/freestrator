// Recognises traced outlines that are really primitives (rectangle, rounded rectangle, ellipse) and
// replaces them with exact geometry.

import { ellipseSegs, rectSegs } from "../geometry";
import type { Seg } from "../types";
import type { Contour } from "./trace";

export type PrimitiveKind = "rect" | "roundrect" | "ellipse";

export interface Primitive {
  kind: PrimitiveKind;
  segs: Seg[];
}

const K = 0.5522847498;

export function roundRectSegs(x: number, y: number, w: number, h: number, r: number): Seg[] {
  const k = r * (1 - K);
  return [
    { c: "M", p: [x + r, y] },
    { c: "L", p: [x + w - r, y] },
    { c: "C", p: [x + w - k, y, x + w, y + k, x + w, y + r] },
    { c: "L", p: [x + w, y + h - r] },
    { c: "C", p: [x + w, y + h - k, x + w - k, y + h, x + w - r, y + h] },
    { c: "L", p: [x + r, y + h] },
    { c: "C", p: [x + k, y + h, x, y + h - k, x, y + h - r] },
    { c: "L", p: [x, y + r] },
    { c: "C", p: [x, y + k, x + k, y, x + r, y] },
    { c: "Z", p: [] },
  ];
}

/** Checks an outer outline against the primitives, in pixel units. `tol` is the allowed max deviation. */
export function fitPrimitive(c: Contour, tol = 1): Primitive | null {
  const P = c.pts;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of P) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const w = x1 - x0,
    h = y1 - y0;
  if (w < 3 || h < 3) return null;
  const area = Math.abs(c.area);
  // Edge midpoints: where the true outline most likely passes.
  const mids = P.map((p, i) => {
    const q = P[(i + 1) % P.length];
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as const;
  });
  // Robust check: a few notches (compression artefacts) may stray, but not far.
  const within = (dist: (x: number, y: number) => number, maxDev: number, meanDev: number) => {
    let sum = 0,
      outliers = 0;
    for (const [x, y] of mids) {
      const d = Math.abs(dist(x, y));
      if (d > maxDev * 3) return false;
      if (d > maxDev) outliers++;
      else sum += d;
    }
    return outliers <= mids.length * 0.03 && sum / (mids.length - outliers) <= meanDev;
  };

  // Tolerances grow a little with size: big shapes carry more absolute noise (compression blocks).
  const size = Math.min(w, h);
  const maxDev = Math.max(tol, size * 0.03),
    meanDev = Math.max(0.35, size * 0.012);

  // Rectangle: every point on the bounding box.
  if (area >= 0.97 * w * h && within((x, y) => Math.min(x - x0, x1 - x, y - y0, y1 - y), Math.max(0.75, size * 0.02), Math.max(0.2, size * 0.008))) {
    return { kind: "rect", segs: rectSegs(x0, y0, w, h) };
  }

  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2,
    rx = w / 2,
    ry = h / 2;
  // Ellipse: distance approximated by the radial error.
  const ellipseArea = Math.PI * rx * ry;
  if (Math.abs(area - ellipseArea) / ellipseArea < 0.06) {
    const dist = (x: number, y: number) => {
      const dx = x - cx,
        dy = y - cy;
      const rho = Math.hypot(dx / rx, dy / ry);
      return rho ? (rho - 1) * (Math.hypot(dx, dy) / rho) : Math.min(rx, ry);
    };
    if (within(dist, maxDev, meanDev)) return { kind: "ellipse", segs: ellipseSegs(cx, cy, rx, ry) };
  }

  // Rounded rectangle: the corner radius follows from the missing area.
  const missing = w * h - area;
  if (missing > 0) {
    const r = Math.sqrt(missing / (4 - Math.PI));
    if (r >= 1.5 && r <= Math.min(rx, ry) * 0.98) {
      const hx = rx - r,
        hy = ry - r;
      const sdf = (x: number, y: number) => {
        const qx = Math.abs(x - cx) - hx,
          qy = Math.abs(y - cy) - hy;
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      };
      if (within(sdf, maxDev, meanDev)) return { kind: "roundrect", segs: roundRectSegs(x0, y0, w, h, r) };
    }
  }
  return null;
}
