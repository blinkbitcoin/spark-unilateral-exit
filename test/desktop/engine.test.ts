import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transaction, p2wpkh } from "@scure/btc-signer";
import { bytesToHex } from "@noble/curves/utils";
import { RecoveryEngine } from "../../desktop/engine.ts";
import { LocalChain, parseTx } from "../../desktop/chain.ts";
import { REGTEST } from "../../desktop/validation.ts";
import { deriveIdentityKeyPair } from "../../src/operator/identity.ts";
import { wallet, recovery, bundle, SEED } from "./helpers.ts";
import { ExplorerChain } from "../../desktop/explorer.ts";
const mocks = vi.hoisted(() => ({ refresh: vi.fn(), construct: vi.fn(), sweep: vi.fn(), summaries: vi.fn(), sign: vi.fn(), estimate: vi.fn() }));
vi.mock("../../src/recovery-bundle.ts", () => ({ exportRecoveryBundleFromSeed: mocks.refresh }));
vi.mock("../../src/spark-packages.ts", () => ({ constructSparkPackages: mocks.construct }));
vi.mock("../../src/sign.ts", () => ({ summarizePackages: mocks.summaries, signPackages: mocks.sign }));
vi.mock("../../src/sweep.ts", async (importOriginal) => ({ ...await importOriginal<typeof import("../../src/sweep.ts")>(), constructSweepTransactions: mocks.sweep }));
vi.mock("../../src/cpfp-funding.ts", async (importOriginal) => ({ ...await importOriginal<typeof import("../../src/cpfp-funding.ts")>(), estimateCpfpFunding: mocks.estimate }));
function raw(n: number) {
  const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
  tx.addOutput({ script: new Uint8Array([0x51]), amount: 100n }); tx.addInput({ txid: "11".repeat(32), index: n, finalScriptWitness: [new Uint8Array([1])] });
  return bytesToHex(tx.toBytes(true, true));
}
function fixture() {
  const chain = new LocalChain();
  const verify = vi.spyOn(chain, "verify").mockResolvedValue();
  const status = vi.spyOn(chain, "status").mockResolvedValue(null);
  const funding = vi.spyOn(chain, "funding").mockResolvedValue({ unspents: [{ txid: "aa", vout: 0, amount: .001, scriptPubKey: "0014" }] });
  const submit = vi.spyOn(chain, "submit").mockResolvedValue();
  const broadcast = vi.spyOn(chain, "broadcast").mockResolvedValue();
  const maturity = vi.spyOn(chain, "maturity").mockResolvedValue(null);
  return { engine: new RecoveryEngine(chain), chain, verify, status, funding, submit, broadcast, maturity };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.refresh.mockResolvedValue(bundle()); mocks.construct.mockResolvedValue([{ leafId: "leaf", txPackages: [] }]);
  mocks.sweep.mockReturnValue({ sweeps: [recovery().sweep] }); mocks.summaries.mockReturnValue([{ feeSats: "1000" }]);
  mocks.estimate.mockResolvedValue({ requiredSats: "1000", totalFeeSats: "500", perLeaf: [{ netSats: "99000", economical: true }] });
  mocks.sign.mockReturnValue([{ leafId: "leaf", txPackages: [] }]);
});
describe("desktop recovery engine", () => {
  afterEach(() => vi.restoreAllMocks());
  it("selects mainnet explorer by default and uses a configured node without falling back", async () => {
    const engine = new RecoveryEngine(); const state = wallet();
    state.settings = { ...state.settings, network: "MAINNET" }; state.bundle = bundle(1, SEED, "MAINNET");
    const explorer = vi.spyOn(ExplorerChain.prototype, "verify").mockResolvedValue();
    await engine.estimate(state, "leaf", 2); expect(explorer).toHaveBeenCalledWith("MAINNET");
    const local = vi.spyOn(LocalChain.prototype, "verify").mockResolvedValue();
    state.settings.bitcoinRpc = { url: "http://localhost:8332", username: "user", password: "secret" };
    await engine.estimate(state, "leaf", 2); expect(local).toHaveBeenCalledWith("MAINNET"); expect(explorer).toHaveBeenCalledTimes(1);
    local.mockRejectedValueOnce(new Error("wrong node")); await expect(engine.estimate(state, "leaf", 2)).rejects.toThrow("wrong node"); expect(explorer).toHaveBeenCalledTimes(1);
    mocks.refresh.mockResolvedValueOnce(state.bundle); await engine.refresh(state); expect(mocks.refresh.mock.calls.at(-1)![0].network).toBe("MAINNET");
    vi.spyOn(LocalChain.prototype, "funding").mockResolvedValue({ unspents: [{ txid: "aa", vout: 0, amount: .001, scriptPubKey: "0014" }] });
    await engine.prepare(state, "leaf", p2wpkh(deriveIdentityKeyPair(SEED, "MAINNET", 1).publicKey).address!, 2);
    const session = recovery(); session.approved = true;
    await expect(engine.advance(session, state.settings)).rejects.toThrow("network does not match");
    session.bundle = state.bundle; vi.spyOn(LocalChain.prototype, "status").mockResolvedValue({ confirmations: 1 });
    await engine.advance(session, state.settings); expect(session.message).toContain("mainnet");
  });
  it("verifies the configured RPC network before mainnet operations", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ result: { chain: "main" } })));
    const chain = new LocalChain(request, { url: "http://localhost:8332", username: "user", password: "secret" });
    await chain.verify("MAINNET"); expect(request).toHaveBeenCalledWith("http://localhost:8332", expect.objectContaining({ headers: expect.objectContaining({ authorization: `Basic ${Buffer.from("user:secret").toString("base64")}` }) }));
    request.mockResolvedValueOnce(new Response(JSON.stringify({ result: { chain: "regtest" } })));
    await expect(chain.verify("MAINNET")).rejects.toThrow("not on mainnet");
  });
  it("exports via authenticated local fetch and prepares only the selected owned leaf", async () => {
    const f = fixture(); const state = wallet();
    expect(await f.engine.refresh(state)).toMatchObject({ network: "LOCAL" });
    expect(mocks.refresh.mock.calls[0]?.[0]).toMatchObject({ network: "LOCAL", coordinatorUrl: "https://localhost:8535", accountNumber: 1, appVersion: "electron-app" });
    const estimate = await f.engine.estimate(state, "leaf", 2); expect(estimate.economical).toBe(true);
    mocks.estimate.mockResolvedValueOnce({ requiredSats: "1", totalFeeSats: "1", perLeaf: [] });
    expect((await f.engine.estimate(state, "leaf", 2)).netSats).toBeUndefined();
    const destination = p2wpkh(deriveIdentityKeyPair(SEED, "LOCAL", 1).publicKey, REGTEST).address!;
    const session = await f.engine.prepare(state, "leaf", destination, 2);
    expect(session.feeSats).toBe("1200"); expect(session.approved).toBe(false);
    state.session = session; f.engine.approve(state); expect(state.session.approved).toBe(true);
    expect(mocks.sign.mock.calls[0]?.[0].approved).toBe(true);
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("rejects missing, completed and mismatched leaves, absent funds and excessive fees", async () => {
    const f = fixture(); const state = wallet(); const dest = p2wpkh(deriveIdentityKeyPair(SEED, "LOCAL", 1).publicKey, REGTEST).address!;
    await expect(f.engine.estimate({ ...state, bundle: undefined }, "leaf", 2)).rejects.toThrow("Import");
    await expect(f.engine.estimate(state, "missing", 2)).rejects.toThrow("Select");
    await expect(f.engine.estimate({ ...state, completed: [recovery()] }, "leaf", 2)).rejects.toThrow("Select");
    f.funding.mockResolvedValueOnce({ unspents: [] }); await expect(f.engine.prepare(state, "leaf", dest, 2)).rejects.toThrow("Fund");
    for (const pkgs of [[], [{ leafId: "wrong" }]]) {
      mocks.construct.mockResolvedValueOnce(pkgs); await expect(f.engine.prepare(state, "leaf", dest, 2)).rejects.toThrow("selected leaf");
    }
    for (const feeSats of ["200000", "99900"]) {
      mocks.summaries.mockReturnValueOnce([{ feeSats }]); await expect(f.engine.prepare(state, "leaf", dest, 2)).rejects.toThrow("fees exceed");
    }
  });
  it("submits saved packages, waits for confirmation and handles ambiguous partial submission", async () => {
    const f = fixture(); const s = recovery();
    await expect(f.engine.advance(s)).rejects.toThrow("approve");
    s.approved = true; s.status = "running";
    s.packages = [{ leafId: "leaf", txPackages: [{}] }];
    await expect(f.engine.advance(s)).rejects.toThrow("missing signed");
    const parent = raw(0), child = raw(1); s.packages[0]!.txPackages = [{ tx: parent, signedChildTx: child }];
    f.maturity.mockResolvedValueOnce("Wait 100 blocks"); await f.engine.advance(s); expect(s.message).toContain("100"); expect(f.submit).not.toHaveBeenCalled();
    await f.engine.advance(s); expect(f.submit).toHaveBeenCalledWith(parent, child);
    f.status.mockResolvedValueOnce({ confirmations: 0 }).mockResolvedValueOnce({ confirmations: 0 });
    await f.engine.advance(s); expect(s.message).toContain("confirmations");
    f.status.mockResolvedValueOnce({ confirmations: 1 }).mockResolvedValueOnce(null);
    await f.engine.advance(s); expect(f.broadcast).toHaveBeenCalledWith(child);
    f.status.mockResolvedValueOnce({ confirmations: 1 }).mockResolvedValueOnce({ confirmations: 1 });
    await f.engine.advance(s); expect(s.message).toContain("refund confirmation");
    expect(f.status).toHaveBeenCalledWith(parseTx(parent).id);
  });
  it("waits for the refund, sweeps, and only completes after destination confirmation", async () => {
    const f = fixture(); const s = recovery(); s.approved = true; s.status = "running";
    s.packages = [{ leafId: "leaf" }];
    f.status.mockResolvedValueOnce(null).mockResolvedValueOnce({ confirmations: 0 });
    await f.engine.advance(s); expect(s.message).toContain("refund confirmation");
    f.status.mockResolvedValueOnce(null).mockResolvedValueOnce({ confirmations: 1 }); f.maturity.mockResolvedValueOnce("Wait 10 blocks");
    await f.engine.advance(s); expect(s.message).toContain("10 blocks");
    f.status.mockResolvedValueOnce(null).mockResolvedValueOnce({ confirmations: 1 });
    await f.engine.advance(s); expect(f.broadcast).toHaveBeenCalledWith(s.sweep.sweepTx); expect(s.status).toBe("running");
    f.status.mockResolvedValueOnce({ confirmations: 0 }); await f.engine.advance(s); expect(s.message).toContain("sweep confirmation");
    f.status.mockResolvedValueOnce({ confirmations: 1 }); await f.engine.advance(s); expect(s.status).toBe("complete");
  });
});
