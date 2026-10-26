"use client";

import { createContext, memo, useContext, useLayoutEffect, useRef, type CSSProperties } from "react";
import { images } from "./assets";
import { segsToD, textMetrics } from "./geometry";
import { mul, scale, toSvg } from "./matrix";
import { layoutText } from "./text";
import type { Artboard, GroupNode, Paint, SceneNode, TextNode } from "./types";

export interface RenderOptions {
  /** "screen" renders interactive content; "export" renders static markup for SVG export. */
  mode: "screen" | "export";
  artboards: Artboard[];
  clipArtboards: boolean;
  /** Overrides image URLs (export embeds data URLs). */
  imageHref?: (assetId: string) => string | undefined;
  /** Ids rendered invisible (e.g. text being edited). */
  hidden?: Set<string>;
  onTextMeasured?: () => void;
}

export const RenderContext = createContext<RenderOptions>({ mode: "screen", artboards: [], clipArtboards: true });

const blendStyle = (n: SceneNode): CSSProperties | undefined =>
  n.blend !== "normal" ? { mixBlendMode: n.blend } : undefined;

function PaintDef({ paint, id }: { paint: Paint | null; id: string }) {
  if (!paint || paint.kind === "solid") return null;
  const stops = paint.stops.map((s, i) => (
    <stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity ?? undefined} />
  ));
  const gt = paint.gt ? toSvg(paint.gt) : undefined;
  if (paint.kind === "linear") {
    return (
      <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={paint.x1} y1={paint.y1} x2={paint.x2} y2={paint.y2} gradientTransform={gt}>
        {stops}
      </linearGradient>
    );
  }
  return (
    <radialGradient
      id={id}
      gradientUnits="userSpaceOnUse"
      cx={paint.cx}
      cy={paint.cy}
      r={paint.r}
      fx={paint.fx}
      fy={paint.fy}
      fr={paint.fr}
      gradientTransform={gt}
    >
      {stops}
    </radialGradient>
  );
}

const paintRef = (paint: Paint | null, id: string) =>
  !paint ? "none" : paint.kind === "solid" ? paint.color : `url(#${id})`;

export const NodeView = memo(function NodeView({ node }: { node: SceneNode }) {
  const opts = useContext(RenderContext);
  if (!node.visible) return null;
  const interactive = opts.mode === "screen";
  const common = {
    "data-id": interactive ? node.id : undefined,
    opacity: node.opacity !== 1 ? node.opacity : undefined,
  };
  const lockedStyle: CSSProperties | undefined = interactive && node.locked ? { pointerEvents: "none" } : undefined;
  const style = { ...blendStyle(node), ...lockedStyle };

  switch (node.type) {
    case "path": {
      const fid = `f-${node.id}`;
      const sid = `s-${node.id}`;
      return (
        <>
          {(node.fill?.kind !== "solid" && node.fill) || (node.stroke?.kind !== "solid" && node.stroke) ? (
            <defs>
              <PaintDef paint={node.fill} id={fid} />
              <PaintDef paint={node.stroke} id={sid} />
            </defs>
          ) : null}
          <path
            {...common}
            style={style}
            d={segsToD(node.segs)}
            transform={toSvg(node.m)}
            fill={paintRef(node.fill, fid)}
            fillOpacity={node.fillOpacity !== 1 ? node.fillOpacity : undefined}
            fillRule={node.fillRule}
            stroke={paintRef(node.stroke, sid)}
            strokeOpacity={node.stroke && node.strokeOpacity !== 1 ? node.strokeOpacity : undefined}
            strokeWidth={node.stroke ? node.strokeWidth || 0.0001 : undefined}
            strokeLinecap={node.stroke && node.lineCap !== "butt" ? node.lineCap : undefined}
            strokeLinejoin={node.stroke && node.lineJoin !== "miter" ? node.lineJoin : undefined}
            strokeMiterlimit={node.stroke ? node.miterLimit : undefined}
            strokeDasharray={node.stroke && node.dash.length ? node.dash.join(" ") : undefined}
            strokeDashoffset={node.stroke && node.dash.length ? node.dashOffset : undefined}
            // Transparent-but-filled shapes should still be clickable.
            pointerEvents={interactive && !node.locked ? "visiblePainted" : undefined}
          />
        </>
      );
    }
    case "image": {
      const asset = images.get(node.asset);
      const href = opts.imageHref?.(node.asset) ?? asset?.url;
      if (!asset || !href) return null;
      return (
        <image
          {...common}
          style={style}
          href={href}
          width={asset.width}
          height={asset.height}
          preserveAspectRatio="none"
          transform={toSvg(mul(node.m, scale(1 / asset.width, 1 / asset.height)))}
        />
      );
    }
    case "text":
      return <TextView node={node} />;
    case "group":
      return <GroupView node={node} />;
  }
});

