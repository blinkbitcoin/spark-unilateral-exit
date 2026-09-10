import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { mkdir, open, readFile, rename, copyFile, unlink, readdir } from "node:fs/promises";
import path from "node:path";

const FORMAT = "spark.desktop.vault.v1";
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
type Envelope = { format: string; salt: string; iv: string; tag: string; data: string };

export function generatePassword(): string { return randomBytes(24).toString("base64url"); }

export function passwordCheck(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    throw new Error("Use a vault password between 12 and 1024 characters.");
  }
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  passwordCheck(password);
  return new Promise((resolve, reject) => scrypt(password, salt, 32,
    { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
}

function encode(value: unknown, key: Buffer, salt: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(FORMAT));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const envelope = JSON.stringify({ format: FORMAT, salt: salt.toString("hex"), iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"), data: data.toString("base64") });
  if (Buffer.byteLength(envelope) > MAX_FILE_BYTES) throw new Error("Encrypted state exceeds the app file limit.");
  return envelope;
}

async function decode(raw: string, password: string) {
  if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new Error("Backup file is too large.");
  let key: Buffer | undefined;
  try {
    const e = JSON.parse(raw) as Envelope;
    if (e.format !== FORMAT || !/^[a-f0-9]{32}$/.test(e.salt) ||
        !/^[a-f0-9]{24}$/.test(e.iv) || !/^[a-f0-9]{32}$/.test(e.tag) || typeof e.data !== "string") {
      throw new Error("Invalid envelope");
    }
    const salt = Buffer.from(e.salt, "hex");
    key = await derive(password, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "hex"));
    decipher.setAAD(Buffer.from(FORMAT));
    decipher.setAuthTag(Buffer.from(e.tag, "hex"));
    const value: unknown = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(e.data, "base64")), decipher.final(),
    ]).toString("utf8"));
    return { value, key, salt };
  } catch {
    key?.fill(0);
    throw new Error("Incorrect password or damaged encrypted file.");
  }
}

export async function encryptBackup(value: unknown, password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  try { return encode(value, key, salt); } finally { key.fill(0); }
}

export async function decryptBackup(raw: string, password: string): Promise<unknown> {
  const result = await decode(raw, password);
  try { return result.value; } finally { result.key.fill(0); }
}

// Persist before broadcast. Old ciphertext is retained; neither crash recovery
// nor backup rotation writes a plaintext seed or transaction bundle to disk.
export async function durableWrite(filename: string, content: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try { await copyFile(filename, `${filename}.previous`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temp = `${filename}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, filename);
    // POSIX rename durability also requires syncing the containing directory.
    // Windows does not expose directory fsync through Node's filesystem API.
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(filename), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    try { await unlink(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function readLimited(filename: string): Promise<string> {
  const handle = await open(filename, "r");
  try {
    if ((await handle.stat()).size > MAX_FILE_BYTES) throw new Error("Backup file is too large.");
    const raw = await handle.readFile("utf8");
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new Error("Backup file is too large.");
    return raw;
  } finally { await handle.close(); }
}

export class Vault {
  private key?: Buffer;
  private salt?: Buffer;
  constructor(readonly filename: string) {}
  async exists(): Promise<boolean> {
    try { await readFile(this.filename); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async create(value: unknown, password: string): Promise<void> {
    if (await this.exists()) throw new Error("A vault already exists. Unlock it instead.");
    this.salt = randomBytes(16);
    this.key = await derive(password, this.salt);
    try { await this.save(value); } catch (error) { this.lock(); throw error; }
  }
  async unlock(password: string): Promise<unknown> {
    this.lock();
    const result = await decode(await readLimited(this.filename), password);
    this.key = result.key;
    this.salt = result.salt;
    return result.value;
  }
  async save(value: unknown): Promise<void> {
    if (!this.key || !this.salt) throw new Error("Unlock the vault first.");
    await durableWrite(this.filename, encode(value, this.key, this.salt));
  }
  async reset(): Promise<void> {
    this.lock();
    const directory = path.dirname(this.filename), base = path.basename(this.filename);
    const names = await readdir(directory);
    // Only our rotation and exact durableWrite crash files, never exports or directories.
    const copies = names.filter((name) => name === `${base}.previous` ||
      (name.startsWith(`${base}.`) && /^[a-f0-9]{16}\.tmp$/.test(name.slice(base.length + 1))));
    for (const name of copies) await unlink(path.join(directory, name));
    // Keep the primary vault until all older ciphertext has been removed.
    if (names.includes(base)) await unlink(this.filename);
  }
  lock(): void { this.key?.fill(0); this.key = undefined; this.salt = undefined; }
}
