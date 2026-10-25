// Scene graph of a document. All geometry is expressed in "document space":
// points (1/72 in), y axis pointing down, artboards laid out side by side.

import type { Mat } from "./matrix";

export type SegCmd = "M" | "L" | "C" | "Q" | "Z";
/** One path command. `p` holds the points: M/L [x,y], C [x1,y1,x2,y2,x,y], Q [x1,y1,x,y], Z []. */
export interface Seg {
  c: SegCmd;
  p: number[];
}

export interface GradientStop {
  offset: number;
  color: string;
  opacity?: number;
}

export interface SolidPaint {
  kind: "solid";
  color: string;
}

export interface LinearPaint {
  kind: "linear";
  stops: GradientStop[];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Gradient space -> node local space. */
  gt?: Mat;
}

export interface RadialPaint {
  kind: "radial";
  stops: GradientStop[];
  /** Start (focal) circle. */
  fx: number;
  fy: number;
  fr: number;
  /** End circle. */
  cx: number;
  cy: number;
  r: number;
  gt?: Mat;
}

export type Paint = SolidPaint | LinearPaint | RadialPaint;

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

interface NodeBase {
  id: string;
  name?: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
}

export interface PathNode extends NodeBase {
  type: "path";
  segs: Seg[];
  /** Local -> document space. */
  m: Mat;
  fill: Paint | null;
  fillOpacity: number;
  fillRule: "nonzero" | "evenodd";
  stroke: Paint | null;
  strokeOpacity: number;
  strokeWidth: number;
  lineCap: "butt" | "round" | "square";
  lineJoin: "miter" | "round" | "bevel";
  miterLimit: number;
  dash: number[];
  dashOffset: number;
}

export interface ImageNode extends NodeBase {
  type: "image";
  /** Asset id in the asset registry. */
  asset: string;
  /** Maps the unit square (0,0 = top-left of the image) to document space. */
  m: Mat;
}

export interface TextNode extends NodeBase {
  type: "text";
  /** Text space (y down, baseline at y=0) -> document space. */
  m: Mat;
  text: string;
  fontSize: number;
  /** Font id in the asset registry (embedded font), if any. */
  font?: string;
  /** CSS font family used when the embedded font can't be used. */
  family: string;
  weight: number;
  italic: boolean;
  letterSpacing: number;
  /** Original glyph run, exactly as in the source file. Dropped once the text is edited. */
  glyphs?: { chars: string; xs: number[] };
  fill: Paint | null;
  fillOpacity: number;
  stroke: Paint | null;
  strokeOpacity: number;
  strokeWidth: number;
  align?: "start" | "middle" | "end";
}

export interface ClipShape {
  segs: Seg[];
  m: Mat;
  rule: "nonzero" | "evenodd";
}

export interface GroupNode extends NodeBase {
  type: "group";
  /** "layer" = top level layer, "artboard" = per-artboard sub-layer, otherwise a normal group. */
  role?: "layer" | "artboard";
  /** Artboard index for role=artboard. */
  artboard?: number;
  children: SceneNode[];
  clip?: ClipShape;
  /** Luminosity/alpha soft mask applied to the children. */
  mask?: { type: "luminance" | "alpha"; nodes: SceneNode[]; backdrop?: string };
  color?: string;
  expanded?: boolean;
}

export type SceneNode = PathNode | ImageNode | TextNode | GroupNode;

export interface Artboard {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Doc {
  name: string;
  artboards: Artboard[];
  layers: GroupNode[];
}
