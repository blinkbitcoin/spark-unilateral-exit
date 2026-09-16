import { createDecipheriv, createHmac } from "node:crypto";
import { parseSeed } from "../src/sweep.ts";
import { validateRecoveryBundle } from "../src/bundle.ts";
import { decryptBackup, MAX_FILE_BYTES } from "./vault.ts";

const BLINK_SCHEMA = "blink.recovery-bundle-backup.v1";
const BLINK_CONTEXT = "blink:recovery-bundle:aes-128-gcm:v1";

/** Blink file exports and CLI exports share a schema; cloud copies add an envelope. */
export async function decodeImportedBundle(raw: string, seed: string, password: string) {
  if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new Error("Backup file is too large.");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Choose a JSON recovery bundle.");
  if (parsed.format === "spark.desktop.vault.v1") return validateRecoveryBundle(await decryptBackup(raw, password));
  if (parsed.schema !== BLINK_SCHEMA) return validateRecoveryBundle(parsed);
  if (parsed.encrypted !== true || parsed.cipher !== "AES-128-GCM" ||
      parsed.keyDerivation !== "hmac-sha256-seed" || parsed.context !== BLINK_CONTEXT ||
      typeof parsed.iv !== "string" || typeof parsed.data !== "string") {
    throw new Error("Unsupported Blink backup encryption.");
  }
  const iv = Buffer.from(parsed.iv, "base64");
  const data = Buffer.from(parsed.data, "base64");
  if (iv.length !== 12 || data.length < 16) throw new Error("Damaged Blink backup.");
  const seedBytes = parseSeed(seed);
  const key = createHmac("sha256", seedBytes).update(BLINK_CONTEXT).digest();
  seedBytes.fill(0);
  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-128-gcm", key.subarray(0, 16), iv);
    decipher.setAuthTag(data.subarray(-16));
    plaintext = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("This seed cannot decrypt the Blink backup, or the file is damaged.");
  } finally {
    key.fill(0);
  }
  const bundle = validateRecoveryBundle(JSON.parse(plaintext));
  // Blink's envelope has no AAD; bind its metadata to the authenticated contents.
  if (parsed.network !== bundle.network || parsed.walletIdentityPublicKey !== bundle.walletIdentityPublicKey ||
      parsed.bundleCreatedAt !== bundle.createdAt) {
    throw new Error("Blink backup metadata does not match its encrypted contents.");
  }
  return bundle;
}
