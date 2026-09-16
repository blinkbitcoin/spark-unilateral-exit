import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";
import { Transaction, p2wpkh } from "@scure/btc-signer";
import { bytesToHex } from "@noble/curves/utils";
import { RecoveryEngine } from "../../desktop/engine.ts";
import { LocalChain, parseTx } from "../../desktop/chain.ts";
import { REGTEST } from "../../desktop/validation.ts";
import { deriveIdentityKeyPair } from "../../src/operator/identity.ts";
import { wallet, recovery, bundle, SEED } from "./helpers.ts";
import { ExplorerChain } from "../../desktop/explorer.ts";
const mocks = vi.hoisted(() => ({ refresh: vi.fn(), construct: vi.fn(), sweep: vi.fn(), summaries: vi.fn(), sign: vi.fn(), estimate: vi.fn(), consolidate: vi.fn() }));
vi.mock("../../src/recovery-bundle.ts", () => ({ exportRecoveryBundleFromSeed: mocks.refresh }));
vi.mock("../../src/consolidate.ts", () => ({ consolidateLeavesFromSeed: mocks.consolidate }));
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
  mocks.consolidate.mockResolvedValue({ executed: false });
});
describe("desktop recovery engine", () => {
  it("checks two observed snapshots read-only without replacing the saved bundle", async () => {
    const f = fixture(), state = wallet(), before = structuredClone(state);
    delete state.bundle!.nodes;
    delete before.bundle!.nodes;
    const result = await f.engine.checkBundle(state, state.bundle);
    expect(result).toMatchObject({ status: "match", savedLeaves: 1, currentLeaves: 1, source: state.settings.coordinatorUrl });
    expect(result.savedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.currentDigest).toBe(result.savedDigest);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(state).toEqual(before);
    for (const mock of [mocks.consolidate, mocks.construct, mocks.sweep, mocks.sign, mocks.estimate, f.verify, f.broadcast, f.submit]) expect(mock).not.toHaveBeenCalled();
  });
  it("compares recovery material canonically, ignoring ordering and timestamps", async () => {
    const state = wallet();
    const node = TreeNode.decode(Buffer.from(state.bundle!.leaves[0]!.treeNodeHex, "hex"));
    node.parentNodeId = "root";
    const encode = (n: typeof node) => ({ id: n.id, treeNodeHex: bytesToHex(TreeNode.encode(n).finish()) });
    state.bundle!.leaves = [encode(node), encode({ ...node, id: "leaf2" })];
    state.bundle!.nodes = [encode({ ...node, id: "root", parentNodeId: undefined })];
    const current = structuredClone(state.bundle!);
    current.createdAt = "2026-09-10T00:00:00Z"; current.appVersion = "other"; current.leaves.reverse();
    const timestamped = { ...node, createdTime: new Date(), updatedTime: new Date() };
    current.leaves[1] = encode(timestamped);
    current.nodes!.push(encode({ ...node, id: "unreachable", parentNodeId: undefined }));
    mocks.refresh.mockResolvedValue(current);
    const result = await new RecoveryEngine().checkBundle(state, state.bundle);
    expect(result.status).toBe("match"); expect(result.currentDigest).toBe(result.savedDigest);
  });
  it.each(["saved/current", "consecutive snapshots"])("ignores public-share map wire order across %s", async (comparison) => {
    const state = wallet();
    const node = TreeNode.decode(Buffer.from(state.bundle!.leaves[0]!.treeNodeHex, "hex"));
    const shares = { "operator-b": new Uint8Array([2]), "operator-a": new Uint8Array([1]) };
    node.signingKeyshare = TreeNode.fromPartial({ signingKeyshare: { publicShares: shares } }).signingKeyshare;
    state.bundle!.leaves[0]!.treeNodeHex = bytesToHex(TreeNode.encode(node).finish());
    const reordered = structuredClone(state.bundle!);
    node.signingKeyshare!.publicShares = Object.fromEntries(Object.entries(shares).reverse());
    reordered.leaves[0]!.treeNodeHex = bytesToHex(TreeNode.encode(node).finish());
    expect(reordered.leaves[0]!.treeNodeHex).not.toBe(state.bundle!.leaves[0]!.treeNodeHex);
    mocks.refresh.mockResolvedValueOnce(comparison === "saved/current" ? reordered : state.bundle)
      .mockResolvedValueOnce(reordered);
    const result = await new RecoveryEngine().checkBundle(state, state.bundle);
    expect(result.status).toBe("match"); expect(result.currentDigest).toBe(result.savedDigest);

    node.signingKeyshare!.publicShares["operator-a"] = new Uint8Array([3]);
    const changed = structuredClone(reordered);
    changed.leaves[0]!.treeNodeHex = bytesToHex(TreeNode.encode(node).finish());
    mocks.refresh.mockResolvedValue(changed);
    const stale = await new RecoveryEngine().checkBundle(state, state.bundle);
    expect(stale.status).toBe("stale"); expect(stale.currentDigest).not.toBe(stale.savedDigest);
  });
  it("detects same-balance replacements and changed recovery bytes at any reachable depth", async () => {
    const state = wallet(), encode = (n: TreeNode) => ({ id: n.id, treeNodeHex: bytesToHex(TreeNode.encode(n).finish()) });
    const leaf = TreeNode.decode(Buffer.from(state.bundle!.leaves[0]!.treeNodeHex, "hex"));
    leaf.parentNodeId = "parent";
    const parent = { ...leaf, id: "parent", parentNodeId: "root" }, root = { ...leaf, id: "root", parentNodeId: undefined };
    state.bundle!.leaves = [encode(leaf)]; state.bundle!.nodes = [encode(parent), encode(root)];
    for (const changed of [
      { ...state.bundle!, leaves: [encode({ ...leaf, id: "replacement" })] },
      ...["nodeTx", "refundTx", "directTx", "directRefundTx", "directFromCpfpRefundTx"].flatMap((field) => [
        { ...state.bundle!, leaves: [encode({ ...leaf, [field]: new Uint8Array([2]) })] },
        { ...state.bundle!, nodes: [encode(parent), encode({ ...root, [field]: new Uint8Array([2]) })] },
      ]),
    ]) {
      mocks.refresh.mockResolvedValue(changed);
      const result = await new RecoveryEngine().checkBundle(state, state.bundle);
      expect(result.status).toBe("stale"); expect(result.savedLeaves).toBe(result.currentLeaves);
      expect(result.savedDigest).not.toBe(result.currentDigest);
    }
  });
  it("returns unknown rather than match for changing or unavailable operator snapshots", async () => {
    const state = wallet(), engine = new RecoveryEngine();
    mocks.refresh.mockResolvedValueOnce(bundle()).mockResolvedValueOnce({ ...bundle(), leaves: [] });
    expect((await engine.checkBundle(state, state.bundle)).status).toBe("unknown");
    mocks.refresh.mockRejectedValueOnce(new Error("offline"));
    expect((await engine.checkBundle(state, state.bundle)).status).toBe("unknown");
    mocks.refresh.mockResolvedValueOnce(bundle()).mockResolvedValueOnce(bundle(0));
    expect((await engine.checkBundle(state, state.bundle)).status).toBe("unknown");
    const changed = bundle(), node = TreeNode.decode(Buffer.from(changed.leaves[0]!.treeNodeHex, "hex"));
    node.refundTx = new Uint8Array([2]); changed.leaves[0]!.treeNodeHex = bytesToHex(TreeNode.encode(node).finish());
    mocks.refresh.mockResolvedValueOnce(bundle()).mockResolvedValueOnce(changed);
    expect(await engine.checkBundle(state, state.bundle)).toMatchObject({ status: "unknown", message: expect.stringContaining("changed between") });
  });
  it("marks absent, wrong-identity and incomplete saved material invalid before contacting operators", async () => {
    const state = wallet(), incomplete = bundle();
    const node = TreeNode.decode(Buffer.from(incomplete.leaves[0]!.treeNodeHex, "hex"));
    node.parentNodeId = "missing"; incomplete.leaves[0]!.treeNodeHex = bytesToHex(TreeNode.encode(node).finish());
    for (const saved of [undefined, {}, { ...bundle(), leaves: [] }, bundle(0), bundle(1, SEED, "MAINNET"), incomplete]) {
      expect((await new RecoveryEngine().checkBundle(state, saved)).status).toBe("invalid");
    }
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
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
  it("consolidates leaves before exporting in exit mode and flags a stale bundle", async () => {
    const f = fixture(); const state = wallet();
    expect(await f.engine.refresh(state, "exit")).toMatchObject({ network: "LOCAL" });
    expect(mocks.consolidate).toHaveBeenCalledWith(expect.objectContaining({ seed: SEED, network: "LOCAL", accountNumber: 1, multiplicity: 0 }));
    expect(mocks.consolidate.mock.invocationCallOrder[0]).toBeLessThan(mocks.refresh.mock.invocationCallOrder[0]!);
    mocks.consolidate.mockResolvedValueOnce({ executed: true });
    mocks.refresh.mockRejectedValueOnce(new Error("offline"));
    await expect(f.engine.refresh(state, "exit")).rejects.toThrow("stale");
    mocks.refresh.mockRejectedValueOnce(new Error("offline"));
    await expect(f.engine.refresh(state, "exit")).rejects.toThrow("offline");
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
