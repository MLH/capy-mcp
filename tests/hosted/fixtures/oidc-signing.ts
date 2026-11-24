const encoder = new TextEncoder();

export function signingKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["sign", "verify"]);
}

export async function signingJwk(key: CryptoKey) {
  return { ...await crypto.subtle.exportKey("jwk", key), kid: "fixture-key", alg: "RS256", use: "sig" };
}

export async function signedIdToken(key: CryptoKey, claims: Record<string, unknown>, corrupt = false) {
  const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const message = [JSON.stringify({ alg: "RS256", kid: "fixture-key" }), JSON.stringify(claims)]
    .map((part) => base64url(encoder.encode(part))).join(".");
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(message)));
  if (corrupt) signature[0] ^= 1;
  return `${message}.${base64url(signature)}`;
}
