// Web Worker: reads Illustrator's native data with ai-file (Rust/WebAssembly codecs) and converts
// it to a scene off the main thread. The decompressed stream (up to a few GB) never leaves the worker.

import { initWasm, openAiContainer, parseAiStream } from "ai-file";
import { convertNative } from "./convert";
import type { NativeRequest, NativeResponse } from "./protocol";

const post = (msg: NativeResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
const progress = (message: string, fraction: number) => post({ type: "progress", message, fraction });

self.onmessage = async (e: MessageEvent<NativeRequest>) => {
  const { file, name } = e.data;
  try {
    const t0 = performance.now();
    progress("Leyendo archivo…", 0);
    const ready = initWasm();
    const bytes = new Uint8Array(await file.arrayBuffer());
    await ready;

    let container;
    try {
      container = openAiContainer(bytes, {
        onProgress: (done, total) => progress("Descomprimiendo datos de Illustrator…", 0.05 + 0.45 * (done / total)),
      });
    } catch (err) {
      // No native data (PDF saved without "Preserve Illustrator Editing Capabilities", or a plain PDF).
      post({ type: "unsupported", reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    const t1 = performance.now();
    progress("Interpretando objetos…", 0.5);
    const ai = parseAiStream(container.stream);
    const t2 = performance.now();
    progress("Construyendo la escena…", 0.6);
    const result = await convertNative(ai, name, (f) => progress("Construyendo la escena…", 0.6 + 0.4 * f));
    const t3 = performance.now();
    const transfer = result.images.flatMap((i) => (i.proxy ? [i.data.buffer, i.proxy.buffer] : [i.data.buffer]));
    post(
      {
        type: "done",
        result,
        timings: { decompress: t1 - t0, parse: t2 - t1, convert: t3 - t2 },
        compression: container.compression,
      },
      transfer as Transferable[],
    );
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
