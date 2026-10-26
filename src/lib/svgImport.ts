// Converts SVG markup into scene nodes. Works on any DOM-like tree (the browser's DOMParser or
// @xmldom/xmldom in Node), so the editor and the MCP server share it.
//
// Supported: path, rect, circle, ellipse, line, polyline, polygon, g, nested svg, use, text/tspan,
// linear/radial gradients, clip-path, presentation attributes, style="" and simple <style> rules
// (.class, #id and tag selectors). Coordinates are kept as written; `m` carries the transforms.

import { ellipseSegs, newId, segsBBox } from "./geometry";
import { apply, IDENTITY, mul, rotate, scale, translate, type Mat } from "./matrix";
import type { BlendMode, ClipShape, GradientStop, GroupNode, Paint, PathNode, SceneNode, Seg, TextNode } from "./types";

/** The subset of the DOM API the importer needs. */
export interface XmlNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<XmlNode>;
  getAttribute?(name: string): string | null;
}

export interface SvgImportOptions {
  /** Viewport used to resolve percentages (defaults to the root viewBox or 1000×1000). */
  viewport?: { width: number; height: number };
}

export interface SvgImportResult {
  nodes: SceneNode[];
  warnings: string[];
  /** Root viewBox, if the markup had an <svg> element with one. */
  viewBox?: { x: number; y: number; width: number; height: number };
}

const ELEMENT = 1;
const TEXT = 3;

// ---------- path data ----------

const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** Parses SVG path data into absolute M/L/C/Q/Z segments. */
export function parsePathData(d: string): Seg[] {
  const segs: Seg[] = [];
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i])) i++;
  };
  const num = (): number => {
    skip();
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(d);
    if (!m) throw new Error(`Número inválido en el trazado cerca de «${d.slice(i, i + 12)}»`);
    i = NUM_RE.lastIndex;
    return parseFloat(m[0]);
  };
  const flag = (): number => {
    skip();
    const c = d[i++];
    if (c !== "0" && c !== "1") throw new Error("Bandera de arco inválida en el trazado");
    return c === "1" ? 1 : 0;
  };

  let cx = 0,
    cy = 0,
    sx = 0,
    sy = 0;
  // Last control point, for S/T reflection.
  let lc: [number, number] | null = null;
  let lq: [number, number] | null = null;
  let cmd = "";
  while (true) {
    skip();
    if (i >= d.length) break;
    if (/[a-zA-Z]/.test(d[i])) cmd = d[i++];
    else if (!cmd) throw new Error("El trazado debe empezar con M");
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    let nextLc: [number, number] | null = null;
    let nextLq: [number, number] | null = null;
    switch (C) {
      case "M": {
        cx = ox + num();
        cy = oy + num();
        sx = cx;
        sy = cy;
        segs.push({ c: "M", p: [cx, cy] });
        // Extra pairs are implicit line-tos.
        cmd = rel ? "l" : "L";
        break;
      }
      case "L":
        cx = ox + num();
        cy = oy + num();
        segs.push({ c: "L", p: [cx, cy] });
        break;
      case "H":
        cx = ox + num();
        segs.push({ c: "L", p: [cx, cy] });
        break;
      case "V":
        cy = oy + num();
        segs.push({ c: "L", p: [cx, cy] });
        break;
      case "C": {
        const p: number[] = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()];
        segs.push({ c: "C", p });
        nextLc = [p[2], p[3]];
        [cx, cy] = [p[4], p[5]];
        break;
      }
      case "S": {
        const [x1, y1]: [number, number] = lc ? [2 * cx - lc[0], 2 * cy - lc[1]] : [cx, cy];
        const p: number[] = [x1, y1, ox + num(), oy + num(), ox + num(), oy + num()];
        segs.push({ c: "C", p });
        nextLc = [p[2], p[3]];
        [cx, cy] = [p[4], p[5]];
        break;
      }
      case "Q": {
        const p: number[] = [ox + num(), oy + num(), ox + num(), oy + num()];
        segs.push({ c: "Q", p });
        nextLq = [p[0], p[1]];
        [cx, cy] = [p[2], p[3]];
        break;
      }
      case "T": {
        const x1: number = lq ? 2 * cx - lq[0] : cx;
        const y1: number = lq ? 2 * cy - lq[1] : cy;
        const p: number[] = [x1, y1, ox + num(), oy + num()];
        segs.push({ c: "Q", p });
        nextLq = [x1, y1];
        [cx, cy] = [p[2], p[3]];
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = flag();
        const sweep = flag();
        const x = ox + num();
        const y = oy + num();
        for (const p of arcToCubics(cx, cy, rx, ry, rot, large, sweep, x, y)) segs.push({ c: "C", p });
        [cx, cy] = [x, y];
        break;
      }
      case "Z":
        segs.push({ c: "Z", p: [] });
        [cx, cy] = [sx, sy];
        break;
      default:
        throw new Error(`Comando de trazado desconocido: ${cmd}`);
    }
    lc = nextLc;
    lq = nextLq;
    // Other commands repeat while numbers follow; Z takes none.
    if (C === "Z") cmd = "";
  }
  return segs;
}

