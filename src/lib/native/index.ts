// Native .ai import: runs ai-file (Rust/WebAssembly) in a Web Worker and registers the resulting
// images in the asset registry.

import { ensureWebFont, images } from "../assets";
import type { Doc } from "../types";
import type { NativeRequest, NativeResponse } from "./protocol";

export type ProgressFn = (message: string, fraction: number) => void;

/**
 * Opens the file through Illustrator's own native data. Resolves to null when the file has none
 * (a plain PDF, or an .ai saved without "Preserve Illustrator Editing Capabilities").
 */
export function importNative(blob: Blob, name: string, onProgress: ProgressFn): Promise<Doc | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const finish = () => worker.terminate();
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message || "Error en el lector nativo"));
    };
    worker.onmessage = (e: MessageEvent<NativeResponse>) => {
      const msg = e.data;
      switch (msg.type) {
        case "progress":
          onProgress(msg.message, msg.fraction);
          return;
        case "unsupported":
          finish();
          resolve(null);
          return;
        case "error":
          finish();
          reject(new Error(msg.message));
          return;
        case "done": {
          finish();
          const { result, timings } = msg;
          for (const img of result.images) {
            const blob = new Blob([img.data as BlobPart], { type: img.type });
            const display = img.proxy ? new Blob([img.proxy as BlobPart], { type: img.type }) : blob;
            images.set(img.id, { id: img.id, blob, url: URL.createObjectURL(display), width: img.width, height: img.height, hasAlpha: img.hasAlpha });
          }
          for (const family of result.families) ensureWebFont(family);
          if (result.warnings.length) console.warn("[ai-file]", result.warnings);
          console.info(
            `[ai-file] ${msg.compression}: decompress ${timings.decompress.toFixed(0)} ms, ` +
              `parse ${timings.parse.toFixed(0)} ms, scene ${timings.convert.toFixed(0)} ms`,
          );
          resolve(result.doc);
        }
      }
    };
    worker.postMessage({ file: blob, name } satisfies NativeRequest);
  });
}
