import type { CredentialEnvelope } from "./store.js";

export interface EncryptionConfig {
  keyId: string;
  key: Uint8Array<ArrayBuffer>;
}

export const MAX_CREDENTIAL_BYTES = 4_096;
const encoder = new TextEncoder();
const nonceBytes = 12;
const tagBytes = 16;

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function decodeBase64(value: string, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (value.length > Math.ceil(maxBytes / 3) * 4) throw new Error("Invalid base64");
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (bytes.length > maxBytes || base64(bytes) !== value) throw new Error("Invalid base64");
  return bytes;
}

export function isCredentialKey(key: string): boolean {
  return key.length <= MAX_CREDENTIAL_BYTES && /^[\x21-\x7e]+$/.test(key);
}

function credentialCipher(
  accountId: string, version: number, config: EncryptionConfig, iv: Uint8Array<ArrayBuffer>, usage: KeyUsage,
) {
  if (!accountId || !Number.isSafeInteger(version) || version < 1 || config.key.length !== 32 || iv.length !== nonceBytes) {
    throw new Error("Invalid credential envelope");
  }
  return {
    algorithm: { name: "AES-GCM", iv, additionalData: encoder.encode(JSON.stringify([accountId, version, config.keyId])), tagLength: tagBytes * 8 },
    key: crypto.subtle.importKey("raw", config.key, "AES-GCM", false, [usage]),
  };
}

export async function encryptCredential(key: string, accountId: string, version: number, config: EncryptionConfig): Promise<CredentialEnvelope> {
  if (!isCredentialKey(key)) throw new Error("Invalid credential");
  try {
    const nonce = crypto.getRandomValues(new Uint8Array(nonceBytes));
    const cipher = credentialCipher(accountId, version, config, nonce, "encrypt");
    const ciphertext = await crypto.subtle.encrypt(cipher.algorithm, await cipher.key, encoder.encode(key));
    return { keyId: config.keyId, nonce: base64(nonce), ciphertext: base64(new Uint8Array(ciphertext)), version };
  } catch {
    throw new Error("Invalid credential");
  }
}

export async function decryptCredential(envelope: CredentialEnvelope, accountId: string, config: EncryptionConfig): Promise<string> {
  try {
    if (envelope.keyId !== config.keyId) throw new Error("Invalid credential envelope");
    const nonce = decodeBase64(envelope.nonce, nonceBytes);
    const ciphertext = decodeBase64(envelope.ciphertext, MAX_CREDENTIAL_BYTES + tagBytes);
    const cipher = credentialCipher(accountId, envelope.version, config, nonce, "decrypt");
    const plaintext = await crypto.subtle.decrypt(cipher.algorithm, await cipher.key, ciphertext);
    const key = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (!isCredentialKey(key)) throw new Error("Invalid credential envelope");
    return key;
  } catch {
    throw new Error("Invalid credential envelope");
  }
}

export async function hashOpaqueId(id: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(id));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
