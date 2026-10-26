# Freestrator

An Adobe Illustrator-style vector editor for the web, built with Next.js + React, that **opens, edits and saves `.ai` files** right in the browser (the file never leaves your computer).

```bash
npm install
npm run dev        # http://localhost:3000
```

Open an `.ai` file with **Archivo › Abrir…** (⌘O) or by dropping it on the window.

## Features

- **Open** `.ai` files by reading **Illustrator's native data** with [`ai-file`](https://github.com/goncalveslucasv/ai-file) (Rust/WebAssembly codecs, in a Web Worker): real layers and sublayers, artboard names, text with its typeface and Illustrator's exact glyph positions, gradients with per-stop opacity, and embedded images (repeated copies are deduplicated). A 650 MB file opens in about 3.5 s, versus about 7.5 s through its PDF rendition, and the UI stays responsive meanwhile. Legacy PostScript `.ai` files open too.
- If the file has no native data (saved without "Preserve Illustrator Editing Capabilities") or is a plain PDF, its **PDF rendition** is read with pdf.js instead: each artboard is a page and layers (OCGs) are preserved.
- **View** with high fidelity: paths, clipping groups, opacity (luminosity) masks, blend modes, linear/radial gradients, gradient meshes, images, text with its embedded font, and ICC color management (e.g. Adobe RGB documents).
- **Edit**:
  - Tools: Selection (V), Direct Selection (A), Pen (P), Type (T), Line (\\), Rectangle (M), Ellipse (L), Eyedropper (I), Hand (H / Space), Zoom (Z).
  - Move, scale (⇧ proportional, ⌥ from the center), rotate (near the corners; ⇧ in 15° steps), reflect, align, arrange, group, clipping masks, duplicate with ⌥+drag.
  - Edit anchor points and curve handles with Direct Selection.
  - Double-click to enter a group (isolation mode) or edit text. Edited text keeps using the file's embedded font for the characters it contains and fills in the rest with the same family from Google Fonts.
  - Properties panel: position/size, fill and stroke (solid or gradient, with editable stops), stroke weight, opacity, blend mode, character (font, size, tracking), replace image.
  - Layers panel: visibility, lock, rename (double-click), reorder by dragging.
  - Undo/redo (⌘Z / ⇧⌘Z), copy/cut/paste, paste in place.
- **Save** as `.ai` (⌘S): a multi-page PDF with layers that Illustrator opens as a PDF-compatible file. The active artboard can also be exported as PDF, SVG and PNG (300 ppi).

## How it works

| Module | Role |
| --- | --- |
| `src/lib/native/` | Native reading: `worker.ts` decompresses (zstd/zlib in WebAssembly) and parses the native stream with `ai-file` off the main thread; `convert.ts` maps Illustrator's model (art space, y up) to the scene, splits the content by artboard and encodes images (PNG in Rust when they have alpha, JPEG otherwise). |
| `src/lib/importer.ts` | Tries native reading first. Without native data, loads the `.ai` with pdf.js and **interprets its operator list** (save/restore, CTM, clips, transparency groups, soft masks, shadings, images, text) to build an editable scene tree. It then simplifies the tree (drops redundant clips, turns "clip + shading" into a gradient-filled shape, flattens empty groups). |
| `src/lib/types.ts` | Scene model: layers › per-artboard sublayers › groups / paths / images / text. All geometry is in document space (pt, y down). |
| `src/lib/render.tsx` | SVG rendering of the scene, shared by the canvas and the SVG/PNG export. |
| `src/lib/store.ts`, `ops.ts`, `actions.ts` | State (zustand + immer, history that merges continuous changes), tree operations and editor commands. |
| `src/components/` | UI: canvas with tools and handles, toolbar, properties, layers and artboards panels, menus. |
| `src/lib/exportPdf.ts` | Writes the PDF/.ai with pdf-lib: hand-written content streams, shadings, luminosity masks, transparency groups, embedded fonts (TJ with the original positions) and layers as optional content. |

## Known limitations

- Native reading: live effects are shown and edited as their expanded result; area text and text on a path without composed lines, symbols, linked art and other plugin objects are skipped (a warning is logged to the console). Patterns are shown with a gray fill. CMYK colors are converted to RGB without an ICC profile. Text uses the real family loaded from Google Fonts, since the native stream doesn't carry embedded fonts.
- PDF fallback: Illustrator's private data isn't read, so you edit the artwork as it looks. Colors are converted to sRGB using the document's ICC profile.
- Saved files open in Illustrator as PDF (the native stream isn't written yet).
- Gradient meshes are rasterized on import.
