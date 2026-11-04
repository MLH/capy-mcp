import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { buildCatalog, type OpenApiDocument } from "./catalog.js";

const url = "https://docs.capy.ai/openapi.json";
const response = await fetch(url, {
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  throw new Error(`API contract refresh failed with HTTP ${response.status}`);
}
const bytes = Buffer.from(await response.arrayBuffer());
const document: OpenApiDocument = JSON.parse(bytes.toString("utf8"));
buildCatalog(document);

const metadata = {
  url,
  retrievedAt: new Date().toISOString().slice(0, 10),
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
await writeFile(new URL("../api/openapi.json", import.meta.url), bytes);
await writeFile(
  new URL("../api/source.json", import.meta.url),
  JSON.stringify(metadata, null, 2) + "\n",
);
console.log(
  "Refreshed pinned API contract; run npm run generate and review the diff",
);