/** Converts an SVG elliptical arc into cubic bezier segments ([x1,y1,x2,y2,x,y] each). */
function arcToCubics(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: number, sweep: number, x2: number, y2: number): number[][] {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t: number): [number, number] => {
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    return [cx + cos * ex - sin * ey, cy + sin * ex + cos * ey];
  };
  const deriv = (t: number): [number, number] => {
    const ex = -rx * Math.sin(t);
    const ey = ry * Math.cos(t);
    return [cos * ex - sin * ey, sin * ex + cos * ey];
  };
  const out: number[][] = [];
  for (let s = 0; s < n; s++) {
    const a = t1 + s * step;
    const b = a + step;
    const [ax, ay] = point(a);
    const [bx, by] = s === n - 1 ? [x2, y2] : point(b);
    const [dax, day] = deriv(a);
    const [dbx, dby] = deriv(b);
    out.push([ax + k * dax, ay + k * day, bx - k * dbx, by - k * dby, bx, by]);
  }
  return out;
}

/** Applies `m` to every point of a path (bakes the transform into the coordinates). */
export function transformSegs(segs: Seg[], m: Mat): Seg[] {
  return segs.map((s) => {
    const p: number[] = [];
    for (let k = 0; k < s.p.length; k += 2) p.push(...apply(m, s.p[k], s.p[k + 1]));
    return { c: s.c, p };
  });
}

// ---------- transforms ----------

export function parseTransform(s: string | null | undefined): Mat {
  let m: Mat = [...IDENTITY];
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(s))) {
    const a = (match[2].match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
    let t: Mat;
    switch (match[1]) {
      case "matrix":
        t = [a[0] ?? 1, a[1] ?? 0, a[2] ?? 0, a[3] ?? 1, a[4] ?? 0, a[5] ?? 0];
        break;
      case "translate":
        t = translate(a[0] ?? 0, a[1] ?? 0);
        break;
      case "scale":
        t = scale(a[0] ?? 1, a[1] ?? a[0] ?? 1);
        break;
      case "rotate": {
        const r = rotate(((a[0] ?? 0) * Math.PI) / 180);
        t = a.length >= 3 ? mul(translate(a[1], a[2]), mul(r, translate(-a[1], -a[2]))) : r;
        break;
      }
      case "skewX":
        t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      default:
        t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
    m = mul(m, t);
  }
  return m;
}

// ---------- colours ----------

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  cyan: "#00ffff", aqua: "#00ffff", magenta: "#ff00ff", fuchsia: "#ff00ff", gray: "#808080", grey: "#808080",
  silver: "#c0c0c0", maroon: "#800000", olive: "#808000", lime: "#00ff00", teal: "#008080", navy: "#000080",
  purple: "#800080", orange: "#ffa500", pink: "#ffc0cb", brown: "#a52a2a", gold: "#ffd700", beige: "#f5f5dc",
  ivory: "#fffff0", khaki: "#f0e68c", coral: "#ff7f50", salmon: "#fa8072", tomato: "#ff6347", crimson: "#dc143c",
  indigo: "#4b0082", violet: "#ee82ee", orchid: "#da70d6", plum: "#dda0dd", lavender: "#e6e6fa", tan: "#d2b48c",
  chocolate: "#d2691e", sienna: "#a0522d", peru: "#cd853f", wheat: "#f5deb3", turquoise: "#40e0d0",
  skyblue: "#87ceeb", steelblue: "#4682b4", royalblue: "#4169e1", darkblue: "#00008b", lightblue: "#add8e6",
  darkgreen: "#006400", lightgreen: "#90ee90", forestgreen: "#228b22", seagreen: "#2e8b57", darkred: "#8b0000",
  darkgray: "#a9a9a9", darkgrey: "#a9a9a9", lightgray: "#d3d3d3", lightgrey: "#d3d3d3", dimgray: "#696969",
  dimgrey: "#696969", darkslategray: "#2f4f4f", slategray: "#708090", whitesmoke: "#f5f5f5", gainsboro: "#dcdcdc",
  snow: "#fffafa", linen: "#faf0e6", mintcream: "#f5fffa", firebrick: "#b22222", goldenrod: "#daa520",
  darkorange: "#ff8c00", hotpink: "#ff69b4", deeppink: "#ff1493", midnightblue: "#191970", olivedrab: "#6b8e23",
};

