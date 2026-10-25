"use client";

// Exposes editor internals on window.__fs in development, for automated browser tests.

import * as actions from "./actions";
import * as assets from "./assets";
import * as ops from "./ops";
import * as store from "./store";

export function installDebugHandle() {
  (window as unknown as { __fs: unknown }).__fs = {
    ...store,
    actions,
    ops,
    assets,
    exportPdf: () => import("./exportPdf").then((m) => m.exportPdf),
    exportSvg: () => import("./exportSvg"),
  };
}
