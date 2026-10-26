import { fonts } from "./assets";
import type { TextNode } from "./types";

export interface TextRun {
  text: string;
  /** Text is in glyph chars of the embedded font (not unicode). */
  embedded: boolean;
  family: string;
  weight: number | "normal";
  italic: boolean;
}

export interface TextLayout {
  /** Exact glyph run from the source file. Without an embedded font, `chars` are unicode in a fallback family. */
  glyphs?: { chars: string; xs: number[]; family: string; weight?: number; italic?: boolean };
  /** One entry per line; each line is split into runs by font. */
  lines?: TextRun[][];
  lineHeight: number;
}

const quote = (f: string) => (/^[\w-]+$/.test(f) && !/^\d/.test(f) ? f : `"${f.replace(/"/g, "")}"`);
export const fallbackFamily = (n: Pick<TextNode, "family">) => `${quote(n.family)}, "Helvetica Neue", Arial, sans-serif`;

/**
 * Decides how a text node is drawn:
 * - untouched text keeps the exact glyph positions and the embedded font;
 * - edited text uses the embedded font for every character it contains and falls back to the
 *   real family (loaded from Google Fonts when available) for the rest.
 */
export function layoutText(n: TextNode): TextLayout {
  const font = n.font ? fonts.get(n.font) : undefined;
  const lineHeight = n.fontSize * 1.2;
  if (n.glyphs && font?.loadedName) {
    return { glyphs: { ...n.glyphs, family: quote(font.loadedName) }, lineHeight };
  }
  // Native .ai text: exact positions from Illustrator's layout, drawn with the real family.
  if (n.glyphs && !n.font) {
    return { glyphs: { ...n.glyphs, family: fallbackFamily(n), weight: n.weight, italic: n.italic }, lineHeight };
  }
  const fallback: TextRun = { text: "", embedded: false, family: fallbackFamily(n), weight: n.weight, italic: n.italic };
  const lines = n.text.split("\n").map((line) => {
    const runs: TextRun[] = [];
    for (const ch of line) {
      const mapped = font?.loadedName ? font.map[ch] : undefined;
      const run: TextRun = mapped
        ? { text: mapped, embedded: true, family: `${quote(font!.loadedName!)}, ${fallback.family}`, weight: "normal" as const, italic: false }
        : { ...fallback, text: ch };
      const last = runs.at(-1);
      if (last && last.family === run.family) last.text += run.text;
      else runs.push(run);
    }
    return runs;
  });
  return { lines, lineHeight };
}

/** CSS font for editing text in an HTML control. */
export function editingFont(n: TextNode) {
  return { fontFamily: fallbackFamily(n), fontWeight: n.weight, fontStyle: n.italic ? "italic" : "normal" };
}