const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");

/** Parses a CSS colour into "#rrggbb" plus alpha. Returns null for none/transparent/unknown. */
export function parseColor(raw: string, current = "#000000"): { color: string; alpha: number } | null {
  const s = raw.trim().toLowerCase();
  if (!s || s === "none" || s === "transparent") return null;
  if (s === "currentcolor") return parseColor(current);
  if (NAMED[s]) return { color: NAMED[s], alpha: 1 };
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return { color: `#${h.slice(0, 6)}`, alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[2].split(/[\s,/]+/).filter(Boolean);
    const val = (p: string, max: number) => (p.endsWith("%") ? (parseFloat(p) / 100) * max : parseFloat(p));
    const alpha = parts[3] !== undefined ? val(parts[3], 1) : 1;
    if (m[1].startsWith("rgb")) {
      return { color: `#${hex2(val(parts[0], 255))}${hex2(val(parts[1], 255))}${hex2(val(parts[2], 255))}`, alpha };
    }
    const h = (((parseFloat(parts[0]) % 360) + 360) % 360) / 360;
    const sat = val(parts[1], 1);
    const l = val(parts[2], 1);
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
    const p = 2 * l - q;
    const hue = (t: number) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return { color: `#${hex2(hue(h + 1 / 3) * 255)}${hex2(hue(h) * 255)}${hex2(hue(h - 1 / 3) * 255)}`, alpha };
  }
  return null;
}

// ---------- styles ----------

/** Inherited presentation properties. */
interface Style {
  fill: string;
  fillOpacity: number;
  fillRule: "nonzero" | "evenodd";
  stroke: string;
  strokeOpacity: number;
  strokeWidth: number;
  lineCap: PathNode["lineCap"];
  lineJoin: PathNode["lineJoin"];
  miterLimit: number;
  dash: number[];
  dashOffset: number;
  color: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  letterSpacing: number;
  textAnchor: "start" | "middle" | "end";
  visible: boolean;
}

const ROOT_STYLE: Style = {
  fill: "#000000",
  fillOpacity: 1,
  fillRule: "nonzero",
  stroke: "none",
  strokeOpacity: 1,
  strokeWidth: 1,
  lineCap: "butt",
  lineJoin: "miter",
  miterLimit: 4,
  dash: [],
  dashOffset: 0,
  color: "#000000",
  fontFamily: "Helvetica",
  fontSize: 16,
  fontWeight: 400,
  italic: false,
  letterSpacing: 0,
  textAnchor: "start",
  visible: true,
};

const PROPS = [
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-opacity", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "color", "font-family", "font-size", "font-weight",
  "font-style", "letter-spacing", "text-anchor", "visibility", "display", "opacity", "mix-blend-mode", "clip-path",
  "stop-color", "stop-opacity",
];

interface CssRule {
  selectors: string[];
  decls: Record<string, string>;
}