function GroupView({ node }: { node: GroupNode }) {
  const opts = useContext(RenderContext);
  const interactive = opts.mode === "screen";
  const ab = node.role === "artboard" && opts.clipArtboards ? opts.artboards[node.artboard ?? 0] : undefined;
  const clipId = node.clip || ab ? `c-${node.id}` : undefined;
  const maskId = node.mask ? `m-${node.id}` : undefined;
  const style: CSSProperties = {
    ...blendStyle(node),
    ...(interactive && node.locked ? { pointerEvents: "none" } : {}),
    // Layers are their own compositing context, like in Illustrator.
    ...(node.role ? { isolation: "isolate" } : {}),
  };
  return (
    <g
      data-id={interactive ? node.id : undefined}
      opacity={node.opacity !== 1 ? node.opacity : undefined}
      style={style}
      clipPath={clipId ? `url(#${clipId})` : undefined}
      mask={maskId ? `url(#${maskId})` : undefined}
    >
      {clipId || maskId ? (
        <defs>
          {clipId ? (
            <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
              {node.clip ? (
                <path d={segsToD(node.clip.segs)} transform={toSvg(node.clip.m)} clipRule={node.clip.rule} />
              ) : (
                <rect x={ab!.x} y={ab!.y} width={ab!.width} height={ab!.height} />
              )}
            </clipPath>
          ) : null}
          {node.mask ? (
            <mask
              id={maskId}
              maskUnits="userSpaceOnUse"
              x={-1e5}
              y={-1e5}
              width={2e5}
              height={2e5}
              style={{ maskType: node.mask.type }}
            >
              {node.mask.backdrop ? <rect x={-1e5} y={-1e5} width={2e5} height={2e5} fill={node.mask.backdrop} /> : null}
              <RenderContext.Provider value={{ ...opts, mode: "export" }}>
                {node.mask.nodes.map((c) => (
                  <NodeView key={c.id} node={c} />
                ))}
              </RenderContext.Provider>
            </mask>
          ) : null}
        </defs>
      ) : null}
      {node.children.map((c) => (
        <NodeView key={c.id} node={c} />
      ))}
    </g>
  );
}

function TextView({ node }: { node: TextNode }) {
  const opts = useContext(RenderContext);
  const ref = useRef<SVGTextElement>(null);
  const layout = layoutText(node);
  const interactive = opts.mode === "screen";

  useLayoutEffect(() => {
    if (!interactive || !ref.current) return;
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const b = el.getBBox();
      const prev = textMetrics.get(node.id);
      if (!prev || Math.abs(prev.x - b.x) + Math.abs(prev.y - b.y) + Math.abs(prev.w - b.width) + Math.abs(prev.h - b.height) > 0.01) {
        textMetrics.set(node.id, { x: b.x, y: b.y, w: b.width, h: b.height });
        opts.onTextMeasured?.();
      }
    };
    measure();
    // Web fonts may arrive later and change the metrics.
    document.fonts?.ready.then(measure);
  });

  const fid = `f-${node.id}`;
  const sid = `s-${node.id}`;
  const hidden = opts.hidden?.has(node.id);
  return (
    <>
      {(node.fill && node.fill.kind !== "solid") || (node.stroke && node.stroke.kind !== "solid") ? (
        <defs>
          <PaintDef paint={node.fill} id={fid} />
          <PaintDef paint={node.stroke} id={sid} />
        </defs>
      ) : null}
      <text
        ref={ref}
        data-id={interactive ? node.id : undefined}
        transform={toSvg(node.m)}
        opacity={hidden ? 0 : node.opacity !== 1 ? node.opacity : undefined}
        style={{
          ...blendStyle(node),
          whiteSpace: "pre",
          letterSpacing: !layout.glyphs && node.letterSpacing ? `${node.letterSpacing}px` : undefined,
          ...(interactive && node.locked ? { pointerEvents: "none" } : {}),
        }}
        fontSize={node.fontSize}
        fontFamily={layout.glyphs?.family}
        fontWeight={layout.glyphs?.weight}
        fontStyle={layout.glyphs?.italic ? "italic" : undefined}
        textAnchor={node.align && node.align !== "start" ? node.align : undefined}
        fill={paintRef(node.fill, fid)}
        fillOpacity={node.fillOpacity !== 1 ? node.fillOpacity : undefined}
        stroke={paintRef(node.stroke, sid)}
        strokeWidth={node.stroke ? node.strokeWidth : undefined}
        strokeOpacity={node.stroke && node.strokeOpacity !== 1 ? node.strokeOpacity : undefined}
        xmlSpace="preserve"
      >
        {layout.glyphs ? (
          <tspan x={layout.glyphs.xs.map((x) => +x.toFixed(3)).join(" ")} y={0}>
            {layout.glyphs.chars}
          </tspan>
        ) : (
          layout.lines!.map((runs, i) => (
            <tspan key={i} x={0} y={i * layout.lineHeight}>
              {runs.length ? (
                runs.map((r, k) => (
                  <tspan key={k} fontFamily={r.family} fontWeight={r.weight} fontStyle={r.italic ? "italic" : undefined}>
                    {r.text}
                  </tspan>
                ))
              ) : (
                // keep empty lines measurable
                " "
              )}
            </tspan>
          ))
        )}
      </text>
    </>
  );
}
