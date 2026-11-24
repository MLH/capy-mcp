import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "capy-mcp-pack-"));
const run = (file, args, options) => execFileSync(file, args, { encoding: "utf8", timeout: 30_000, ...options });
const excludes = /(?:\.dev\.vars|\.secrets\.production\.json|tests\/hosted\/|browser-fixture|test-client-secret|demo-member|fixture-access-token)/;
try {
  const [pack] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", dir]));
  const paths = ["README.md", "dist/stdio.js", "package.json"];
  assert.deepEqual(pack.files.map(file => file.path).sort(), paths);
  const archive = join(dir, pack.filename);
  assert.deepEqual(run("tar", ["-tzf", archive]).trim().split("\n").sort(), paths.map(path => "package/" + path));
  run("tar", ["-xzf", archive, "-C", dir]);

  const packageDir = join(dir, "package");
  const artifact = join(packageDir, "dist/stdio.js");
  const source = await readFile(artifact, "utf8");
  assert.equal(excludes.test(source), false, "STDIO contains a hosted fixture or secret file reference");
  assert.equal(/workers-oauth-provider|openid-client|cloudflare:workers|OIDC_CLIENT_SECRET|CREDENTIAL_ENCRYPTION_KEY/.test(source), false,
    "STDIO contains hosted code");
  assert.ok((await stat(artifact)).mode & 0o111);
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  assert.deepEqual(manifest.bin, { "capy-mcp": "dist/stdio.js" });
  assert.equal(manifest.private, true);
  const response = JSON.parse(run(process.execPath, [artifact], { cwd: packageDir, env: { CAPY_API_KEY: "fixture-package-key" },
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "package-check", version: "1" } } }) + "\n" }));
  assert.equal(response.result?.serverInfo?.name, "capy-mcp");

  const worker = "dist/worker";
  assert.deepEqual((await readdir(worker)).sort(), ["README.md", "worker.js", "worker.js.map"]);
  for (const file of ["worker.js", "worker.js.map"]) {
    assert.equal(excludes.test(await readFile(join(worker, file), "utf8")), false, "Worker contains a fixture or secret file reference");
  }
  console.log("PASS: STDIO tarball contains only README, manifest and executable; it initializes without node_modules. Worker artifacts contain no test fixtures or secret file references.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
