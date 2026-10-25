// Copies the pdf.js worker and its data files (cmaps, standard fonts, wasm decoders) to public/pdfjs.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("pdfjs-dist/package.json"));
const out = join(process.cwd(), "public", "pdfjs");
mkdirSync(out, { recursive: true });
cpSync(join(root, "build", "pdf.worker.min.mjs"), join(out, "pdf.worker.min.mjs"));
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  cpSync(join(root, dir), join(out, dir), { recursive: true });
}
console.log("pdf.js assets copied to public/pdfjs");
