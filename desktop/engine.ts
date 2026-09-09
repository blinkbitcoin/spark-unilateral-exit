import { randomUUID } from "node:crypto";
import { deriveCpfpFundingKey, estimateCpfpFunding } from "../src/cpfp-funding.ts";
import { exportRecoveryBundleFromSeed } from "../src/recovery-bundle.ts";
import { constructSparkPackages } from "../src/spark-packages.ts";
import { constructSweepTransactions } from "../src/sweep.ts";
import { summarizePackages, signPackages } from "../src/sign.ts";
import { BitcoinChain, LocalChain, coordinatorFetch } from "./chain.ts";
import { ExplorerChain } from "./explorer.ts";
import { transactionIdFromHex } from "../src/transaction-id.ts";
import { bundleCheck, destinationCheck, feeCheck } from "./validation.ts";
import type { WalletState, RecoverySession, Settings } from "./contracts.ts";
import { DEFAULT_SETTINGS } from "./contracts.ts";
import type { RecoveryBundle } from "../src/types.ts";

export class RecoveryEngine {
  constructor(readonly chain?: BitcoinChain) {}
  private chainFor(settings: Settings) {
    if (this.chain) return this.chain;
    if (settings.network === "MAINNET" && !settings.bitcoinRpc) return new ExplorerChain();
    return new LocalChain(fetch, settings.bitcoinRpc);
  }
  fundingKey(state: WalletState) {
    return deriveCpfpFundingKey({ seed: state.seed, network: state.settings.network ?? "LOCAL", accountNumber: state.settings.accountNumber });
  }
  async refresh(state: WalletState): Promise<RecoveryBundle> {
    const bundle = await exportRecoveryBundleFromSeed({ seed: state.seed, network: state.settings.network ?? "LOCAL",
      accountNumber: state.settings.accountNumber, coordinatorUrl: state.settings.coordinatorUrl,
      fetchImpl: coordinatorFetch(state.settings.coordinatorCa), appVersion: "electron-app" });
    return bundleCheck(bundle, state.seed, state.settings.accountNumber, state.settings.network);
  }
  async estimate(state: WalletState, leafId: string, feeRate: number) {
    const chain = this.chainFor(state.settings);
    await chain.verify(state.settings.network);
    const bundle = this.select(state, leafId);
    const key = this.fundingKey(state);
    const result = await estimateCpfpFunding({ bundle, feeRate: feeCheck(feeRate), fundingScript: key.script, fundingPublicKey: key.publicKey });
    return { address: key.address!, requiredSats: result.requiredSats, feeSats: result.totalFeeSats,
      netSats: result.perLeaf[0]?.netSats, economical: result.perLeaf[0]?.economical };
  }
  async prepare(state: WalletState, leafId: string, destination: string, feeRate: number): Promise<RecoverySession> {
    destination = destinationCheck(destination, state.settings.network);
    feeRate = feeCheck(feeRate);
    const chain = this.chainFor(state.settings);
    await chain.verify(state.settings.network);
    const bundle = this.select(state, leafId);
    const key = this.fundingKey(state);
    const funding = await chain.funding(key.address!);
    const cpfpUtxos = funding.unspents.map((u) => ({ txid: u.txid, vout: u.vout,
      value: BigInt(Math.round(u.amount * 1e8)), script: u.scriptPubKey, publicKey: key.publicKey }));
    if (!cpfpUtxos.length) throw new Error("Fund the fee address and wait for a confirmation first.");
    const packages = await constructSparkPackages({ bundle, cpfpUtxos, feeRate });
    if (packages.length !== 1 || packages[0]?.leafId !== leafId) throw new Error("Package builder did not return the selected leaf.");
    // Verifies the seed owns the terminal refund before any funding key signs.
    const sweep = constructSweepTransactions({ seed: state.seed, network: state.settings.network ?? "LOCAL", packages: { packages },
      accountNumber: state.settings.accountNumber, destination, feeRate }).sweeps[0]!;
    const summaries = summarizePackages({ packages, privateKey: key.privateKey });
    const fee = summaries.reduce((n, s) => n + BigInt(s.feeSats), BigInt(sweep.feeSats));
    if (fee > 100000n || fee >= BigInt(bundle.leaves[0]!.valueSats!)) throw new Error("Unilateral exit fees exceed the app cap or the selected output value.");
    return { id: randomUUID(), leafId, bundle, destination, feeRate, feeSats: fee.toString(),
      packages, sweep, approved: false, status: "review", message: "Review the destination and exact transaction fees." };
  }
  approve(state: WalletState): void {
    const session = state.session!;
    session.packages = signPackages({ packages: session.packages, privateKey: this.fundingKey(state).privateKey, approved: true });
    session.approved = true;
    session.status = "running";
    session.message = "Signed transactions saved. Ready to submit to Bitcoin.";
  }
  async advance(session: RecoverySession, settings: Settings = DEFAULT_SETTINGS): Promise<void> {
    if (!session.approved) throw new Error("Review and approve the unilateral exit first.");
    const chain = this.chainFor(settings);
    if (session.bundle.network !== (settings.network ?? "LOCAL")) throw new Error("Saved exit network does not match this profile.");
    await chain.verify(settings.network);
    // Always re-check from the beginning, including after reorgs or ambiguous
    // submissions. Retry only the exact bytes durably saved at approval.
    for (const pkg of session.packages[0]!.txPackages ?? []) {
      if (!pkg.tx || !pkg.signedChildTx) throw new Error("Saved unilateral exit is missing signed transactions.");
      const parent = await chain.status(transactionIdFromHex(pkg.tx));
      const child = await chain.status(transactionIdFromHex(pkg.signedChildTx));
      if ((parent?.confirmations ?? 0) > 0 && (child?.confirmations ?? 0) > 0) continue;
      if (parent && child) { session.message = "Waiting for exit package confirmations."; return; }
      const wait = await chain.maturity(pkg.tx);
      if (wait) { session.message = wait; return; }
      // If only the parent made it on chain, submit the saved child separately.
      if (parent) await chain.broadcast(pkg.signedChildTx);
      else await chain.submit(pkg.tx, pkg.signedChildTx);
      session.message = "Exit package submitted. Waiting for confirmation.";
      return;
    }
    const status = await chain.status(session.sweep.sweepTxid);
    if ((status?.confirmations ?? 0) > 0) {
      session.status = "complete";
      session.message = `The destination sweep is confirmed on ${settings.network === "MAINNET" ? "mainnet" : "regtest"}.`;
      return;
    }
    if (status) { session.message = "Waiting for destination sweep confirmation."; return; }
    const refund = await chain.status(session.sweep.refundTxid);
    if (!refund || refund.confirmations < 1) { session.message = "Waiting for refund confirmation."; return; }
    const wait = await chain.maturity(session.sweep.sweepTx);
    if (wait) { session.message = wait; return; }
    await chain.broadcast(session.sweep.sweepTx);
    session.message = "Sweep submitted. Waiting for destination confirmation.";
  }
  private select(state: WalletState, leafId: string): RecoveryBundle {
    if (!state.bundle) throw new Error("Import or refresh a recovery bundle first.");
    const bundle = bundleCheck(structuredClone(state.bundle), state.seed, state.settings.accountNumber, state.settings.network);
    const leaf = bundle.leaves.find((l) => l.id === leafId);
    if (!leaf || state.completed.some((s) => s.leafId === leafId)) throw new Error("Select an output that has not already completed a unilateral exit.");
    return { ...bundle, leaves: [leaf] };
  }
}
