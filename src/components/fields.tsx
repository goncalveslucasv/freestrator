"use client";

import { useState } from "react";

/** Numeric input that commits on Enter/blur and supports ↑/↓ (Shift = ×10). */
export function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  suffix,
  precision = 2,
  title,
}: {
  label?: string;
  value: number | null;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  precision?: number;
  title?: string;
}) {
  const shown = value === null || Number.isNaN(value) ? "" : String(+value.toFixed(precision));
  const [text, setText] = useState(shown);
  const [synced, setSynced] = useState(shown);
  const [focused, setFocused] = useState(false);
  // Follow external changes unless the user is typing.
  if (!focused && synced !== shown) {
    setSynced(shown);
    setText(shown);
  }
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = (raw: string) => {
    // Allow simple arithmetic like "10+5" or "100/2".
    const expr = raw.replace(",", ".").replace(/[^0-9+\-*/.() ]/g, "");
    if (!expr.trim()) return;
    let v: number;
    try {
      v = Function(`"use strict";return (${expr})`)();
    } catch {
      return;
    }
    if (Number.isFinite(v) && v !== value) onChange(clamp(v));
  };
  return (
    <label className="field" title={title}>
      {label ? <span className="field-label">{label}</span> : null}
      <input
        value={text}
        placeholder={value === null ? "—" : undefined}
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => {
          setFocused(false);
          commit(text);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            commit(text);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const base = value ?? 0;
            const next = clamp(base + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
            onChange(next);
            setText(String(+next.toFixed(precision)));
          } else if (e.key === "Escape") {
            setText(shown);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {suffix ? <span className="field-suffix">{suffix}</span> : null}
    </label>
  );
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const normHex = (v: string) => {
  let h = v.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return "#" + h.toLowerCase();
};

/** Colour picker + hex input. */
export function ColorField({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setText(value);
  }
  return (
    <span className="color-field">
      <input
        type="color"
        value={HEX.test(value) ? normHex(value) : "#000000"}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        className="hex"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        onBlur={() => (HEX.test(text) ? onChange(normHex(text)) : setText(value))}
      />
    </span>
  );
}

export function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="panel-section">
      <header onClick={() => setOpen(!open)}>
        <span className={`chev ${open ? "open" : ""}`}>▸</span>
        <span className="title">{title}</span>
        <span className="actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      </header>
      {open ? <div className="panel-body">{children}</div> : null}
    </section>
  );
}
