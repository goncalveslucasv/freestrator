// Colour quantisation that is aware of anti-aliasing: the palette comes mostly from flat areas, and
// the in-between colours along edges snap to one of the colours on either side instead of becoming
// thin halo shapes of their own.

import { deltaE, hex, rgbToLab } from "./color";

export interface PaletteColor {
  hex: string;
  lab: [number, number, number];
  /** Pixels assigned to it. */
  count: number;
}

/** 1 where the colour changes sharply towards a 4-neighbour (anti-aliased edges, thin lines). */
export function edgeMap(lab: Float32Array, W: number, H: number, threshold: number): Uint8Array {
  const edges = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x + 1 < W && deltaE(lab, i * 3, lab, (i + 1) * 3) > threshold) edges[i] = edges[i + 1] = 1;
      if (y + 1 < H && deltaE(lab, i * 3, lab, (i + W) * 3) > threshold) edges[i] = edges[i + W] = 1;
    }
  }
  return edges;
}

/**
 * Picks up to `maxColors` representative colours. Pixels are binned (5 bits per channel); flat
 * pixels weigh more than edge pixels, so anti-aliasing ramps — spread thinly over many bins — rarely
 * become palette entries, while thin lines and text — concentrated in a few bins — still do.
 */
export function extractPalette(
  pixels: Uint8Array | Uint8ClampedArray,
  edges: Uint8Array,
  n: number,
  opts: { maxColors: number; mergeDeltaE: number; minShare: number },
): PaletteColor[] {
  const BINS = 32 * 32 * 32;
  const w = new Float64Array(BINS);
  const edgeCount = new Float64Array(BINS);
  const pixCount = new Float64Array(BINS);
  const sum = new Float64Array(BINS * 3);
  for (let i = 0; i < n; i++) {
    const r = pixels[i * 4],
      g = pixels[i * 4 + 1],
      b = pixels[i * 4 + 2];
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const weight = edges[i] ? 0.3 : 1;
    w[k] += weight;
    pixCount[k]++;
    if (edges[i]) edgeCount[k]++;
    sum[k * 3] += r * weight;
    sum[k * 3 + 1] += g * weight;
    sum[k * 3 + 2] += b * weight;
  }
  const bins: { k: number; w: number; mass: number; lab: [number, number, number]; rgb: [number, number, number] }[] = [];
  let total = 0;
  for (let k = 0; k < BINS; k++) {
    if (!w[k]) continue;
    total += w[k];
    // A colour (plus JPEG noise) straddles neighbouring bins: rank bins by the weight around them.
    const r = k >> 10,
      g = (k >> 5) & 31,
      b = k & 31;
    let mass = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dg = -1; dg <= 1; dg++) {
        for (let db = -1; db <= 1; db++) {
          const rr = r + dr,
            gg = g + dg,
            bb = b + db;
          if (rr >= 0 && gg >= 0 && bb >= 0 && rr < 32 && gg < 32 && bb < 32) mass += w[(rr << 10) | (gg << 5) | bb];
        }
      }
    }
    const rgb: [number, number, number] = [sum[k * 3] / w[k], sum[k * 3 + 1] / w[k], sum[k * 3 + 2] / w[k]];
    bins.push({ k, w: w[k], mass, rgb, lab: rgbToLab(rgb[0], rgb[1], rgb[2]) });
  }
  // Deterministic order: local mass, then bin index.
  const byMass = [...bins].sort((a, b) => b.mass - a.mass || a.k - b.k);

  // Greedy seeds: frequent colours that differ enough from the ones already chosen.
  const seeds: { lab: [number, number, number] }[] = [];
  for (const bin of byMass) {
    if (seeds.length >= opts.maxColors || bin.mass < opts.minShare * total) break;
    if (seeds.every((s) => deltaE(s.lab, 0, bin.lab, 0) > opts.mergeDeltaE)) seeds.push({ lab: bin.lab });
  }
  if (!seeds.length) seeds.push({ lab: bins[0].lab });

  // A few weighted k-means rounds over the bins refine the seeds.
  let centres = seeds.map((s) => ({ lab: s.lab, rgb: [0, 0, 0] as number[], w: 0 }));
  for (let iter = 0; iter < 6; iter++) {
    const acc = centres.map(() => ({ r: 0, g: 0, b: 0, w: 0 }));
    for (const bin of bins) {
      let best = 0,
        bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = deltaE(centres[c].lab, 0, bin.lab, 0);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      // Far-off colours (edge mixes) shouldn't drag a centre around.
      const weight = bd > opts.mergeDeltaE * 2 ? bin.w * 0.1 : bin.w;
      acc[best].r += bin.rgb[0] * weight;
      acc[best].g += bin.rgb[1] * weight;
      acc[best].b += bin.rgb[2] * weight;
      acc[best].w += weight;
    }
    centres = centres.map((c, i) => {
      const a = acc[i];
      if (!a.w) return c;
      const rgb = [a.r / a.w, a.g / a.w, a.b / a.w];
      return { lab: rgbToLab(rgb[0], rgb[1], rgb[2]), rgb, w: a.w };
    });
  }
  // Refinement can pull two centres together: merge them.
  let merged: typeof centres = [];
  for (const c of [...centres].sort((a, b) => b.w - a.w)) {
    if (!c.w) continue;
    if (merged.every((m) => deltaE(m.lab, 0, c.lab, 0) > opts.mergeDeltaE * 0.85)) merged.push(c);
  }

  // Colours found mostly on edges that are artefacts: anti-aliasing blends and compression ringing.
  const edgeShare = merged.map(() => ({ edge: 0, all: 0 }));
  for (const bin of bins) {
    let best = 0,
      bd = Infinity;
    for (let c = 0; c < merged.length; c++) {
      const d = deltaE(merged[c].lab, 0, bin.lab, 0);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    edgeShare[best].edge += edgeCount[bin.k];
    edgeShare[best].all += pixCount[bin.k];
  }
  const isMix = (c: (typeof merged)[number], others: typeof merged) => {
    for (let a = 0; a < others.length; a++) {
      for (let b = a + 1; b < others.length; b++) {
        const A = others[a].lab,
          B = others[b].lab,
          C = c.lab;
        const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
        if (!l2) continue;
        const t = ((C[0] - A[0]) * ab[0] + (C[1] - A[1]) * ab[1] + (C[2] - A[2]) * ab[2]) / l2;
        if (t < 0.12 || t > 0.88) continue;
        const d = Math.hypot(A[0] + t * ab[0] - C[0], A[1] + t * ab[1] - C[1], A[2] + t * ab[2] - C[2]);
        if (d < opts.mergeDeltaE * 0.7) return true;
      }
    }
    return false;
  };
  // Compression ringing: an edge-bound variant of a much more common colour.
  const isRinging = (c: (typeof merged)[number], count: number, others: { c: (typeof merged)[number]; count: number }[]) =>
    others.some((o) => o.count > count * 3 && deltaE(o.c.lab, 0, c.lab, 0) < opts.mergeDeltaE * 2);
  const keep = merged.map((c, i) => ({ c, count: edgeShare[i].all, edgy: edgeShare[i].all > 0 && edgeShare[i].edge / edgeShare[i].all > 0.6 }));
  // Least frequent first, so each colour is judged against the colours that remain.
  for (let i = keep.length - 1; i >= 0; i--) {
    if (!keep[i].edgy) continue;
    const others = keep.filter((_, j) => j !== i);
    if ((others.length >= 2 && isMix(keep[i].c, others.map((k) => k.c))) || isRinging(keep[i].c, keep[i].count, others)) keep.splice(i, 1);
  }
  merged = keep.map((k) => k.c);
  return merged.map((c) => ({ hex: hex(c.rgb[0], c.rgb[1], c.rgb[2]), lab: c.lab, count: 0 }));
}

