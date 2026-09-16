import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopService } from "../../desktop/service.ts";
import { RecoveryEngine } from "../../desktop/engine.ts";
import { Vault } from "../../desktop/vault.ts";
import { bundle, recovery, SEED, PASSWORD } from "./helpers.ts";

async function fixture() {
  const vault = new Vault(path.join(await mkdtemp(path.join(os.tmpdir(), "freshness-test-")), "vault.json"));
  const exporter = vi.fn(async () => bundle());
  const engine = new RecoveryEngine(undefined, exporter), service = new DesktopService(vault, engine);
  await service.initialize(); await service.create(SEED, PASSWORD, JSON.stringify(bundle()));
  return { vault, exporter, engine, service };
}
describe("persisted bundle freshness", () => {
  it("invalidates results on durable changes and clears on lock or restart", async () => {
    const f = await fixture();
    for (const change of [
      () => f.service.importBundle(JSON.stringify(bundle()), ""),
      () => f.service.configure(f.service.view().settings!),
      () => f.service.configureBitcoin(),
      async () => { vi.spyOn(f.engine, "refresh").mockResolvedValueOnce(bundle()); await f.service.refresh(); },
    ]) {
      await f.service.checkBundle(); expect(f.service.view().bundleFreshness?.status).toBe("match");
      await change(); expect(f.service.view().bundleFreshness).toBeUndefined();
    }
    await f.service.checkBundle();
    const id = f.service.view().activeProfileId!;
    await f.service.addProfile("01".repeat(64), { label: "Second test seed", network: "LOCAL" });
    expect(f.service.view().bundleFreshness).toBeUndefined();
    await f.service.selectProfile(id);
    await f.service.checkBundle(); f.service.lock(); await f.service.unlock(PASSWORD);
    expect(f.service.view().bundleFreshness).toBeUndefined();
    await f.service.checkBundle(); const restarted = new DesktopService(new Vault(f.vault.filename));
    await restarted.initialize(); await restarted.unlock(PASSWORD); expect(restarted.view().bundleFreshness).toBeUndefined();
  });
  it("serializes checks, hides superseded results and honors a pending lock", async () => {
    const f = await fixture(); await f.service.checkBundle();
    let release!: (b: ReturnType<typeof bundle>) => void;
    f.exporter.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = f.service.checkBundle();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(f.service.view().bundleFreshness).toBeUndefined();
    await expect(f.service.checkBundle()).rejects.toThrow("still running");
    await expect(f.service.selectProfile(f.service.view().activeProfileId!)).rejects.toThrow("still running");
    await f.service.tick(); f.service.lock(); release(bundle()); await pending;
    expect(f.service.view().unlocked).toBe(false);
    await expect(f.service.checkBundle()).rejects.toThrow("Unlock");
    await f.service.unlock(PASSWORD); expect(f.service.view().bundleFreshness).toBeUndefined();
  });
  it("refuses checks during an exit session and invalidates on session changes", async () => {
    const f = await fixture(); await f.service.checkBundle();
    vi.spyOn(f.engine, "prepare").mockResolvedValueOnce(recovery());
    await f.service.prepare("leaf", "bcrt1test", 2);
    expect(f.service.view().bundleFreshness).toBeUndefined();
    await expect(f.service.checkBundle()).rejects.toThrow("Finish");
    await f.service.finish(); await f.service.checkBundle(); expect(f.service.view().bundleFreshness?.status).toBe("match");
  });
  it("rejects changed persisted profile identity and disk changes during a check", async () => {
    const f = await fixture(), original = await f.vault.inspect() as any;
    for (const field of ["seed", "accountNumber", "network", "coordinatorUrl"]) {
      const changed = structuredClone(original), wallet = changed.profiles[0].wallet;
      delete wallet.bundle;
      if (field === "seed") wallet.seed = "01".repeat(64);
      else wallet.settings[field] = { accountNumber: 0, network: "MAINNET", coordinatorUrl: "https://localhost:9999" }[field];
      await f.vault.save(changed); await f.service.checkBundle();
      expect(f.service.view().bundleFreshness).toMatchObject({ status: "invalid", message: expect.stringContaining("profile") });
    }
    expect(f.exporter).not.toHaveBeenCalled();
    await f.vault.save(original);
    f.exporter.mockImplementationOnce(async () => {
      await f.vault.save({ ...original, profiles: [] }); return bundle();
    });
    await f.service.checkBundle();
    expect(f.service.view().bundleFreshness).toMatchObject({ status: "unknown", message: expect.stringContaining("changed") });
  });
  it("drops prior freshness when a refresh could have changed operator leaves but failed to save", async () => {
    const f = await fixture(); await f.service.checkBundle();
    vi.spyOn(f.engine, "refresh").mockRejectedValueOnce(new Error("consolidated but export failed"));
    await expect(f.service.refresh(undefined, "exit")).rejects.toThrow("consolidated");
    expect(f.service.view().bundleFreshness).toBeUndefined();
  });
  it.each(["iv", "tag", "salt"])("rejects a valid %s hex prefix followed by junk before querying coordinators", async (field) => {
    const f = await fixture(), before = await readFile(f.vault.filename, "utf8");
    const persisted = await f.vault.inspect();
    const envelope = JSON.parse(before); envelope[field] += "junk";
    const malformed = JSON.stringify(envelope);
    await writeFile(f.vault.filename, malformed);
    await expect(new Vault(f.vault.filename).unlock(PASSWORD)).rejects.toThrow("damaged");
    await f.service.checkBundle();
    expect(f.service.view().bundleFreshness).toMatchObject({ status: "invalid", message: expect.stringContaining("read") });
    expect(f.exporter).not.toHaveBeenCalled();
    expect(await readFile(f.vault.filename, "utf8")).toBe(malformed);

    await writeFile(f.vault.filename, before);
    expect(await f.vault.inspect()).toEqual(persisted);
    f.service.lock(); await f.service.unlock(PASSWORD);
    await f.service.checkBundle();
    expect(f.service.view().bundleFreshness?.status).toBe("match");
    expect(f.exporter).toHaveBeenCalledTimes(2);
    expect(await readFile(f.vault.filename, "utf8")).toBe(before);
  });
  it("checks the disk copy without writing state or creating an exit", async () => {
    const f = await fixture(), before = await readFile(f.vault.filename, "utf8");
    await f.service.checkBundle();
    expect(f.service.view().bundleFreshness).toMatchObject({ status: "match", savedLeaves: 1 });
    expect(f.service.view().session).toBeUndefined();
    expect(await readFile(f.vault.filename, "utf8")).toBe(before);
    const persisted = await f.vault.inspect() as any;
    persisted.profiles[0].wallet.bundle = undefined;
    await f.vault.save(persisted);
    await f.service.checkBundle();
    expect(f.service.view().bundleFreshness?.status).toBe("invalid");
    expect(f.exporter).toHaveBeenCalledTimes(2);
    expect(f.service.view().bundle?.leaves).toHaveLength(1);
    await writeFile(f.vault.filename, "broken"); await f.service.checkBundle();
    expect(f.service.view().bundleFreshness).toMatchObject({ status: "invalid", message: expect.stringContaining("read") });
  });
});
