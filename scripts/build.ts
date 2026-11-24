import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/stdio.ts"],
  outfile: "dist/stdio.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  metafile: true,
  banner: { js: '#!/usr/bin/env node\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
await chmod("dist/stdio.js", 0o755);

const directories = new Set(["node_modules/ajv", "node_modules/ajv-formats"]);
for (const input of Object.keys(result.metafile.inputs)) {
  const directory = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/)?.[1];
  if (directory) directories.add(directory);
}
const notices = [];
for (const directory of [...directories].sort()) {
  const manifest = JSON.parse(await readFile(`${directory}/package.json`, "utf8"));
  const files = (await readdir(directory)).filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file)).sort();
  if (files.length === 0) throw new Error(`Missing license notice for ${manifest.name}`);
  notices.push(`${manifest.name}@${manifest.version} (${manifest.license})`);
  for (const file of files) notices.push(await readFile(`${directory}/${file}`, "utf8"));
}
await writeFile("dist/THIRD_PARTY_NOTICES.txt", notices.join("\n\n") + "\n");
