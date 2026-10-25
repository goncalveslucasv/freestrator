// Binary resources (images, fonts) live outside the reactive document state.
// Nodes reference them by id.

export interface ImageAsset {
  id: string;
  /** Full resolution encoded image (used for export). */
  blob: Blob;
  /** Object URL used for on-screen display (may be a downscaled proxy). */
  url: string;
  width: number;
  height: number;
  hasAlpha: boolean;
}

export interface FontAsset {
  id: string;
  /** PostScript name, e.g. "Syne-Bold" (subset prefix removed). */
  name: string;
  /** CSS family registered in document.fonts by pdf.js (renders the embedded glyphs). */
  loadedName?: string;
  /** Human family name used for fallbacks, e.g. "Syne". */
  family: string;
  weight: number;
  italic: boolean;
  /** unicode string -> glyph char inside the embedded font. */
  map: Record<string, string>;
  /** Advance width per glyph char, in 1/1000 em. */
  widths: Record<string, number>;
  /** OpenType data of the embedded font, as rebuilt by pdf.js. */
  data?: Uint8Array;
}

export const images = new Map<string, ImageAsset>();
export const fonts = new Map<string, FontAsset>();

/** The open pdf.js document. Kept alive because it owns the registered FontFaces. */
export const pdfHandles: { destroy?: () => Promise<void> } = {};

export async function resetAssets() {
  for (const img of images.values()) URL.revokeObjectURL(img.url);
  images.clear();
  fonts.clear();
  await pdfHandles.destroy?.();
  pdfHandles.destroy = undefined;
}

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/extra\s*light|ultra\s*light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

/** "ABCDEF+Syne-SemiBold" -> { name: "Syne-SemiBold", family: "Syne", weight: 600, italic: false } */
export function parseFontName(raw: string) {
  const name = raw.replace(/^[A-Z]{6}\+/, "");
  const [familyPart, stylePart = ""] = name.split(/[-,]/);
  const family = familyPart.replace(/(MT|PS|Std|Pro)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  let weight = 400;
  for (const [re, w] of WEIGHTS) {
    if (re.test(stylePart)) {
      weight = w;
      break;
    }
  }
  const italic = /italic|oblique/i.test(stylePart);
  return { name, family, weight, italic };
}

const requestedFamilies = new Set<string>();
/** Loads a family from Google Fonts so edited text can fall back to the real typeface. */
export function ensureWebFont(family: string) {
  if (typeof document === "undefined" || !family || requestedFamilies.has(family)) return;
  requestedFamilies.add(family);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:ital,wght@0,100..900;1,100..900&display=swap`;
  link.onerror = () => {
    // Families without variable axes need the plain request.
    const plain = document.createElement("link");
    plain.rel = "stylesheet";
    plain.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;700&display=swap`;
    document.head.append(plain);
  };
  document.head.append(link);
}
