import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import standalone from "ajv/dist/standalone/index.js";
import { build } from "esbuild";
import {
  buildCatalog,
  createSchemaCompiler,
  excludedOperations,
  type OpenApiDocument,
} from "./catalog.js";

const root = new URL("../", import.meta.url);
const check = process.argv.slice(2).includes("--check");
const snapshot = await readFile(new URL("api/openapi.json", root));
const source = JSON.parse(
  await readFile(new URL("api/source.json", root), "utf8"),
);
const digest = createHash("sha256").update(snapshot).digest("hex");
if (source.sha256 !== digest)
  throw new Error(
    "Pinned API source digest mismatch; use api:refresh for an explicit refresh",
  );
const document: OpenApiDocument = JSON.parse(snapshot.toString("utf8"));
const ids = Object.values(document.paths).flatMap((path) =>
  Object.values(path).map(
    (operation) => (operation as { operationId?: string })?.operationId,
  ),
);
if (!Object.keys(excludedOperations).every((id) => ids.includes(id)))
  throw new Error("Pinned API exclusion accounting changed");
const operations = buildCatalog(document);
const compiler = createSchemaCompiler();
const exports: Record<string, string> = {};
for (const operation of operations) {
  compiler.addSchema(operation.inputSchema, operation.name);
  exports[operation.name] = operation.name;
}
const standaloneSource = standalone.default(compiler, exports);
const map = `\nexport const validators = {${operations.map((operation) => operation.name).join(",")}};\n`;
const bundled = await build({
  stdin: {
    contents: standaloneSource + map,
    resolveDir: fileURLToPath(root),
    sourcefile: "validators.js",
  },
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2022",
  legalComments: "none",
  minify: true,
  write: false,
});
const declaration = `export type Validator = (value: unknown) => boolean;\nexport declare const validators: Record<${operations.map((operation) => JSON.stringify(operation.name)).join(" | ")}, Validator>;\n`;
const artifacts = {
  "catalog.json": JSON.stringify(operations, null, 2) + "\n",
  "validators.js": bundled.outputFiles[0].text,
  "validators.d.ts": declaration,
};
if (!check) await mkdir(new URL("src/generated/", root), { recursive: true });
for (const [name, contents] of Object.entries(artifacts)) {
  const path = new URL(`src/generated/${name}`, root);
  if (check) {
    const existing = await readFile(path, "utf8").catch(() => undefined);
    if (existing !== contents)
      throw new Error(`Generated artifact differs: src/generated/${name}`);
  } else {
    await writeFile(path, contents);
  }
}
console.log(
  `${check ? "Verified" : "Generated"} ${operations.length} tools and validators; ${Object.keys(excludedOperations).length} documented exclusions`,
);
