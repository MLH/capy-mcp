import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const runtime = import.meta.resolve("@cloudflare/workers-oauth-provider");
const upstream = new URL("../", runtime);
const output = new URL("../src/hosted/generated-provider/", import.meta.url);
const read = path => readFile(new URL(path, upstream), "utf8");
const [manifest, license, js, types] = await Promise.all(["package.json", "LICENSE.txt", "dist/oauth-provider.js", "dist/oauth-provider.d.ts"].map(read));
const digest = text => createHash("sha256").update(text).digest("hex");
if (JSON.parse(manifest).version !== "1.3.0" ||
    digest(js) !== "2d9d86d20e5de2bd86d061287d2dfd5b5f891b4f0f2687cda0fd7bce6cb91fff" ||
    digest(types) !== "efbc9b828476a2634cf7694654d5fba038d64400736aa6e934df5fe3e00d6cdb") {
  throw new Error("Unrecognized Workers OAuth Provider input: review the upstream changes before regenerating");
}
function replaceOnce(source, before, after) {
  const parts = source.split(before);
  if (parts.length !== 2) throw new Error("OAuth provider patch anchor is absent or ambiguous");
  return parts[0] + after + parts[1];
}
let patched = replaceOnce(js, "return fetch(metadataUrl, {", 'return fetch(metadataUrl, {\n\t\tredirect: "manual",');
patched = replaceOnce(patched, "if (!response.ok) {\n\t\t\tawait response.body?.cancel()", "if (response.status !== 200) {\n\t\t\tawait response.body?.cancel()");
const revoke = "if (grantData.clientId !== clientInfo.clientId) return false;\n\t\tawait this.createOAuthHelpers(env).revokeGrant(grantId, userId);";
patched = replaceOnce(patched, revoke, revoke.replace("await this.createOAuthHelpers", "await this.options.onVerifiedRefreshRevocation?.({ userId, grantId, clientId: clientInfo.clientId, env });\n\t\tawait this.createOAuthHelpers"));
const iface = "interface OAuthProviderOptions<Env = Cloudflare.Env> {";
const declarations = replaceOnce(types, iface, iface + "\n  onVerifiedRefreshRevocation?: (grant: { userId: string; grantId: string; clientId: string; env: Env }) => Promise<void>;");
const check = process.argv.includes("--check");
if (!check) await mkdir(output, { recursive: true });
for (const [file, contents] of [
  ["oauth-provider.js", "/*!\n" + license.trim() + "\n*/\n" + patched],
  ["oauth-provider.d.ts", declarations], ["LICENSE.txt", license],
]) {
  const url = new URL(file, output);
  if (!check) await writeFile(url, contents);
  else if (await readFile(url, "utf8") !== contents) throw new Error("Hosted provider output differs: " + file);
}
