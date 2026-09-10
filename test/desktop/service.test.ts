import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DesktopService } from "../../desktop/service.ts";
import { Vault, decryptBackup } from "../../desktop/vault.ts";
import { RecoveryEngine } from "../../desktop/engine.ts";
import { DEFAULT_SETTINGS } from "../../desktop/contracts.ts";
import { SEED, PASSWORD, bundle, recovery, blinkBackup } from "./helpers.ts";
async function fixture() {
  const vault = new Vault(path.join(await mkdtemp(path.join(os.tmpdir(), "spark-desktop-service-")), "vault.json"));
  const engine = { fundingKey: new RecoveryEngine().fundingKey, refresh: vi.fn(async () => bundle()),
    estimate: vi.fn(async () => ({ address: "bcrt1fee", requiredSats: "2000", feeSats: "1000", netSats: "98000", economical: true })),
    prepare: vi.fn(async () => recovery()),
    approve: vi.fn((state) => { state.session.approved = true; state.session.status = "running"; }),
    advance: vi.fn(async (s, _settings?: unknown) => { s.status = "complete"; }) };
  let now = 100000;
  const service = new DesktopService(vault, engine, () => now);
  await service.initialize();
  return { service, engine, vault, setTime: (n: number) => { now = n; }, create: () => service.create(SEED, PASSWORD) };
}
describe("desktop recovery lifecycle", () => {
  it("isolates two seeds and mainnet settings under one durable encrypted vault password", async () => {
    const f = await fixture(); await f.create(); await f.service.refresh();
    const first = f.service.view().activeProfileId!;
    const secondSeed = "01".repeat(64);
    await f.service.addProfile(secondSeed, { label: "Second", network: "LOCAL" }, JSON.stringify(bundle(1, secondSeed)));
    const second = f.service.view().activeProfileId!;
    expect(second).not.toBe(first); expect(f.service.view().profiles).toHaveLength(2);
    await expect(f.service.importBundle(JSON.stringify(bundle()), "")).rejects.toThrow("match");
    await expect(f.service.addProfile(secondSeed, { label: "Duplicate", network: "LOCAL" })).rejects.toThrow("already");
    await expect(f.service.selectProfile("missing")).rejects.toThrow("not found");
    await expect(f.service.refresh("missing")).rejects.toThrow("not found");
    await f.service.selectProfile(first); await f.service.prepare("leaf", "bcrt1test", 2);
    await expect(f.service.configure(DEFAULT_SETTINGS)).rejects.toThrow("Finish");
    await f.service.selectProfile(second); expect(f.service.view().session).toBeUndefined();
    await f.service.addProfile(SEED, { label: "Mainnet", network: "MAINNET" });
    const main = f.service.view().activeProfileId!;
    expect(f.service.view().fundingAddress).toMatch(/^bc1/);
    expect(f.service.view().bitcoinRpc).toBeUndefined();
    const settings = { ...f.service.view().settings!, bitcoinRpc: { url: "http://localhost:8332", username: "user", password: "rpc secret" } };
    await f.service.configureBitcoin(settings.bitcoinRpc);
    await expect(f.service.configure(settings)).rejects.toThrow("shared Bitcoin");
    await f.service.estimate("leaf", 2);
    await f.service.configureBitcoin({ ...settings.bitcoinRpc, password: "" });
    expect(f.service.view()).toMatchObject({ hasRpcPassword: true, bitcoinRpc: { username: "user" } });
    expect(JSON.stringify(f.service.view())).not.toContain("rpc secret");
    expect(JSON.stringify(f.service.view())).not.toContain(secondSeed);
    await expect(f.service.configure({ ...settings, network: "LOCAL" })).rejects.toThrow("network is fixed");
    const encrypted = await readFile(f.vault.filename, "utf8");
    expect(encrypted).not.toContain(secondSeed); expect(encrypted).not.toContain("rpc secret");
    f.service.lock(); await expect(f.service.unlock("wrong password")).rejects.toThrow();
    await f.service.unlock(PASSWORD); expect(f.service.view().activeProfileId).toBe(main);
    expect(f.service.view().profiles).toHaveLength(3);
    await f.service.configureBitcoin();
    expect(f.service.view().bitcoinRpc).toBeUndefined();
    await f.service.configureBitcoin({ ...settings.bitcoinRpc, password: "" });
    expect(f.service.view().hasRpcPassword).toBe(false);
    await f.service.selectProfile(first); expect(f.service.view().session?.status).toBe("review");
    await f.service.approve("review-1"); await f.service.advance(); await f.service.finish();
    await f.service.selectProfile(second); expect(f.service.view().bundle?.leaves).toHaveLength(1);
    f.service.lock(); await f.service.unlock(PASSWORD);
    await f.service.selectProfile(first); expect(f.service.view().bundle?.leaves).toHaveLength(0);
  });
  it("refreshes every seed independently, continues after one failure and stops the batch on lock", async () => {
    const f = await fixture(); await f.create();
    await f.service.addProfile("01".repeat(64), { label: "Second", network: "LOCAL" });
    f.engine.refresh.mockImplementation(async (...args: any[]) => bundle(1, args[0].seed));
    f.service.setKeepUnlocked(true); f.service.setAutoRefresh(true);
    f.engine.refresh.mockRejectedValueOnce(new Error("first offline"));
    await f.service.tick(); expect(f.engine.refresh).toHaveBeenCalledTimes(2);
    expect(f.service.view().message).toContain("failed for Seed 1");
    expect(f.service.view().bundle?.sats).toBe("100000");
    await f.service.tick(); expect(f.engine.refresh).toHaveBeenCalledTimes(2);
    f.setTime(3700000); await f.service.tick(); expect(f.engine.refresh).toHaveBeenCalledTimes(4);
    f.engine.refresh.mockImplementationOnce(async () => { f.service.lock(); return bundle(); });
    f.setTime(7300000); await f.service.tick();
    expect(f.engine.refresh).toHaveBeenCalledTimes(5); expect(f.service.view().unlocked).toBe(false);
  });
  it("advances both profiles with one shared mainnet node while keeping regtest separate", async () => {
    const f = await fixture(); await f.create(); await f.service.prepare("leaf", "bcrt1test", 2); await f.service.approve("review-1");
    const first = f.service.view().activeProfileId!;
    const secondSeed = "01".repeat(64);
    await f.service.addProfile(secondSeed, { label: "Main", network: "MAINNET" });
    const main = f.service.view().activeProfileId!;
    f.engine.prepare.mockResolvedValueOnce({ ...recovery(), bundle: bundle(1, secondSeed, "MAINNET") });
    await f.service.prepare("leaf", "bc1test", 2); await f.service.approve("review-1");
    const rpc = { url: "http://localhost:8332", username: "user", password: "secret" };
    await f.service.configureBitcoin(rpc);
    f.engine.advance.mockRejectedValueOnce(new Error("regtest offline"));
    await f.service.tick(); expect(f.engine.advance).toHaveBeenCalledTimes(2);
    expect(f.engine.advance.mock.calls[0]![1]).toMatchObject({ network: "LOCAL", bitcoinRpc: undefined });
    expect(f.engine.advance.mock.calls[1]![1]).toMatchObject({ network: "MAINNET", bitcoinRpc: rpc });
    expect(f.service.view().session?.status).toBe("complete");
    await f.service.selectProfile(first); expect(f.service.view().bitcoinRpc?.url).toBe(rpc.url);
    await f.service.configureBitcoin(); await f.service.selectProfile(main); expect(f.service.view().bitcoinRpc).toBeUndefined();
  });
  it("checks auto-lock between seeds when a refresh batch crosses the unlock deadline", async () => {
    const f = await fixture(); await f.create();
    await f.service.addProfile("01".repeat(64), { label: "Second", network: "LOCAL" });
    f.service.setAutoRefresh(true);
    f.engine.refresh.mockImplementationOnce(async () => { f.setTime(1000000); return bundle(); });
    await f.service.tick(); expect(f.engine.refresh).toHaveBeenCalledTimes(1);
    expect(f.service.view().unlocked).toBe(false);
  });
  it("does not publish a failed profile append, selection or legacy migration", async () => {
    const f = await fixture(); await f.create(); const first = f.service.view().activeProfileId;
    vi.spyOn(f.vault, "save").mockRejectedValueOnce(new Error("disk full"));
    await expect(f.service.addProfile("01".repeat(64), { label: "Second", network: "LOCAL" })).rejects.toThrow("disk full");
    expect(f.service.view().profiles).toHaveLength(1); expect(f.service.view().activeProfileId).toBe(first);
    await f.service.addProfile("01".repeat(64), { label: "Second", network: "LOCAL" });
    const second = f.service.view().activeProfileId;
    vi.spyOn(f.vault, "save").mockRejectedValueOnce(new Error("disk full"));
    await expect(f.service.selectProfile(first!)).rejects.toThrow("disk full"); expect(f.service.view().activeProfileId).toBe(second);
    f.service.lock();
    vi.spyOn(f.vault, "unlock").mockResolvedValueOnce({ version: 1, seed: SEED, settings: DEFAULT_SETTINGS, completed: [] });
    vi.spyOn(f.vault, "save").mockRejectedValueOnce(new Error("migration failed"));
    await expect(f.service.unlock(PASSWORD)).rejects.toThrow("migration failed"); expect(f.service.view().unlocked).toBe(false);
    const profiles = Array.from({ length: 50 }, (_, i) => ({ id: String(i), label: String(i), wallet: { version: 1, seed: (i + 1).toString(16).padStart(128, "0"), settings: DEFAULT_SETTINGS, completed: [] } }));
    vi.spyOn(f.vault, "unlock").mockResolvedValueOnce({ version: 2, activeProfileId: "0", profiles });
    await f.service.unlock(PASSWORD);
    await expect(f.service.addProfile(SEED, { label: "Overflow", network: "LOCAL" })).rejects.toThrow("50");
  });
  it("creates from existing CLI or Blink bundles, matching the account before saving", async () => {
    for (const account of [0, 1]) {
      const f = await fixture(); const value = bundle(account);
      await f.service.create(SEED, PASSWORD, JSON.stringify(value));
      expect(f.service.view().settings?.accountNumber).toBe(account);
      expect(f.service.view().bundle?.sats).toBe("100000");
      const stored = await decryptBackup(await readFile(f.vault.filename, "utf8"), PASSWORD) as any;
      expect(stored.profiles[0].wallet.settings.accountNumber).toBe(account);
      await expect(f.service.importBundle(JSON.stringify(bundle(1 - account)), "")).rejects.toThrow("match");
      expect(f.service.view().settings?.accountNumber).toBe(account);
    }
    const f = await fixture(); const value = { ...bundle(0), network: "REGTEST" };
    await f.service.create(SEED, PASSWORD, JSON.stringify(await blinkBackup(value)));
    expect(f.service.view().settings?.accountNumber).toBe(0);
    await f.service.importBundle(JSON.stringify(await blinkBackup(value)), "");
    expect(f.service.view().bundle?.sats).toBe("100000");
  });
  it("does not create a vault for a mismatched seed, unsupported account or mainnet bundle", async () => {
    const f = await fixture();
    await expect(f.service.create("01".repeat(64), PASSWORD, JSON.stringify(bundle()))).rejects.toThrow("does not match");
    await expect(f.service.create(SEED, PASSWORD, JSON.stringify(bundle(2)))).rejects.toThrow("does not match");
    await expect(f.service.create(SEED, PASSWORD, JSON.stringify({ ...bundle(), network: "MAINNET" }))).rejects.toThrow("regtest");
    expect(await f.vault.exists()).toBe(false);
    expect(f.service.view()).toMatchObject({ exists: false, unlocked: false });
  });
  it("retains a non-default account in an existing vault", async () => {
    const f = await fixture();
    await f.vault.create({ version: 1, seed: SEED, settings: { ...DEFAULT_SETTINGS, accountNumber: 0 }, completed: [] }, PASSWORD);
    f.vault.lock(); await f.service.initialize(); await f.service.unlock(PASSWORD);
    expect(f.service.view().settings?.accountNumber).toBe(0);
  });
  it("refreshes hourly for days in keep-unlocked mode and catches up after sleep", async () => {
    const f = await fixture(); await f.create();
    expect(() => f.service.setKeepUnlocked("yes" as any)).toThrow("Invalid unlock");
    f.service.setKeepUnlocked(true); f.service.setAutoRefresh(true);
    await f.service.tick(); expect(f.engine.refresh).toHaveBeenCalledTimes(1);
    for (let hour = 1; hour <= 72; hour++) {
      f.setTime(100000 + hour * 3600000 - 1); await f.service.tick();
      expect(f.engine.refresh).toHaveBeenCalledTimes(hour);
      f.service.screenLocked();
      f.setTime(100000 + hour * 3600000); await f.service.tick();
      expect(f.engine.refresh).toHaveBeenCalledTimes(hour + 1);
    }
    expect(f.service.view()).toMatchObject({ unlocked: true, keepUnlocked: true });
    // Standby does not run ticks. Wake after a long gap performs one due refresh.
    f.setTime(100000 + 96 * 3600000); f.engine.refresh.mockRejectedValueOnce(new Error("offline on wake"));
    await f.service.tick(); expect(f.service.view().message).toContain("failed");
    expect(f.service.view().bundle?.sats).toBe("100000");
    await f.service.tick(); expect(f.engine.refresh).toHaveBeenCalledTimes(74);
    f.setTime(100000 + 97 * 3600000); await f.service.tick();
    expect(f.engine.refresh).toHaveBeenCalledTimes(75);
    const stored = await decryptBackup(await readFile(f.vault.filename, "utf8"), PASSWORD) as any;
    expect(stored.profiles[0].wallet.bundle).toMatchObject({ schema: "spark.unilateral-exit-bundle.v1" });
    expect(stored.keepUnlocked).toBeUndefined();
    const restarted = new DesktopService(new Vault(f.vault.filename), f.engine);
    await restarted.initialize(); expect(restarted.view()).toMatchObject({ unlocked: false, keepUnlocked: false, autoRefresh: false });
    await restarted.unlock(PASSWORD); expect(restarted.view().keepUnlocked).toBe(false);
    f.service.setKeepUnlocked(false); await f.service.tick(); expect(f.service.view().unlocked).toBe(true);
    f.setTime(100000 + 97 * 3600000 + 60000); await f.service.tick();
    expect(f.engine.refresh).toHaveBeenCalledTimes(76);
    f.setTime(100000 + 97 * 3600000 + 15 * 60000); await f.service.tick();
    expect(f.service.view().unlocked).toBe(false);
    expect(() => f.service.setKeepUnlocked(true)).toThrow("Unlock");
  }, 30_000);
  it("honors manual lock during refresh and restores screen locking after opting out", async () => {
    const f = await fixture(); await f.create(); f.service.setKeepUnlocked(true);
    let release!: () => void;
    f.engine.refresh.mockImplementationOnce(async () => { await new Promise<void>((r) => { release = r; }); return bundle(); });
    const pending = f.service.refresh(); f.service.lock();
    expect(f.service.view().keepUnlocked).toBe(false);
    expect(() => f.service.setKeepUnlocked(true)).toThrow("locking");
    release(); await pending; expect(f.service.view().unlocked).toBe(false);
    await f.service.unlock(PASSWORD); f.service.setKeepUnlocked(true); f.service.setKeepUnlocked(false);
    f.service.screenLocked(); expect(f.service.view().unlocked).toBe(false);
  });
  it("rejects malformed seed input and stored state without leaving keys unlocked", async () => {
    const f = await fixture();
    for (const seed of [null, "x".repeat(2049)]) {
      await expect(f.service.create(seed as string, PASSWORD)).rejects.toThrow("Invalid seed");
    }
    for (const value of [{ version: 2 }, { version: 1, completed: null }, { version: 1, completed: [], seed: "bad" }]) {
      vi.spyOn(f.vault, "unlock").mockResolvedValueOnce(value);
      await expect(f.service.unlock(PASSWORD)).rejects.toThrow();
      await expect(f.vault.save({})).rejects.toThrow("Unlock");
    }
    await f.create(); f.service.lock(); await f.service.unlock(PASSWORD);
    expect(() => f.service.setAutoRefresh("yes" as any)).toThrow("Invalid refresh");
    await expect(f.service.approve("none")).rejects.toThrow("current");
    await expect(f.service.advance()).rejects.toThrow("no active");
    f.service.setAutoRefresh(false); await f.service.tick();
    let release!: () => void;
    f.engine.refresh.mockImplementationOnce(async () => { await new Promise<void>((r) => { release = r; }); return bundle(); });
    const pending = f.service.refresh(); await f.service.tick(); release(); await pending;
  });
  it("keeps secrets out of status, refreshes, exports, locks and restores", async () => {
    const f = await fixture();
    expect(f.service.view().exists).toBe(false);
    await expect(f.service.refresh()).rejects.toThrow("Unlock");
    await f.create();
    expect(f.service.view().settings?.accountNumber).toBe(1);
    await expect(f.create()).rejects.toThrow("existing");
    await expect(f.service.unlock(PASSWORD)).rejects.toThrow("already unlocked");
    await expect(f.service.exportBundle(PASSWORD)).rejects.toThrow("no recovery bundle");
    await f.service.refresh();
    expect(JSON.stringify(f.service.view())).not.toContain(SEED);
    expect(f.service.view().bundle?.sats).toBe("100000");
    const encrypted = await f.service.exportBundle(PASSWORD);
    expect(await decryptBackup(encrypted, PASSWORD)).toMatchObject({ schema: "spark.unilateral-exit-bundle.v1" });
    const plaintext = await f.service.exportBundle("");
    expect(JSON.parse(plaintext)).toMatchObject({ schema: "spark.unilateral-exit-bundle.v1" });
    f.service.lock(); expect(f.service.view().identity).toBeUndefined();
    await f.service.unlock(PASSWORD);
    await f.service.importBundle(encrypted, PASSWORD);
    await f.service.importBundle(JSON.stringify(bundle()), "");
    expect(f.service.view().unlocked).toBe(true);
    await f.service.configure({ ...DEFAULT_SETTINGS, coordinatorUrl: "https://127.0.0.1:8535" });
    await expect(f.service.configure({ ...DEFAULT_SETTINGS, accountNumber: 0 })).rejects.toThrow("fixed");
    await f.service.estimate("leaf", 2);
    expect(f.engine.estimate).toHaveBeenCalled();
  });
  it("downloads standard or consolidated bundles and tracks operator reachability", async () => {
    const f = await fixture(); await f.create();
    expect(f.service.view().coordinatorOnline).toBe(false);
    await expect(f.service.refresh(undefined, "sideways")).rejects.toThrow("download mode");
    expect(f.service.view().coordinatorOnline).toBe(false);
    await f.service.refresh(undefined, "exit");
    expect(f.engine.refresh).toHaveBeenCalledWith(expect.anything(), "exit");
    expect(f.service.view().coordinatorOnline).toBe(true);
    f.engine.refresh.mockRejectedValueOnce(new Error("offline"));
    await expect(f.service.refresh()).rejects.toThrow("offline");
    expect(f.service.view().coordinatorOnline).toBe(false);
  });
  it("persists approval before advancing and resumes after process restart", async () => {
    const f = await fixture(); await f.create(); await f.service.refresh();
    await f.service.prepare("leaf", "bcrt1test", 2);
    await expect(f.service.prepare("leaf", "bcrt1test", 2)).rejects.toThrow("exists");
    await expect(f.service.importBundle(JSON.stringify(bundle()), "")).rejects.toThrow("Finish");
    await expect(f.service.refresh()).rejects.toThrow("paused");
    await expect(f.service.approve("wrong")).rejects.toThrow("current");
    await expect(f.service.advance()).rejects.toThrow("no active");
    await f.service.approve("review-1");
    expect(f.engine.advance).not.toHaveBeenCalled();
    const ciphertext = await readFile(f.vault.filename, "utf8");
    expect((await decryptBackup(ciphertext, PASSWORD) as any).profiles[0].wallet.session.approved).toBe(true);
    await expect(f.service.approve("review-1")).rejects.toThrow("current");
    await expect(f.service.finish()).rejects.toThrow("cannot be discarded");
    f.service.lock();
    const restarted = new DesktopService(new Vault(f.vault.filename), f.engine);
    await restarted.initialize(); await restarted.unlock(PASSWORD); await restarted.advance();
    expect(restarted.view().session?.status).toBe("complete");
    await restarted.finish(); expect(restarted.view().bundle?.leaves).toHaveLength(0);
    await expect(restarted.finish()).rejects.toThrow();
  });
  it("serializes operations, defers requested lock and retains prior state on refresh failure", async () => {
    const f = await fixture(); await f.create(); await f.service.refresh();
    let release!: () => void;
    f.engine.refresh.mockImplementationOnce(async () => { await new Promise<void>((r) => { release = r; }); return bundle(); });
    const pending = f.service.refresh();
    await expect(f.service.refresh()).rejects.toThrow("still running");
    f.service.lock(); expect(f.service.view().unlocked).toBe(true);
    release(); await pending; expect(f.service.view().unlocked).toBe(false);
    await f.service.unlock(PASSWORD);
    f.engine.refresh.mockRejectedValueOnce(new Error("offline"));
    await expect(f.service.refresh()).rejects.toThrow("offline");
    expect(f.service.view().bundle?.sats).toBe("100000");
    const save = vi.spyOn(f.vault, "save").mockRejectedValueOnce(new Error("disk full"));
    await expect(f.service.prepare("leaf", "bcrt1test", 2)).rejects.toThrow("disk full");
    expect(f.service.view().session).toBeUndefined(); save.mockRestore();
  });
  it("never advances an approval that failed to reach the encrypted vault", async () => {
    const f = await fixture(); await f.create(); await f.service.refresh();
    await f.service.prepare("leaf", "bcrt1test", 2);
    vi.spyOn(f.vault, "save").mockRejectedValueOnce(new Error("disk full"));
    await expect(f.service.approve("review-1")).rejects.toThrow("disk full");
    expect(f.service.view().session).toMatchObject({ approved: false, status: "review" });
    await f.service.tick(); expect(f.engine.advance).not.toHaveBeenCalled();
    const stored = await decryptBackup(await readFile(f.vault.filename, "utf8"), PASSWORD) as any;
    expect(stored.profiles[0].wallet.session).toMatchObject({ approved: false, status: "review" });
    await f.service.approve("review-1"); await f.service.tick();
    expect(f.engine.advance).toHaveBeenCalledTimes(1);
  });
  it("runs background work only unlocked and pauses after the unlock window", async () => {
    const f = await fixture(); await f.service.tick(); await f.create();
    f.service.setAutoRefresh(true); await f.service.tick();
    expect(f.engine.refresh).toHaveBeenCalledTimes(1);
    await f.service.tick(); expect(f.engine.refresh).toHaveBeenCalledTimes(1);
    f.setTime(200000); f.engine.refresh.mockRejectedValueOnce(new Error("offline")); await f.service.tick();
    expect(f.service.view().message).toContain("failed");
    await f.service.prepare("leaf", "bcrt1test", 2); await f.service.tick(); expect(f.engine.advance).not.toHaveBeenCalled();
    await f.service.finish(); expect(f.service.view().session).toBeUndefined();
    await f.service.prepare("leaf", "bcrt1test", 2); await f.service.approve("review-1"); await f.service.tick();
    expect(f.engine.advance).toHaveBeenCalledTimes(1);
    f.setTime(1000000); await f.service.tick(); expect(f.service.view().unlocked).toBe(false);
  });
});