function parseDecls(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(";")) {
    const k = part.indexOf(":");
    if (k < 0) continue;
    out[part.slice(0, k).trim().toLowerCase()] = part.slice(k + 1).trim().replace(/\s*!important$/, "");
  }
  return out;
}

function parseCss(text: string): CssRule[] {
  const rules: CssRule[] = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!\[CDATA\[|\]\]>/g, "");
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    if (m[1].trim().startsWith("@")) continue;
    rules.push({ selectors: m[1].split(",").map((s) => s.trim()).filter(Boolean), decls: parseDecls(m[2]) });
  }
  return rules;
}

const lengthOf = (v: string | null | undefined, ref = 0, fallback = 0): number => {
  if (v == null || v === "") return fallback;
  const s = v.trim();
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return fallback;
  if (s.endsWith("%")) return (n / 100) * ref;
  if (s.endsWith("px") || s.endsWith("pt")) return n;
  if (s.endsWith("em")) return n * 16;
  return n;
};

// ---------- importer ----------

const base = (n: XmlNode) => n.nodeName.replace(/^svg:/, "");
const children = (n: XmlNode) => Array.from(n.childNodes ?? []).filter((c) => c.nodeType === ELEMENT);
const attr = (n: XmlNode, name: string) => n.getAttribute?.(name) ?? null;

const BLENDS = new Set<BlendMode>([
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light",
  "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
]);

