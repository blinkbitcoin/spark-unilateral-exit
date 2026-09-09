// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { PublicState } from "../../desktop/contracts.ts";
const html = readFileSync("desktop/index.html", "utf8");
let state: PublicState;
let api: Record<string, ReturnType<typeof vi.fn>>;
const el = (id: string) => document.getElementById(id) as HTMLInputElement;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function event(id: string, name = "click") { el(id).dispatchEvent(new Event(name, { bubbles: true, cancelable: true })); await flush(); }
function unlocked() {
  state.unlocked = true; state.exists = true; state.identity = "identity-public-only";
  state.settings = { accountNumber: 1, coordinatorUrl: "https://localhost:8535", coordinatorCa: "PEM" };
  state.fundingAddress = "bcrt1fund";
  state.settings.network = "LOCAL"; state.activeProfileId = "one"; state.profiles = [{ id: "one", label: "Seed 1", network: "LOCAL" }];
}
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); document.documentElement.innerHTML = html;
  state = { exists: false, unlocked: false, busy: false, autoRefresh: false, keepUnlocked: false, message: "Ready" };
  api = Object.fromEntries(["status", "create", "createFromBundle", "addProfile", "addProfileFromBundle", "selectProfile", "generatePassword", "unlock", "lock", "configure", "configureBitcoin", "refresh", "autoRefresh", "keepUnlocked", "estimate", "prepare", "advance", "finish", "approve", "import", "export"].map((name) => [name, vi.fn(async () => ({ ok: true }))]));
  api.status!.mockImplementation(async () => ({ ok: true, value: state }));
  window.recovery = api as Window["recovery"];
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("desktop user interface", () => {
  it("enables import only after seed entry and a valid new vault password, including generated passwords", async () => {
    let ready!: (value: unknown) => void;
    api.status!.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    await import("../../desktop/renderer.ts");
    await event("seed", "input");
    ready({ ok: true, value: state }); await flush();
    expect(el("vault-import").disabled).toBe(true); expect(el("profile-import").disabled).toBe(true);
    expect(el("import-options").hidden).toBe(true);
    el("password").value = "valid vault password"; await event("password", "input"); expect(el("vault-import").disabled).toBe(true);
    el("seed").value = "seed words"; await event("seed", "input"); expect(el("vault-import").disabled).toBe(false); expect(el("import-options").hidden).toBe(false);
    for (const value of ["", "too short", "x".repeat(1025)]) {
      el("password").value = value; await event("password", "input"); expect(el("vault-import").disabled).toBe(true);
    }
    api.generatePassword!.mockResolvedValueOnce({ ok: true, value: "a generated vault password" });
    await event("generate-password"); expect(el("vault-import").disabled).toBe(false);
    el("seed").value = "  "; await event("seed", "input"); expect(el("vault-import").disabled).toBe(true); expect(el("import-options").hidden).toBe(true);
    el("additional-seed").value = "second seed"; await event("additional-seed", "input"); expect(el("profile-import").disabled).toBe(false);
    let release!: (value: unknown) => void;
    api.refresh!.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await event("refresh"); await event("additional-seed", "input"); expect(el("profile-import").disabled).toBe(true);
    release({ ok: true }); await flush(); expect(el("profile-import").disabled).toBe(false);
    el("additional-seed").value = ""; await event("additional-seed", "input"); expect(el("profile-import").disabled).toBe(true);
  });
  it("adds and switches seed profiles, clears credentials and defaults mainnet to the public explorer", async () => {
    await import("../../desktop/renderer.ts"); await flush();
    el("network").value = "MAINNET"; await event("network", "change"); expect(el("network-badge").textContent).toBe("Mainnet");
    unlocked(); await vi.advanceTimersByTimeAsync(2000);
    await event("profiles-tab"); expect(el("profiles-panel").hidden).toBe(false);
    el("additional-label").value = "Main"; el("additional-network").value = "MAINNET";
    el("additional-seed").value = "second seed"; el("additional-password").value = "import secret";
    api.addProfile!.mockImplementation(async () => {
      state.activeProfileId = "two"; state.profiles!.push({ id: "two", label: "Main", network: "MAINNET" });
      state.settings = { accountNumber: 1, network: "MAINNET", coordinatorUrl: "https://0.spark.lightspark.com", coordinatorCa: "" };
      return { ok: true };
    });
    await event("profile-form", "submit");
    expect(api.addProfile).toHaveBeenCalledWith("second seed", { label: "Main", network: "MAINNET" });
    expect(el("additional-seed").value).toBe(""); expect(el("additional-password").value).toBe("");
    expect(el("destination").placeholder).toBe("bc1…"); expect(el("bitcoin-connection").value).toBe("explorer"); expect(el("rpc-fields").hidden).toBe(true);
    await event("settings-form", "submit"); expect(api.configure).toHaveBeenLastCalledWith(state.settings);
    el("bitcoin-connection").value = "rpc"; await event("bitcoin-connection", "change"); expect(el("rpc-fields").hidden).toBe(false);
    el("rpc-username").value = "user"; el("rpc-password").value = "rpc secret";
    await event("bitcoin-settings-form", "submit"); expect(api.configureBitcoin).toHaveBeenLastCalledWith({ url: "http://127.0.0.1:8332", username: "user", password: "rpc secret" });
    el("bitcoin-connection").value = "explorer"; await event("bitcoin-settings-form", "submit"); expect(api.configureBitcoin).toHaveBeenLastCalledWith(undefined);
    expect(el("rpc-password").value).toBe("");
    el("profile-select").value = "one"; await event("profile-select", "change"); expect(api.selectProfile).toHaveBeenCalledWith("one");
    state.activeProfileId = "one"; state.bitcoinRpc = { url: "http://localhost:8332", username: "saved user" };
    el("destination").value = "old destination"; await vi.advanceTimersByTimeAsync(2000);
    expect(el("destination").value).toBe(""); expect(el("rpc-username").value).toBe("saved user"); expect(el("bitcoin-connection").value).toBe("rpc");
    await event("profiles-tab");
    for (const result of [false, true]) {
      api.addProfileFromBundle!.mockResolvedValueOnce({ ok: true, value: result });
      el("additional-seed").value = "import seed"; el("additional-password").value = "bundle secret";
      el("profile-form").dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: el("profile-import") })); await flush();
      expect(api.addProfileFromBundle).toHaveBeenLastCalledWith("import seed", { label: "Main", network: "MAINNET" }, "bundle secret");
      expect(el("recover-panel").hidden).toBe(!result);
    }
  });
  it("creates and unlocks a vault, clears credentials and renders snapshot changes safely", async () => {
    await import("../../desktop/renderer.ts"); await flush();
    expect(el("workspace").hidden).toBe(true);
    api.generatePassword!.mockResolvedValue({ ok: true, value: "test-random-password" });
    await event("generate-password"); expect(el("password").value).toBe("test-random-password");
    expect(el("password").type).toBe("password");
    await event("show-password"); expect(el("password").type).toBe("text"); expect(el("show-password").textContent).toBe("Hide password");
    await event("show-password"); expect(el("password").type).toBe("password");
    el("seed").value = "test seed"; el("password").value = "vault password";
    api.create!.mockImplementation(async () => { unlocked(); return { ok: true }; });
    await event("vault-form", "submit");
    expect(api.create).toHaveBeenCalledWith("test seed", "vault password", { label: "Seed 1", network: "LOCAL" });
    for (const id of ["seed", "password"]) expect(el(id).value).toBe("");
    expect(el("workspace").hidden).toBe(false); expect(el("backup-summary").textContent).toBe("No recovery bundle yet");
    state.bundle = { createdAt: "2026-09-09", sats: "2000", leaves: [{ id: "<script>danger</script>", sats: 1000 }, { id: "second", sats: 1000 }] };
    await vi.advanceTimersByTimeAsync(2000);
    expect(el("leaf").children).toHaveLength(2); expect(el("leaf").querySelector("script")).toBeNull();
    el("leaf").value = "second"; state.bundle!.leaves[0]!.sats = 900;
    await vi.advanceTimersByTimeAsync(2000); expect(el("leaf").value).toBe("second");
    el("coordinator").value = "https://127.0.0.1:8535"; await event("settings-form", "submit");
    expect(api.configure).toHaveBeenCalledWith({ ...state.settings, coordinatorUrl: "https://127.0.0.1:8535" });
    api.lock!.mockImplementation(async () => { state.unlocked = false; return { ok: true }; }); await event("lock");
    expect(el("create-fields").hidden).toBe(true); expect(el("vault-submit").textContent).toBe("Unlock vault");
    el("password").value = "unlock password"; api.unlock!.mockImplementation(async () => { unlocked(); return { ok: true }; });
    await event("vault-form", "submit"); expect(api.unlock).toHaveBeenCalledWith("unlock password");
  });
  it("creates a vault from a picked bundle and clears every credential", async () => {
    await import("../../desktop/renderer.ts"); await flush();
    el("seed").value = "test seed"; el("password").value = "vault password"; el("import-password").value = "backup password";
    api.createFromBundle!.mockImplementation(async () => { unlocked(); return { ok: true, value: true }; });
    el("vault-form").dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: el("vault-import") }));
    await flush();
    expect(api.createFromBundle).toHaveBeenCalledWith("test seed", "vault password", "backup password", { label: "Seed 1", network: "LOCAL" });
    for (const id of ["seed", "password", "import-password"]) expect(el(id).value).toBe("");
    expect(el("recover-panel").hidden).toBe(false);
    expect(el("vault-import").hidden).toBe(true);
  });
  it("keeps normal setup after canceling the bundle picker", async () => {
    await import("../../desktop/renderer.ts"); await flush();
    api.createFromBundle!.mockResolvedValue({ ok: true, value: false });
    el("vault-form").dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: el("vault-import") }));
    await flush(); expect(el("workspace").hidden).toBe(true);
    api.create!.mockImplementation(async () => { unlocked(); return { ok: true }; });
    await event("vault-form", "submit"); expect(el("backup-panel").hidden).toBe(false);
  });
  it("routes backup and recovery controls, including review, running and completion", async () => {
    unlocked(); state.bundle = { createdAt: "today", sats: "1000", leaves: [{ id: "leaf", sats: 1000 }] };
    await import("../../desktop/renderer.ts"); await flush();
    await event("recover-tab"); expect(el("recover-panel").hidden).toBe(false); expect(el("backup-panel").hidden).toBe(true);
    await event("backup-tab"); expect(el("backup-panel").hidden).toBe(false);
    await event("refresh"); expect(api.refresh).toHaveBeenCalled();
    el("auto-refresh").checked = true; await event("auto-refresh", "change"); expect(api.autoRefresh).toHaveBeenCalledWith(true);
    api.keepUnlocked!.mockImplementation(async (enabled) => { state.keepUnlocked = enabled; return { ok: true }; });
    el("keep-unlocked").checked = true; await event("keep-unlocked", "change");
    expect(api.keepUnlocked).toHaveBeenCalledWith(true);
    expect(el("wallet-identity").textContent).toContain("Kept unlocked");
    expect(el("refresh-frequency").textContent).toContain("hourly");
    for (const name of ["import", "export"]) { el("backup-password").value = "file password"; await event(name); expect(api[name]).toHaveBeenCalledWith("file password"); expect(el("backup-password").value).toBe(""); }
    api.estimate!.mockResolvedValue({ ok: true, value: { requiredSats: "300", netSats: "700" } }); await event("estimate");
    expect(el("estimate-result").textContent).toContain("700 sats");
    api.estimate!.mockResolvedValue({ ok: true, value: { requiredSats: "300" } }); await event("estimate"); expect(el("estimate-result").textContent).toContain("unknown");
    el("destination").value = "bcrt1destination"; await event("recover-form", "submit"); expect(api.prepare).toHaveBeenCalledWith("leaf", "bcrt1destination", 2);
    await event("approve"); expect(api.approve).toHaveBeenCalledWith(undefined);
    state.session = { id: "session", leafId: "leaf", destination: "bcrt1destination", feeRate: 2, feeSats: "300", approved: false, status: "review", message: "Review", sweepTxid: "txid" };
    await vi.advanceTimersByTimeAsync(2000); expect(el("session-title").textContent).toBe("Review unilateral exit"); expect(el("advance").hidden).toBe(true);
    await event("approve"); expect(api.approve).toHaveBeenCalledWith("session");
    state.session.approved = true; state.session.status = "running";
    await vi.advanceTimersByTimeAsync(2000); expect(el("session-title").textContent).toBe("Unilateral exit in progress"); expect(el("finish").hidden).toBe(true);
    await event("advance"); expect(api.advance).toHaveBeenCalled();
    state.session.status = "complete"; await vi.advanceTimersByTimeAsync(2000);
    expect(el("session-title").textContent).toBe("Unilateral exit confirmed"); expect(el("finish").hidden).toBe(false);
    await event("finish"); expect(api.finish).toHaveBeenCalled();
  });
  it("displays errors and serializes user work without background status races", async () => {
    api.status!.mockRejectedValueOnce(new Error("offline")); await import("../../desktop/renderer.ts"); await flush();
    expect(el("feedback").textContent).toContain("Unable to connect");
    await vi.advanceTimersByTimeAsync(2000);
    api.refresh!.mockResolvedValueOnce({ ok: false, error: "Refresh failed" }); await event("refresh"); expect(el("feedback").textContent).toBe("Refresh failed");
    let release!: (v: unknown) => void;
    api.refresh!.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await event("refresh"); const count = api.status!.mock.calls.length;
    expect(el("refresh").disabled).toBe(true); await event("refresh"); await vi.advanceTimersByTimeAsync(2000);
    expect(api.status!.mock.calls).toHaveLength(count); expect(api.refresh).toHaveBeenCalledTimes(2);
    release({ ok: true }); await flush(); expect(el("refresh").disabled).toBe(false);
    api.status!.mockRejectedValueOnce(new Error("offline")); await vi.advanceTimersByTimeAsync(2000);
    expect(el("feedback").textContent).toContain("Restart to resume");
    state.message = "Background operation failed. Saved state is retained.";
    await vi.advanceTimersByTimeAsync(2000); expect(el("feedback").textContent).toContain("Background operation failed");
  });
});
