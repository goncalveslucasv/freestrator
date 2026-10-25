"use client";

import { setTool, useEditor, type Tool } from "@/lib/store";
import type { Paint } from "@/lib/types";

const ICONS: Record<Tool, React.ReactNode> = {
  select: <path d="M6 3l12 9.5-5.2.9 3.1 6.3-2.3 1.1-3.1-6.4L6 18z" fill="currentColor" />,
  direct: <path d="M6 3l12 9.5-5.2.9 3.1 6.3-2.3 1.1-3.1-6.4L6 18z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
  pen: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M12 3l5 9-5 9-5-9z" />
      <circle cx="12" cy="13" r="1.6" fill="currentColor" />
      <path d="M12 3v8.4" />
    </g>
  ),
  rect: <rect x="4" y="6" width="16" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" />,
  ellipse: <ellipse cx="12" cy="12" rx="8.5" ry="6.5" fill="none" stroke="currentColor" strokeWidth="1.7" />,
  line: <path d="M5 19L19 5" stroke="currentColor" strokeWidth="1.8" />,
  text: <path d="M5 5h14v3h-1.5V6.6h-4.6V18h2v1.5H9.1V18h2V6.6H6.5V8H5z" fill="currentColor" />,
  eyedropper: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M14.5 5.5l4 4" />
      <path d="M16.5 3.5a2 2 0 0 1 3 3l-2 2-3-3z" fill="currentColor" />
      <path d="M14 8l-8.5 8.5L5 19l2.5-.5L16 10" />
    </g>
  ),
  hand: (
    <path
      d="M8 11V5.5a1.3 1.3 0 0 1 2.6 0V10m0-.5V4.3a1.3 1.3 0 0 1 2.6 0V10m0-.6V5.2a1.3 1.3 0 0 1 2.6 0V11m0-1.2a1.3 1.3 0 0 1 2.6 0V14a6 6 0 0 1-6 6h-.8a6 6 0 0 1-4.6-2.2L4.6 14.4a1.4 1.4 0 0 1 2.1-1.8L8 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  ),
  zoom: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5M8 10.5h5M10.5 8v5" />
    </g>
  ),
};

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: "select", label: "Selección", key: "V" },
  { tool: "direct", label: "Selección directa", key: "A" },
  { tool: "pen", label: "Pluma", key: "P" },
  { tool: "text", label: "Texto", key: "T" },
  { tool: "line", label: "Segmento de línea", key: "\\" },
  { tool: "rect", label: "Rectángulo", key: "M" },
  { tool: "ellipse", label: "Elipse", key: "L" },
  { tool: "eyedropper", label: "Cuentagotas", key: "I" },
  { tool: "hand", label: "Mano", key: "H" },
  { tool: "zoom", label: "Zoom", key: "Z" },
];

export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.tool]));

function Swatch({ paint, stroke }: { paint: Paint | null; stroke?: boolean }) {
  const bg = !paint ? undefined : paint.kind === "solid" ? paint.color : `linear-gradient(90deg, ${paint.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(", ")})`;
  return (
    <span className={`swatch ${stroke ? "swatch-stroke" : "swatch-fill"} ${paint ? "" : "swatch-none"}`} style={{ background: bg }}>
      {stroke ? <span className="swatch-hole" /> : null}
    </span>
  );
}

export function Toolbar() {
  const tool = useEditor((s) => s.tool);
  const fill = useEditor((s) => s.defaultFill);
  const stroke = useEditor((s) => s.defaultStroke);
  return (
    <div className="toolbar">
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          className={`tool ${tool === t.tool ? "active" : ""}`}
          title={`${t.label} (${t.key})`}
          aria-label={t.label}
          onClick={() => setTool(t.tool)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20">
            {ICONS[t.tool]}
          </svg>
        </button>
      ))}
      <div className="tool-sep" />
      <div className="fill-stroke" title="Relleno y trazo por defecto (X para intercambiar)">
        <Swatch paint={stroke} stroke />
        <Swatch paint={fill} />
      </div>
      <button
        className="tool small"
        title="Intercambiar relleno y trazo (Mayús+X)"
        onClick={() => useEditor.setState((s) => ({ defaultFill: s.defaultStroke, defaultStroke: s.defaultFill }))}
      >
        ⇄
      </button>
    </div>
  );
}