export function paletteFromHex(colors: string[]): PaletteColor[] {
  return colors.map((h) => {
    const r = parseInt(h.slice(1, 3), 16),
      g = parseInt(h.slice(3, 5), 16),
      b = parseInt(h.slice(5, 7), 16);
    return { hex: h, lab: rgbToLab(r, g, b), count: 0 };
  });
}

/**
 * Assigns every pixel a palette index. A pixel close to some palette colour takes it; an in-between
 * colour that is a blend of two colours found in flat areas around it (anti-aliasing) takes the
 * closer of the two. Anything else keeps its nearest palette colour (thin lines, tiny text).
 */
export function labelPixels(lab: Float32Array, edges: Uint8Array, W: number, H: number, palette: PaletteColor[], closeDeltaE: number): Uint8Array {
  const n = W * H;
  const k = palette.length;
  const pal = new Float32Array(k * 3);
  palette.forEach((p, i) => pal.set(p.lab, i * 3));
  const labels = new Uint8Array(n);
  const nearestD = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let best = 0,
      bd = Infinity;
    for (let c = 0; c < k; c++) {
      const d = deltaE(lab, i * 3, pal, c * 3);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    labels[i] = best;
    nearestD[i] = bd;
  }
  const out = labels.slice();
  const cands = new Int32Array(25);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!edges[i] || nearestD[i] < closeDeltaE) continue;
      // Colours of the confident pixels around.
      let nc = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (edges[j] && nearestD[j] >= closeDeltaE) continue;
          const c = labels[j];
          let seen = false;
          for (let q = 0; q < nc; q++) if (cands[q] === c) seen = true;
          if (!seen) cands[nc++] = c;
        }
      }
      if (nc < 2) continue;
      // Snap only if the pixel is a blend of two of those colours; it goes to the closer one.
      let best = -1,
        bd = closeDeltaE * 1.5;
      for (let a = 0; a < nc; a++) {
        for (let b = a + 1; b < nc; b++) {
          const A = cands[a] * 3,
            B = cands[b] * 3;
          const ab0 = pal[B] - pal[A],
            ab1 = pal[B + 1] - pal[A + 1],
            ab2 = pal[B + 2] - pal[A + 2];
          const l2 = ab0 * ab0 + ab1 * ab1 + ab2 * ab2;
          if (!l2) continue;
          const t = ((lab[i * 3] - pal[A]) * ab0 + (lab[i * 3 + 1] - pal[A + 1]) * ab1 + (lab[i * 3 + 2] - pal[A + 2]) * ab2) / l2;
          if (t < 0 || t > 1) continue;
          const d = Math.hypot(pal[A] + t * ab0 - lab[i * 3], pal[A + 1] + t * ab1 - lab[i * 3 + 1], pal[A + 2] + t * ab2 - lab[i * 3 + 2]);
          if (d < bd) {
            bd = d;
            best = t < 0.5 ? cands[a] : cands[b];
          }
        }
      }
      if (best >= 0) out[i] = best;
    }
  }
  for (let i = 0; i < n; i++) palette[out[i]].count++;
  return out;
}

