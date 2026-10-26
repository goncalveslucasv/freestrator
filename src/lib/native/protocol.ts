import type { NativeResult } from "./convert";

export interface NativeRequest {
  file: Blob;
  name: string;
}

export type NativeResponse =
  | { type: "progress"; message: string; fraction: number }
  | {
      type: "done";
      result: NativeResult;
      timings: { decompress: number; parse: number; convert: number };
      compression: string;
    }
  /** The file has no native Illustrator data: use the PDF rendition instead. */
  | { type: "unsupported"; reason: string }
  | { type: "error"; message: string };
