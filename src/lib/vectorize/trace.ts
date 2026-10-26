// Outline tracing: pixel-edge contours of a binary mask, then corners + least-squares cubic bezier
// fitting (P. J. Schneider, "An Algorithm for Automatically Fitting Digitized Curves", Graphics
// Gems, 1990).

import type { Seg } from "../types";

type Pt = [number, number];

export interface Contour {
  /** Vertices of the pixel-edge polygon, one per unit step, closed implicitly. */
  pts: Pt[];
  /** Signed area in px² (positive = outer outline, negative = hole). */
  area: number;
}

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * Closed outlines of the set pixels in `mask` (w×h). Edges run with the inside on their right, so
 * outer outlines and holes come out with opposite orientation. Pixels touching only diagonally are
 * separate regions (4-connectivity), matching the region labelling.
 */
export function traceContours(mask: Uint8Array, w: number, h: number): Contour[] {
  const VW = w + 1;
  // Bit d set at vertex v = there is an unused edge leaving v in direction d.
  const out = new Uint8Array(VW * (h + 1));
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!inside(x, y - 1)) out[y * VW + x] |= 1; // top, going right
      if (!inside(x + 1, y)) out[y * VW + x + 1] |= 2; // right, going down
      if (!inside(x, y + 1)) out[(y + 1) * VW + x + 1] |= 4; // bottom, going left
      if (!inside(x - 1, y)) out[(y + 1) * VW + x] |= 8; // left, going up
    }
  }
  // The turn choice uses every edge (used or not), so a walk closes exactly where it started.
  const all = out.slice();
  const contours: Contour[] = [];
  for (let v0 = 0; v0 < out.length; v0++) {
    while (out[v0]) {
      const d0 = out[v0] & 1 ? 0 : out[v0] & 2 ? 1 : out[v0] & 4 ? 2 : 3;
      let d = d0;
      let v = v0;
      const pts: Pt[] = [];
      let area2 = 0;
      for (let guard = 0; guard < 4 * out.length; guard++) {
        out[v] &= ~(1 << d);
        const x = v % VW,
          y = (v - x) / VW;
        pts.push([x, y]);
        const nx = x + DX[d],
          ny = y + DY[d];
        area2 += x * ny - nx * y;
        v = ny * VW + nx;
        // Prefer turning right, then straight, then left.
        const right = (d + 1) & 3,
          left = (d + 3) & 3;
        d = all[v] & (1 << right) ? right : all[v] & (1 << d) ? d : left;
        if ((v === v0 && d === d0) || !(out[v] & (1 << d))) break;
      }
      if (pts.length >= 4) contours.push({ pts, area: area2 / 2 });
    }
  }
  return contours;
}

// ---------- geometry helpers ----------

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mulS = (a: Pt, s: number): Pt => [a[0] * s, a[1] * s];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const norm = (a: Pt): Pt => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0];
};

type Bez = [Pt, Pt, Pt, Pt];

function bezPoint(b: Bez, t: number): Pt {
  const mt = 1 - t;
  const a = mt * mt * mt,
    c1 = 3 * mt * mt * t,
    c2 = 3 * mt * t * t,
    d = t * t * t;
  return [a * b[0][0] + c1 * b[1][0] + c2 * b[2][0] + d * b[3][0], a * b[0][1] + c1 * b[1][1] + c2 * b[2][1] + d * b[3][1]];
}

