// Colour helpers for the vectoriser (sRGB <-> CIE Lab, ΔE76).

function srgbToLinear(c: number) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const LIN = Float64Array.from({ length: 256 }, (_, i) => srgbToLinear(i));

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = LIN[r | 0],
    G = LIN[g | 0],
    B = LIN[b | 0];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export const hex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

export const hexToRgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Lab of every pixel of an RGBA buffer (alpha ignored: callers pass opaque pixels). */
export function labImage(pixels: Uint8Array | Uint8ClampedArray, n: number): Float32Array {
  const lab = new Float32Array(n * 3);
  // Many pixels share a colour: cache by packed RGB.
  const cache = new Map<number, [number, number, number]>();
  for (let i = 0; i < n; i++) {
    const r = pixels[i * 4],
      g = pixels[i * 4 + 1],
      b = pixels[i * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let v = cache.get(key);
    if (!v) {
      v = rgbToLab(r, g, b);
      if (cache.size < 200000) cache.set(key, v);
    }
    lab[i * 3] = v[0];
    lab[i * 3 + 1] = v[1];
    lab[i * 3 + 2] = v[2];
  }
  return lab;
}

export function deltaE(a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number): number {
  const x = a[i] - b[j],
    y = a[i + 1] - b[j + 1],
    z = a[i + 2] - b[j + 2];
  return Math.sqrt(x * x + y * y + z * z);
}

/**
 * 3×3 median per channel: removes compression specks and ringing while keeping edges. Pixels the
 * median would change a lot (more than `keep` on some channel) are high-contrast detail — thin
 * strokes, small text — and keep their value. Returns a new opaque RGBA buffer.
 */
export function median3(pixels: Uint8Array | Uint8ClampedArray, W: number, H: number, keep = 56): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  const v = new Uint8Array(9);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(H - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(W - 1, Math.max(0, x + dx));
            v[k++] = pixels[(yy * W + xx) * 4 + c];
          }
        }
        v.sort();
        out[o + c] = v[4];
      }
      if (Math.abs(out[o] - pixels[o]) > keep || Math.abs(out[o + 1] - pixels[o + 1]) > keep || Math.abs(out[o + 2] - pixels[o + 2]) > keep) {
        out[o] = pixels[o];
        out[o + 1] = pixels[o + 1];
        out[o + 2] = pixels[o + 2];
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
