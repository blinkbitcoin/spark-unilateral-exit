import { describe, expect, it } from "vitest";
import { decodeImportedBundle } from "../../desktop/import-bundle.ts";
import { encryptBackup, MAX_FILE_BYTES } from "../../desktop/vault.ts";
import { blinkBackup, bundle, SEED, PASSWORD } from "./helpers.ts";

describe("existing recovery bundle formats", () => {
  it("reads Blink/CLI exports and password-encrypted desktop backups", async () => {
    const value = bundle();
    expect(await decodeImportedBundle(JSON.stringify(value), SEED, "")).toEqual(value);
    const encrypted = await encryptBackup(value, PASSWORD);
    expect(await decodeImportedBundle(encrypted, SEED, PASSWORD)).toEqual(value);
    await expect(decodeImportedBundle(encrypted, SEED, "wrong")).rejects.toThrow();
  });
  it("decrypts Blink's seed-encrypted WebCrypto envelope, rejecting a wrong seed or damaged ciphertext", async () => {
    const envelope = await blinkBackup();
    expect(await decodeImportedBundle(JSON.stringify(envelope), SEED, "")).toEqual(bundle(0));
    await expect(decodeImportedBundle(JSON.stringify(envelope), "01".repeat(64), "")).rejects.toThrow("cannot decrypt");
    const damaged = Buffer.from(envelope.data, "base64"); damaged[0]! ^= 1;
    await expect(decodeImportedBundle(JSON.stringify({ ...envelope, data: damaged.toString("base64") }), SEED, "")).rejects.toThrow("damaged");
    for (const plaintext of ["{", "{}"])
      await expect(decodeImportedBundle(JSON.stringify(await blinkBackup(bundle(0), plaintext)), SEED, "")).rejects.toThrow();
  });
  it("rejects malformed, unsupported, oversized and unauthenticated envelope metadata", async () => {
    for (const raw of ["null", "false", "1", '"bundle"', "[]"])
      await expect(decodeImportedBundle(raw, SEED, "")).rejects.toThrow("JSON recovery bundle");
    await expect(decodeImportedBundle("{", SEED, "")).rejects.toThrow();
    await expect(decodeImportedBundle(" ".repeat(MAX_FILE_BYTES + 1), SEED, "")).rejects.toThrow("too large");
    const envelope = await blinkBackup();
    for (const field of ["encrypted", "cipher", "keyDerivation", "context", "iv", "data"])
      await expect(decodeImportedBundle(JSON.stringify({ ...envelope, [field]: null }), SEED, "")).rejects.toThrow("Unsupported Blink");
    for (const field of ["iv", "data"])
      await expect(decodeImportedBundle(JSON.stringify({ ...envelope, [field]: "" }), SEED, "")).rejects.toThrow("Damaged Blink");
    for (const field of ["network", "walletIdentityPublicKey", "bundleCreatedAt"])
      await expect(decodeImportedBundle(JSON.stringify({ ...envelope, [field]: "changed" }), SEED, "")).rejects.toThrow("metadata");
  });
});
