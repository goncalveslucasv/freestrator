// Bundles the MCP server (and the editor code it shares from src/lib) into mcp/dist/server.mjs for
// publishing as the `freestrator-mcp` npm package. Dependencies stay external (see package.json).

import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: [new URL("./server.ts", import.meta.url).pathname],
  outfile: new URL("./dist/server.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  jsx: "automatic",
  // Only used by the browser-side .ai importer, which the server never calls.
  external: [...Object.keys(pkg.dependencies), "pdfjs-dist"],
  banner: { js: "#!/usr/bin/env node" },
  define: { "process.env.FREESTRATOR_MCP_VERSION": JSON.stringify(pkg.version) },
  logOverride: { "unsupported-directive": "silent" },
  logLevel: "warning",
});
console.log(`mcp/dist/server.mjs (freestrator-mcp ${pkg.version})`);
