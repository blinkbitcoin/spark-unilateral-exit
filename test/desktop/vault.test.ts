import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Vault, encryptBackup, decryptBackup, passwordCheck, readLimited, durableWrite, MAX_FILE_BYTES, generatePassword } from "../../desktop/vault.ts";
import { PASSWORD, SEED } from "./helpers.ts";
const dir = () => mkdtemp(path.join(os.tmpdir(), "spark-desktop-vault-test-"));
describe("encrypted desktop vault", () => {
  it("resets only vault ciphertext, rotation and exact crash temp files", async () => {
    const root = await dir(), file = path.join(root, "vault.json");
    const vault = new Vault(file); await vault.create({ seed: SEED }, PASSWORD); await vault.save({ seed: SEED });
    const temp = file + ".0123456789abcdef.tmp";
    await writeFile(temp, "ciphertext"); await writeFile(file + ".notes.tmp", "keep");
    await writeFile(path.join(root, "export.json"), "external backup");
    await vault.reset();
    for (const name of [file, file + ".previous", temp]) await expect(stat(name)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(file + ".notes.tmp", "utf8")).toBe("keep");
    expect(await readFile(path.join(root, "export.json"), "utf8")).toBe("external backup");
    await expect(vault.save({})).rejects.toThrow("Unlock");
    await vault.reset();
    await mkdir(file + ".previous"); await writeFile(file, "retain on error");
    await expect(vault.reset()).rejects.toThrow(); expect(await readFile(file, "utf8")).toBe("retain on error");
  });
  it("generates a fresh password accepted by vault encryption", async () => {
    const password = generatePassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/); expect(generatePassword()).not.toBe(password);
    const raw = await encryptBackup({ value: "test" }, password);
    expect(await decryptBackup(raw, password)).toEqual({ value: "test" });
  });
  it("creates, locks, reopens and preserves previous ciphertext", async () => {
    const file = path.join(await dir(), "nested", "vault.json");
    const vault = new Vault(file);
    expect(await vault.exists()).toBe(false);
    await expect(vault.save({})).rejects.toThrow("Unlock");
    await vault.create({ seed: SEED }, PASSWORD);
    expect(await vault.exists()).toBe(true);
    const first = await readLimited(file);
    expect(first).not.toContain(SEED);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(vault.create({}, PASSWORD)).rejects.toThrow("already exists");
    await vault.save({ seed: SEED, phase: "signed" });
    await expect(vault.save({ oversized: "x".repeat(MAX_FILE_BYTES) })).rejects.toThrow("file limit");
    expect(await readFile(file + ".previous", "utf8")).toBe(first);
    vault.lock();
    await expect(vault.save({})).rejects.toThrow("Unlock");
    const reopened = new Vault(file);
    await expect(reopened.unlock("wrong password value")).rejects.toThrow("Incorrect password");
    expect(await reopened.unlock(PASSWORD)).toEqual({ seed: SEED, phase: "signed" });
  });
  it("authenticates export contents and uses fresh randomness", async () => {
    const a = await encryptBackup({ leaves: [1] }, PASSWORD);
    const b = await encryptBackup({ leaves: [1] }, PASSWORD);
    expect(a).not.toBe(b);
    expect(await decryptBackup(a, PASSWORD)).toEqual({ leaves: [1] });
    for (const field of ["salt", "iv", "tag", "data", "format"]) {
      const changed = JSON.parse(a); changed[field] = "broken";
      await expect(decryptBackup(JSON.stringify(changed), PASSWORD)).rejects.toThrow();
    }
    const changed = JSON.parse(a); changed.tag = "00".repeat(16);
    await expect(decryptBackup(JSON.stringify(changed), PASSWORD)).rejects.toThrow();
    await expect(decryptBackup("not json", PASSWORD)).rejects.toThrow();
    await expect(decryptBackup("x".repeat(MAX_FILE_BYTES + 1), PASSWORD)).rejects.toThrow("large");
  });
  it("rejects weak passwords, large files, and failed filesystem operations", async () => {
    for (const value of [null, "short", "x".repeat(1025)]) expect(() => passwordCheck(value)).toThrow();
    const root = await dir();
    const large = path.join(root, "large"); await writeFile(large, Buffer.alloc(MAX_FILE_BYTES + 1));
    await expect(readLimited(large)).rejects.toThrow("large");
    const directory = path.join(root, "directory"); await mkdir(directory);
    await expect(new Vault(directory).exists()).rejects.toThrow();
    await expect(durableWrite(directory, "test")).rejects.toThrow();
    const parentFile = path.join(root, "file"); await writeFile(parentFile, "x");
    const failed = new Vault(path.join(parentFile, "vault"));
    await expect(failed.create({}, PASSWORD)).rejects.toThrow();
  });
});
