import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential, hashOpaqueId } from "../../src/hosted/crypto.js";
import { fakeEncryption } from "./fixtures.js";

describe("credential encryption in workerd", () => {
  const key = "fake-credential-for-vault-test";

  it("round-trips a Capy key with a fresh 96-bit nonce for each encryption", async () => {
    const [first, second] = await Promise.all([
      encryptCredential(key, "account-a", 1, fakeEncryption()),
      encryptCredential(key, "account-a", 1, fakeEncryption()),
    ]);
    expect(first).toMatchObject({ keyId: "v1", version: 1 });
    expect(atob(first.nonce)).toHaveLength(12);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(atob(first.ciphertext)).not.toContain(key);
    expect(await decryptCredential(first, "account-a", fakeEncryption())).toBe(key);
  });

  it("rejects account and version swaps, a wrong key or key ID, and corrupted envelopes without secret details", async () => {
    const envelope = await encryptCredential(key, "account-a", 1, fakeEncryption());
    const decoded = atob(envelope.ciphertext);
    const ciphertext = btoa(String.fromCharCode(decoded.charCodeAt(0) ^ 1) + decoded.slice(1));
    const attempts = [
      decryptCredential(envelope, "account-b", fakeEncryption()),
      decryptCredential({ ...envelope, version: 2 }, "account-a", fakeEncryption()),
      decryptCredential(envelope, "account-a", fakeEncryption(8)),
      decryptCredential({ ...envelope, keyId: "v2" }, "account-a", fakeEncryption()),
      decryptCredential({ ...envelope, ciphertext }, "account-a", fakeEncryption()),
      decryptCredential({ ...envelope, nonce: btoa("bad") }, "account-a", fakeEncryption()),
      decryptCredential({ ...envelope, ciphertext: "not-base64" }, "account-a", fakeEncryption()),
    ];
    await Promise.all(attempts.map((attempt) => expect(attempt).rejects.toThrow(/^Invalid credential envelope$/)));
  });

  it("accepts exactly 4 KiB of bearer material and rejects oversized or invalid inputs", async () => {
    const atLimit = "x".repeat(4_096);
    const envelope = await encryptCredential(atLimit, "account-a", 1, fakeEncryption());
    expect(await decryptCredential(envelope, "account-a", fakeEncryption())).toBe(atLimit);
    await Promise.all(["", atLimit + "x", "with space", "with\nnewline", "é"].map((value) =>
      expect(encryptCredential(value, "account-a", 1, fakeEncryption())).rejects.toThrow(/^Invalid credential$/),
    ));
  });

  it("represents opaque identifiers by their SHA-256 digest", async () => {
    expect(await hashOpaqueId("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