/** Converts a parsed SVG tree (root <svg> or any element) into scene nodes. */
export function svgToNodes(root: XmlNode, opts: SvgImportOptions = {}): SvgImportResult {
  const warnings = new Set<string>();
  const byId = new Map<string, XmlNode>();
  const rules: CssRule[] = [];
  const visitAll = (n: XmlNode) => {
    if (n.nodeType !== ELEMENT) return;
    const id = attr(n, "id");
    if (id) byId.set(id, n);
    if (base(n) === "style") rules.push(...parseCss(n.textContent ?? ""));
    for (const c of children(n)) visitAll(c);
  };
  visitAll(root);

  let viewBox: SvgImportResult["viewBox"];
  const rootEl = base(root) === "svg" ? root : null;
  if (rootEl) {
    const vb = attr(rootEl, "viewBox")?.trim().split(/[\s,]+/).map(Number);
    if (vb?.length === 4 && vb.every(Number.isFinite)) viewBox = { x: vb[0], y: vb[1], width: vb[2], height: vb[3] };
  }
  const viewport = opts.viewport ?? (viewBox ? { width: viewBox.width, height: viewBox.height } : { width: 1000, height: 1000 });

  /** Specified declarations for an element: attributes < css rules < style="". */
  const declsOf = (n: XmlNode): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of PROPS) {
      const v = attr(n, p);
      if (v != null) out[p] = v;
    }
    const cls = (attr(n, "class") ?? "").split(/\s+/).filter(Boolean);
    const id = attr(n, "id");
    const tag = base(n);
    for (const r of rules) {
      const hit = r.selectors.some((s) => (s.startsWith(".") ? cls.includes(s.slice(1)) : s.startsWith("#") ? s.slice(1) === id : s === tag || s === "*"));
      if (hit) Object.assign(out, r.decls);
    }
    const style = attr(n, "style");
    if (style) Object.assign(out, parseDecls(style));
    return out;
  };

  const inherit = (parent: Style, d: Record<string, string>): Style => {
    const s = { ...parent };
    const num = (k: string, f: number) => (d[k] !== undefined && d[k] !== "inherit" ? lengthOf(d[k], 0, f) : f);
    if (d.color && d.color !== "inherit") s.color = d.color;
    if (d.fill && d.fill !== "inherit") s.fill = d.fill;
    if (d.stroke && d.stroke !== "inherit") s.stroke = d.stroke;
    s.fillOpacity = num("fill-opacity", s.fillOpacity);
    s.strokeOpacity = num("stroke-opacity", s.strokeOpacity);
    s.strokeWidth = num("stroke-width", s.strokeWidth);
    s.miterLimit = num("stroke-miterlimit", s.miterLimit);
    s.dashOffset = num("stroke-dashoffset", s.dashOffset);
    s.letterSpacing = d["letter-spacing"] === "normal" ? 0 : num("letter-spacing", s.letterSpacing);
    if (d["fill-rule"] === "evenodd" || d["fill-rule"] === "nonzero") s.fillRule = d["fill-rule"];
    if (d["stroke-linecap"] && ["butt", "round", "square"].includes(d["stroke-linecap"])) s.lineCap = d["stroke-linecap"] as Style["lineCap"];
    if (d["stroke-linejoin"] && ["miter", "round", "bevel"].includes(d["stroke-linejoin"])) s.lineJoin = d["stroke-linejoin"] as Style["lineJoin"];
    if (d["stroke-dasharray"]) s.dash = d["stroke-dasharray"] === "none" ? [] : d["stroke-dasharray"].split(/[\s,]+/).map(Number).filter(Number.isFinite);
    if (d["font-family"]) s.fontFamily = d["font-family"].split(",")[0].trim().replace(/^['"]|['"]$/g, "");
    if (d["font-size"]) s.fontSize = lengthOf(d["font-size"], parent.fontSize, s.fontSize);
    if (d["font-weight"]) {
      const w = d["font-weight"];
      s.fontWeight = w === "bold" ? 700 : w === "normal" ? 400 : w === "lighter" ? 300 : w === "bolder" ? 800 : Number(w) || s.fontWeight;
    }
    if (d["font-style"]) s.italic = /italic|oblique/.test(d["font-style"]);
    if (d["text-anchor"] && ["start", "middle", "end"].includes(d["text-anchor"])) s.textAnchor = d["text-anchor"] as Style["textAnchor"];
    if (d.visibility) s.visible = d.visibility !== "hidden" && d.visibility !== "collapse";
    return s;
  };

  const gradientStops = (g: XmlNode, seen = new Set<XmlNode>()): GradientStop[] => {
    const stops = children(g)
      .filter((c) => base(c) === "stop")
      .map((c) => {
        const d = declsOf(c);
        const col = parseColor(d["stop-color"] ?? "#000000") ?? { color: "#000000", alpha: 0 };
        const off = d.offset ?? attr(c, "offset") ?? "0";
        const offset = Math.min(1, Math.max(0, off.trim().endsWith("%") ? parseFloat(off) / 100 : parseFloat(off) || 0));
        const opacity = (d["stop-opacity"] !== undefined ? parseFloat(d["stop-opacity"]) : 1) * col.alpha;
        return { offset, color: col.color, ...(opacity !== 1 ? { opacity } : {}) };
      });
    if (stops.length) return stops;
    const href = (attr(g, "href") ?? attr(g, "xlink:href"))?.replace(/^#/, "");
    const ref = href ? byId.get(href) : undefined;
    if (ref && !seen.has(ref)) {
      seen.add(ref);
      return gradientStops(ref, seen);
    }
    return [];
  };

  /** Gradient attribute, following href chains. */
  const gAttr = (g: XmlNode, name: string, seen = new Set<XmlNode>()): string | null => {
    const v = attr(g, name);
    if (v != null) return v;
    const href = (attr(g, "href") ?? attr(g, "xlink:href"))?.replace(/^#/, "");
    const ref = href ? byId.get(href) : undefined;
    if (ref && !seen.has(ref)) {
      seen.add(ref);
      return gAttr(ref, name, seen);
    }
    return null;
  };

  /** Resolves a fill/stroke value into a Paint (node-local space) plus an opacity multiplier. */
  const resolvePaint = (value: string, style: Style, segs: Seg[] | null): { paint: Paint | null; alpha: number } => {
    const url = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(value);
    if (url) {
      const g = byId.get(url[1]);
      if (!g || (base(g) !== "linearGradient" && base(g) !== "radialGradient")) {
        warnings.add(`Pintura «${value}» no soportada; se usó negro.`);
        return { paint: { kind: "solid", color: "#000000" }, alpha: 1 };
      }
      const stops = gradientStops(g);
      if (!stops.length) return { paint: null, alpha: 1 };
      if (stops.length === 1) return { paint: { kind: "solid", color: stops[0].color }, alpha: stops[0].opacity ?? 1 };
      const bbox = gAttr(g, "gradientUnits") !== "userSpaceOnUse";
      const bb = bbox && segs ? segsBBox(segs, IDENTITY) : null;
      const units: Mat = bb ? [bb.w || 1, 0, 0, bb.h || 1, bb.x, bb.y] : [...IDENTITY];
      const gt = mul(units, parseTransform(gAttr(g, "gradientTransform")));
      const L = (name: string, ref: number, def: string) => {
        const raw = gAttr(g, name) ?? def;
        return raw.trim().endsWith("%") ? (parseFloat(raw) / 100) * (bbox ? 1 : ref) : parseFloat(raw);
      };
      const W = viewport.width;
      const H = viewport.height;
      if (base(g) === "linearGradient") {
        return { paint: { kind: "linear", stops, x1: L("x1", W, "0%"), y1: L("y1", H, "0%"), x2: L("x2", W, "100%"), y2: L("y2", H, "0%"), gt }, alpha: 1 };
      }
      const D = Math.hypot(W, H) / Math.SQRT2;
      const cx = L("cx", W, "50%");
      const cy = L("cy", H, "50%");
      return {
        paint: { kind: "radial", stops, cx, cy, r: L("r", D, "50%"), fx: gAttr(g, "fx") != null ? L("fx", W, "50%") : cx, fy: gAttr(g, "fy") != null ? L("fy", H, "50%") : cy, fr: L("fr", D, "0%"), gt },
        alpha: 1,
      };
    }
    const col = parseColor(value, parseColor(style.color)?.color);
    if (!col) {
      if (value.trim() && !/^(none|transparent)$/i.test(value.trim())) warnings.add(`Color «${value}» no reconocido; se omitió.`);
      return { paint: null, alpha: 1 };
    }
    return { paint: { kind: "solid", color: col.color }, alpha: col.alpha };
  };

  const common = (n: XmlNode, d: Record<string, string>, style: Style) => {
    const blend = (d["mix-blend-mode"] ?? "normal") as BlendMode;
    return {
      id: newId(),
      name: attr(n, "data-name") ?? attr(n, "inkscape:label") ?? attr(n, "id") ?? undefined,
      visible: style.visible && d.display !== "none",
      locked: false,
      opacity: d.opacity !== undefined ? Math.min(1, Math.max(0, parseFloat(d.opacity))) : 1,
      blend: BLENDS.has(blend) ? blend : "normal",
    };
  };

  const shapeSegs = (n: XmlNode): Seg[] | null => {
    const g = (k: string, ref = 0) => lengthOf(attr(n, k), ref);
    switch (base(n)) {
      case "path":
        return parsePathData(attr(n, "d") ?? "");
      case "rect": {
        const x = g("x", viewport.width);
        const y = g("y", viewport.height);
        const w = g("width", viewport.width);
        const h = g("height", viewport.height);
        if (w <= 0 || h <= 0) return null;
        let rx = attr(n, "rx") != null ? g("rx", viewport.width) : NaN;
        let ry = attr(n, "ry") != null ? g("ry", viewport.height) : NaN;
        if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
        if (Number.isNaN(ry)) ry = rx;
        rx = Math.min(rx, w / 2);
        ry = Math.min(ry, h / 2);
        if (!rx || !ry) return parsePathData(`M${x} ${y}H${x + w}V${y + h}H${x}Z`);
        return parsePathData(
          `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
            `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`,
        );
      }
      case "circle": {
        const r = g("r", Math.hypot(viewport.width, viewport.height) / Math.SQRT2);
        return r > 0 ? ellipseSegs(g("cx", viewport.width), g("cy", viewport.height), r, r) : null;
      }
      case "ellipse": {
        const rx = g("rx", viewport.width);
        const ry = g("ry", viewport.height);
        return rx > 0 && ry > 0 ? ellipseSegs(g("cx", viewport.width), g("cy", viewport.height), rx, ry) : null;
      }
      case "line":
        return [
          { c: "M", p: [g("x1", viewport.width), g("y1", viewport.height)] },
          { c: "L", p: [g("x2", viewport.width), g("y2", viewport.height)] },
        ];
      case "polyline":
      case "polygon": {
        const pts = (attr(n, "points") ?? "").trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
        if (pts.length < 4) return null;
        const segs: Seg[] = [{ c: "M", p: [pts[0], pts[1]] }];
        for (let k = 2; k + 1 < pts.length; k += 2) segs.push({ c: "L", p: [pts[k], pts[k + 1]] });
        if (base(n) === "polygon") segs.push({ c: "Z", p: [] });
        return segs;
      }
    }
    return null;
  };

  const clipFor = (value: string | undefined, ctm: Mat): ClipShape | undefined => {
    const url = value && /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(value);
    if (!url) return undefined;
    const el = byId.get(url[1]);
    if (!el || base(el) !== "clipPath") {
      warnings.add(`clip-path «${value}» no encontrado.`);
      return undefined;
    }
    const units = attr(el, "clipPathUnits") === "objectBoundingBox";
    if (units) warnings.add("clipPathUnits=objectBoundingBox no está soportado; el recorte puede verse mal.");
    const elM = mul(ctm, parseTransform(attr(el, "transform")));
    const segs: Seg[] = [];
    let rule: ClipShape["rule"] = "nonzero";
    for (const c of children(el)) {
      const s = shapeSegs(c);
      if (!s) continue;
      const d = declsOf(c);
      if (d["clip-rule"] === "evenodd" || attr(c, "clip-rule") === "evenodd") rule = "evenodd";
      segs.push(...transformSegs(s, mul(elM, parseTransform(attr(c, "transform")))));
    }
    return segs.length ? { segs, m: [...IDENTITY], rule } : undefined;
  };

  const SKIP = new Set(["defs", "style", "title", "desc", "metadata", "clipPath", "mask", "linearGradient", "radialGradient", "pattern", "symbol", "marker", "filter", "script"]);

  const convert = (n: XmlNode, parentStyle: Style, parentM: Mat, depth = 0): SceneNode[] => {
    if (n.nodeType !== ELEMENT || depth > 64) return [];
    const tag = base(n);
    if (SKIP.has(tag)) return [];
    const d = declsOf(n);
    if (d.display === "none") return [];
    const style = inherit(parentStyle, d);
    let m = mul(parentM, parseTransform(attr(n, "transform")));

    const wrapClip = (nodes: SceneNode[]): SceneNode[] => {
      const clip = clipFor(d["clip-path"], m);
      if (!clip || !nodes.length) return nodes;
      // Opacity/blend stay on the group so they apply to the clipped result.
      const g: GroupNode = { ...common(n, d, style), type: "group", children: nodes, clip };
      if (nodes.length === 1) {
        const only = nodes[0];
        g.opacity = only.opacity;
        g.blend = only.blend;
        g.name = only.name;
        only.opacity = 1;
        only.blend = "normal";
      }
      return [g];
    };

    switch (tag) {
      case "svg":
      case "g":
      case "a":
      case "switch": {
        if (tag === "svg" && n !== root) {
          m = mul(m, translate(lengthOf(attr(n, "x")), lengthOf(attr(n, "y"))));
          const vb = attr(n, "viewBox")?.trim().split(/[\s,]+/).map(Number);
          const w = lengthOf(attr(n, "width"), viewport.width, vb?.[2] ?? viewport.width);
          const h = lengthOf(attr(n, "height"), viewport.height, vb?.[3] ?? viewport.height);
          if (vb?.length === 4 && vb[2] && vb[3]) m = mul(m, mul(scale(w / vb[2], h / vb[3]), translate(-vb[0], -vb[1])));
        }
        const kids = children(n).flatMap((c) => convert(c, style, m, depth + 1));
        if (!kids.length) return [];
        const c = common(n, d, style);
        const clip = clipFor(d["clip-path"], m);
        // The root <svg> and anonymous plain groups are flattened.
        const plain = !clip && c.opacity === 1 && c.blend === "normal" && c.visible;
        if (n === root || (plain && !c.name && tag !== "g")) return kids;
        if (plain && !c.name && kids.length === 1) return kids;
        return [{ ...c, type: "group", children: kids, ...(clip ? { clip } : {}) }];
      }
      case "use": {
        const href = (attr(n, "href") ?? attr(n, "xlink:href"))?.replace(/^#/, "");
        const ref = href ? byId.get(href) : undefined;
        if (!ref) return [];
        m = mul(m, translate(lengthOf(attr(n, "x")), lengthOf(attr(n, "y"))));
        const target = base(ref) === "symbol" ? children(ref) : [ref];
        const kids = target.flatMap((c) => convert(c, style, m, depth + 1));
        return wrapClip(kids.length > 1 ? [{ ...common(n, d, style), type: "group", children: kids }] : kids);
      }
      case "text":
        return wrapClip(convertText(n, style, m, d));
      case "image":
        warnings.add("Los elementos <image> se omiten en la importación SVG.");
        return [];
    }

    const segs = shapeSegs(n);
    if (segs === null) {
      if (!["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"].includes(tag)) warnings.add(`Elemento <${tag}> no soportado; se omitió.`);
      return [];
    }
    if (!segs.length) return [];
    const fill = resolvePaint(style.fill, style, segs);
    const stroke = resolvePaint(style.stroke, style, segs);
    const node: PathNode = {
      ...common(n, d, style),
      type: "path",
      segs,
      m,
      fill: tag === "line" ? null : fill.paint,
      fillOpacity: style.fillOpacity * fill.alpha,
      fillRule: style.fillRule,
      stroke: stroke.paint,
      strokeOpacity: style.strokeOpacity * stroke.alpha,
      strokeWidth: style.strokeWidth,
      lineCap: style.lineCap,
      lineJoin: style.lineJoin,
      miterLimit: style.miterLimit,
      dash: style.dash,
      dashOffset: style.dashOffset,
    };
    return wrapClip([node]);
  };

  const convertText = (n: XmlNode, style: Style, m: Mat, d: Record<string, string>): SceneNode[] => {
    const out: TextNode[] = [];
    let x = lengthOf(attr(n, "x")?.split(/[\s,]+/)[0]) + lengthOf(attr(n, "dx"));
    let y = lengthOf(attr(n, "y")?.split(/[\s,]+/)[0]) + lengthOf(attr(n, "dy"));
    const push = (text: string, s: Style, el: XmlNode, dd: Record<string, string>) => {
      if (!text.trim()) return;
      const fill = resolvePaint(s.fill, s, null);
      const stroke = resolvePaint(s.stroke, s, null);
      const last = out.at(-1);
      // Consecutive runs at the same anchor become one node.
      if (last && last.m[4] === apply(m, x, y)[0] && last.m[5] === apply(m, x, y)[1] && last.fontSize === s.fontSize) {
        last.text += text;
        return;
      }
      out.push({
        ...common(el, dd, s),
        type: "text",
        m: mul(m, translate(x, y)),
        text,
        fontSize: s.fontSize,
        family: s.fontFamily,
        weight: s.fontWeight,
        italic: s.italic,
        letterSpacing: s.letterSpacing,
        fill: fill.paint,
        fillOpacity: s.fillOpacity * fill.alpha,
        stroke: stroke.paint,
        strokeOpacity: s.strokeOpacity * stroke.alpha,
        strokeWidth: s.strokeWidth,
        align: s.textAnchor,
      });
    };
    const walkText = (el: XmlNode, s: Style, dd: Record<string, string>) => {
      for (const c of Array.from(el.childNodes ?? [])) {
        if (c.nodeType === TEXT) push((c.textContent ?? "").replace(/\s+/g, " "), s, el, dd);
        else if (c.nodeType === ELEMENT && base(c) === "tspan") {
          const cd = declsOf(c);
          const cs = inherit(s, cd);
          if (attr(c, "x") != null) x = lengthOf(attr(c, "x")!.split(/[\s,]+/)[0]);
          if (attr(c, "y") != null) y = lengthOf(attr(c, "y")!.split(/[\s,]+/)[0]);
          x += lengthOf(attr(c, "dx"));
          y += lengthOf(attr(c, "dy"), cs.fontSize);
          walkText(c, cs, cd);
        }
      }
    };
    walkText(n, style, d);
    for (const t of out) t.text = t.text.trim();
    return out;
  };

  const nodes = convert(root, ROOT_STYLE, [...IDENTITY]);
  return { nodes, warnings: [...warnings], viewBox };
}