function chordParams(d: Pt[]): number[] {
  const u = [0];
  for (let i = 1; i < d.length; i++) u.push(u[i - 1] + len(sub(d[i], d[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((x) => x / total);
}

function generateBezier(d: Pt[], u: number[], t1: Pt, t2: Pt): Bez {
  const first = d[0],
    last = d[d.length - 1];
  let c00 = 0,
    c01 = 0,
    c11 = 0,
    x0 = 0,
    x1 = 0;
  for (let i = 0; i < d.length; i++) {
    const t = u[i],
      mt = 1 - t;
    const b0 = mt * mt * mt,
      b1 = 3 * t * mt * mt,
      b2 = 3 * t * t * mt,
      b3 = t * t * t;
    const a1 = mulS(t1, b1),
      a2 = mulS(t2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(d[i], add(mulS(first, b0 + b1), mulS(last, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let al = det ? (x0 * c11 - x1 * c01) / det : 0;
  let ar = det ? (c00 * x1 - c01 * x0) / det : 0;
  const segLen = len(sub(last, first));
  const eps = 1e-6 * segLen;
  if (al < eps || ar < eps) al = ar = segLen / 3;
  return [first, add(first, mulS(t1, al)), add(last, mulS(t2, ar)), last];
}

function maxError(d: Pt[], b: Bez, u: number[]): { err: number; split: number } {
  let err = 0,
    split = Math.floor(d.length / 2);
  for (let i = 1; i < d.length - 1; i++) {
    const p = bezPoint(b, u[i]);
    const e = (p[0] - d[i][0]) ** 2 + (p[1] - d[i][1]) ** 2;
    if (e >= err) {
      err = e;
      split = i;
    }
  }
  return { err, split };
}

function newtonRoot(b: Bez, p: Pt, t: number): number {
  const q = bezPoint(b, t);
  const d1: Pt[] = [0, 1, 2].map((i) => mulS(sub(b[i + 1], b[i]), 3) as Pt);
  const d2: Pt[] = [0, 1].map((i) => mulS(sub(d1[i + 1], d1[i]), 2) as Pt);
  const mt = 1 - t;
  const q1: Pt = add(add(mulS(d1[0], mt * mt), mulS(d1[1], 2 * mt * t)), mulS(d1[2], t * t));
  const q2: Pt = add(mulS(d2[0], mt), mulS(d2[1], t));
  const num = (q[0] - p[0]) * q1[0] + (q[1] - p[1]) * q1[1];
  const den = q1[0] * q1[0] + q1[1] * q1[1] + (q[0] - p[0]) * q2[0] + (q[1] - p[1]) * q2[1];
  if (!den) return t;
  return Math.min(1, Math.max(0, t - num / den));
}

/** Fits cubic beziers (or lines) through `d` with end tangents t1 (out of d[0]) and t2 (into the end, pointing back). */
function fitCubic(d: Pt[], t1: Pt, t2: Pt, errSq: number, out: Bez[], depth = 0) {
  const first = d[0],
    last = d[d.length - 1];
  if (d.length <= 2) {
    const dist = len(sub(last, first)) / 3;
    out.push([first, add(first, mulS(t1, dist)), add(last, mulS(t2, dist)), last]);
    return;
  }
  let u = chordParams(d);
  let bez = generateBezier(d, u, t1, t2);
  let { err, split } = maxError(d, bez, u);
  if (err < errSq) {
    out.push(bez);
    return;
  }
  if (err < errSq * 4) {
    for (let i = 0; i < 4; i++) {
      u = u.map((t, k) => newtonRoot(bez, d[k], t));
      bez = generateBezier(d, u, t1, t2);
      ({ err, split } = maxError(d, bez, u));
      if (err < errSq) {
        out.push(bez);
        return;
      }
    }
  }
  if (depth > 24) {
    out.push(bez);
    return;
  }
  split = Math.min(d.length - 2, Math.max(1, split));
  const center = norm(sub(d[split - 1], d[split + 1]));
  fitCubic(d.slice(0, split + 1), t1, center, errSq, out, depth + 1);
  fitCubic(d.slice(split), mulS(center, -1), t2, errSq, out, depth + 1);
}

/** Largest distance of the points from the chord between the ends. */
function chordDeviation(d: Pt[]): number {
  const a = d[0],
    b = d[d.length - 1];
  const ab = sub(b, a);
  const l = len(ab);
  let m = 0;
  for (const p of d) {
    const e = l ? Math.abs(ab[0] * (p[1] - a[1]) - ab[1] * (p[0] - a[0])) / l : len(sub(p, a));
    if (e > m) m = e;
  }
  return m;
}

export interface FitOptions {
  /** Turn (degrees) above which a point is a corner. */
  cornerAngle: number;
  /** Max squared fitting error, px². */
  errorSq: number;
  /** Gaussian smoothing radius (points) applied between corners before fitting. */
  smooth: number;
  /** Largest window (points) for corner detection on long outlines. */
  cornerWindow: number;
  /** A run is straight if it deviates less than this fraction of its length (or half a pixel). */
  straightness: number;
}

/** Smooths a run of points with a small Gaussian, keeping both ends fixed. */
function smoothRun(pts: Pt[], radius: number): Pt[] {
  if (radius <= 0 || pts.length < 5) return pts;
  const sigma = radius / 2;
  const wts = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return p;
    // Shrink the window near the ends so they stay put.
    const r = Math.min(radius, i, pts.length - 1 - i);
    let x = 0,
      y = 0,
      t = 0;
    for (let k = -r; k <= r; k++) {
      const w = wts[k + radius];
      x += pts[i + k][0] * w;
      y += pts[i + k][1] * w;
      t += w;
    }
    return [x / t, y / t];
  });
}

/** Smooth outline (pixel coordinates) of a traced contour. */
export function fitContour(c: Contour, opts: FitOptions): Seg[] {
  const P = c.pts;
  const N = P.length;
  // Edge midpoints follow diagonal staircases much better than the vertices.
  const m: Pt[] = P.map((p, i) => {
    const q = P[(i + 1) % N];
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  });
  const at = (i: number) => m[((i % N) + N) % N];
  // Window for the turn angle: wider on long outlines, so compression noise doesn't look like corners.
  const k = N < 16 ? 1 : N < 40 ? 2 : Math.min(opts.cornerWindow, Math.max(3, Math.round(N / 100)));

  // Turn angle at every point, over a window of k steps.
  const turn = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = norm(sub(at(i), at(i - k)));
    const b = norm(sub(at(i + k), at(i)));
    turn[i] = (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
  }
  const corners: number[] = [];
  for (let i = 0; i < N; i++) {
    if (turn[i] < opts.cornerAngle) continue;
    let isMax = true;
    for (let j = -k; j <= k && isMax; j++) {
      if (!j) continue;
      const t = turn[((i + j) % N + N) % N];
      if (t > turn[i] || (t === turn[i] && j < 0)) isMax = false;
    }
    if (isMax) corners.push(i);
  }

  // Corner position: where the straight runs on either side meet (sharp pixel-art corners).
  const cornerPoint = (i: number): Pt => {
    const a0 = at(i - k - 1),
      a1 = at(i - 1),
      b0 = at(i + 1),
      b1 = at(i + k + 1);
    const r = sub(a1, a0),
      s = sub(b1, b0);
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-9) return at(i);
    const t = ((b0[0] - a0[0]) * s[1] - (b0[1] - a0[1]) * s[0]) / den;
    const p = add(a0, mulS(r, t));
    return len(sub(p, at(i))) < 1.5 ? p : at(i);
  };

  const tangentAt = (i: number): Pt => norm(sub(at(i + k), at(i - k)));
  const runs: { pts: Pt[]; t1: Pt; t2: Pt }[] = [];
  if (corners.length === 0) {
    // Smooth closed curve: four pieces with matching tangents at the joins.
    const cuts = [0, Math.floor(N / 4), Math.floor(N / 2), Math.floor((3 * N) / 4)];
    for (let s = 0; s < 4; s++) {
      const a = cuts[s],
        b = s === 3 ? N : cuts[s + 1];
      const pts: Pt[] = [];
      for (let i = a; i <= b; i++) pts.push(at(i));
      runs.push({ pts, t1: tangentAt(a), t2: mulS(tangentAt(b), -1) });
    }
  } else {
    const cp = new Map(corners.map((i) => [i, cornerPoint(i)]));
    for (let s = 0; s < corners.length; s++) {
      const a = corners[s];
      const b = s + 1 < corners.length ? corners[s + 1] : corners[0] + N;
      const pts: Pt[] = [cp.get(a)!];
      for (let i = a + 1; i < b; i++) pts.push(at(i));
      pts.push(cp.get(b % N)!);
      const span = Math.min(k + 1, pts.length - 1);
      runs.push({ pts, t1: norm(sub(pts[span], pts[0])), t2: norm(sub(pts[pts.length - 1 - span], pts[pts.length - 1])) });
    }
  }

  const segs: Seg[] = [];
  for (const run of runs) {
    const pts = smoothRun(run.pts, opts.smooth);
    if (!segs.length) segs.push({ c: "M", p: [...pts[0]] });
    // Straight within half a pixel, or within a small fraction of a long edge (compression noise).
    const chord = len(sub(pts[pts.length - 1], pts[0]));
    if (pts.length < 3 || chordDeviation(pts) <= Math.max(0.6, chord * opts.straightness)) {
      segs.push({ c: "L", p: [...pts[pts.length - 1]] });
      continue;
    }
    const bez: Bez[] = [];
    fitCubic(pts, run.t1, run.t2, opts.errorSq, bez);
    for (const b of bez) {
      // Nearly straight pieces become lines.
      if (chordDeviation([b[0], b[1], b[2], b[3]]) < 0.25) segs.push({ c: "L", p: [...b[3]] });
      else segs.push({ c: "C", p: [...b[1], ...b[2], ...b[3]] });
    }
  }
  segs.push({ c: "Z", p: [] });
  return segs;
}
