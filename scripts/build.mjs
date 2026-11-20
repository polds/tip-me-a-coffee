// Builds the browser bundles into dist/public and the Node server into dist/node.js.
// Wrangler bundles src/worker.ts itself and serves dist/public through its ASSETS binding.
import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

const browser = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  outdir: "dist/public",
  logLevel: "info",
};

await Promise.all([
  // One self-contained file, because other sites load it cross-origin.
  build({ ...browser, entryPoints: ["src/client/widget.ts"] }),
  // Split, so the wallet code and the payer SDK load only when a reader starts a tip.
  build({
    ...browser,
    entryPoints: ["src/client/tip.ts"],
    splitting: true,
    chunkNames: "chunk-[hash]",
    alias: { module: "./src/client/node-module.ts" },
  }),
  build({
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    entryPoints: ["src/node.ts"],
    outfile: "dist/node.js",
    logLevel: "info",
  }),
]);
