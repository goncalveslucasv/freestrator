"use client";

import { images } from "./assets";
import { newId } from "./geometry";
import { about, mul, scale } from "./matrix";
import { getNodes } from "./ops";
import { commit, useEditor } from "./store";
import type { Doc } from "./types";

/** Replaces the selected images with `file`, covering the same area (centre-cropped like "fill"). */
export async function replaceImage(file: File) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  bitmap.close();
  const id = newId("img");
  const isPng = file.type === "image/png" || file.type === "image/webp" || file.type === "image/gif";
  images.set(id, { id, blob: file, url: URL.createObjectURL(file), width, height, hasAlpha: isPng });

  const { selection } = useEditor.getState();
  commit((d) => {
    for (const n of getNodes(d as Doc, selection)) {
      if (n.type !== "image") continue;
      const old = images.get(n.asset);
      // Aspect ratio of the area currently covered on the page.
      const sx = Math.hypot(n.m[0], n.m[1]);
      const sy = Math.hypot(n.m[2], n.m[3]);
      const placed = sx / sy || (old ? old.width / old.height : 1);
      const ratio = width / height;
      const fix = ratio > placed ? scale(ratio / placed, 1) : scale(1, placed / ratio);
      n.m = mul(n.m, about(fix, 0.5, 0.5));
      n.asset = id;
    }
  });
}
