import { chmod } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["src/stdio.ts"],
  outfile: "dist/stdio.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: '#!/usr/bin/env node\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
await chmod("dist/stdio.js", 0o755);