/**
 * Merges connected regions smaller than `minArea` pixels into the neighbouring colour they share
 * the longest border with. Repeats until stable (speckles inside speckles). Small regions that
 * contrast strongly with that neighbour (text strokes, eyes, dots) only go when really tiny, and
 * low-contrast slivers thinner than `hairline` pixels on average go at any length.
 */
export function mergeSmallRegions(labels: Uint8Array, W: number, H: number, minArea: number, palette: PaletteColor[], hairline = 1.25) {
  const CONTRAST = 30;
  const n = W * H;
  const comp = new Int32Array(n);
  const queue = new Int32Array(n);
  const borderCount = new Int32Array(256);
  for (let pass = 0; pass < 4; pass++) {
    comp.fill(-1);
    let changed = false;
    for (let s = 0; s < n; s++) {
      if (comp[s] >= 0) continue;
      const label = labels[s];
      // Breadth-first fill (4-connected); queue[0..size) ends up holding the region.
      let head = 0,
        size = 0;
      queue[size++] = s;
      comp[s] = s;
      borderCount.fill(0);
      while (head < size) {
        const p = queue[head++];
        const x = p % W;
        for (let k = 0; k < 4; k++) {
          let q: number;
          if (k === 0) {
            if (x === 0) continue;
            q = p - 1;
          } else if (k === 1) {
            if (x + 1 === W) continue;
            q = p + 1;
          } else if (k === 2) {
            if (p < W) continue;
            q = p - W;
          } else {
            if (p + W >= n) continue;
            q = p + W;
          }
          if (labels[q] !== label) borderCount[labels[q]]++;
          else if (comp[q] < 0) {
            comp[q] = s;
            queue[size++] = q;
          }
        }
      }
      let best = -1,
        bc = 0,
        perimeter = 0;
      for (let l = 0; l < 256; l++) {
        perimeter += borderCount[l];
        if (borderCount[l] > bc) {
          bc = borderCount[l];
          best = l;
        }
      }
      if (best < 0) continue;
      const contrasted = deltaE(palette[label].lab, 0, palette[best].lab, 0) > CONTRAST;
      // Hairline rings along edges (JPEG ringing, leftover anti-aliasing) go whatever their length.
      const thin = !contrasted && (2 * size) / perimeter < hairline;
      if (!thin && (size >= minArea || (size >= minArea / 4 && contrasted))) continue;
      for (let q = 0; q < size; q++) labels[queue[q]] = best;
      changed = true;
    }
    if (!changed) break;
  }
}
