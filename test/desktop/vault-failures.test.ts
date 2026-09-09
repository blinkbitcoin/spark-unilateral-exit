import { afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ open: vi.fn(), mkdir: vi.fn(), copyFile: vi.fn(), rename: vi.fn(), unlink: vi.fn(), scrypt: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), ...h }));
vi.mock("node:crypto", async (original) => ({ ...await original<typeof import("node:crypto")>(), scrypt: h.scrypt }));
import { durableWrite, encryptBackup, readLimited, MAX_FILE_BYTES, Vault } from "../../desktop/vault.ts";
async function withPlatform(platform: string, work: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try { await work(); } finally { Object.defineProperty(process, "platform", original); }
}
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
describe("vault I/O and KDF failure boundaries", () => {
  it("propagates KDF failure and rejects files that grew after stat", async () => {
    h.scrypt.mockImplementation((_p, _s, _n, _o, cb) => cb(new Error("KDF failed")));
    await expect(encryptBackup({}, "a strong test password")).rejects.toThrow("KDF failed");
    const close = vi.fn(); h.open.mockResolvedValue({ stat: async () => ({ size: 1 }), readFile: async () => "x".repeat(MAX_FILE_BYTES + 1), close });
    await expect(readLimited("test")).rejects.toThrow("too large"); expect(close).toHaveBeenCalled();
  });
  it("drops the derived key when initial persistence fails", async () => {
    const key = Buffer.alloc(32, 1); h.scrypt.mockImplementation((_p, _s, _n, _o, cb) => cb(null, key));
    const vault = new Vault("/unused"); vi.spyOn(vault, "exists").mockResolvedValue(false);
    h.mkdir.mockRejectedValueOnce(new Error("disk full"));
    await expect(vault.create({}, "a strong test password")).rejects.toThrow("disk full");
    expect(key.every((n) => n === 0)).toBe(true); await expect(vault.save({})).rejects.toThrow("Unlock");
  });
  it("syncs before rename, removes incomplete files, and closes failed file and directory writes", async () => {
    const order: string[] = [];
    const handle = { writeFile: vi.fn(async () => { order.push("write"); }), sync: vi.fn(async () => { order.push("sync"); }), close: vi.fn() };
    h.open.mockResolvedValue(handle); h.rename.mockImplementation(async () => { order.push("rename"); });
    h.unlink.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
    await withPlatform("linux", () => durableWrite("/tmp/vault-test", "encrypted"));
    expect(order.slice(0, 3)).toEqual(["write", "sync", "rename"]);
    handle.writeFile.mockRejectedValueOnce(new Error("write failed"));
    await expect(durableWrite("/tmp/vault-test", "encrypted")).rejects.toThrow("write failed");
    expect(handle.close).toHaveBeenCalled(); expect(h.unlink).toHaveBeenCalledTimes(2);
    h.unlink.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(durableWrite("/tmp/vault-test", "encrypted")).rejects.toThrow("cleanup failed");
    await withPlatform("win32", () => durableWrite("/tmp/vault-test", "encrypted"));
  });
});
