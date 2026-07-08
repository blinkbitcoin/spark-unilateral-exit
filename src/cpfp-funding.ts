import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { HDKey } from "@scure/bip32";
import { NETWORK, TEST_NETWORK, Transaction, p2wpkh } from "@scure/btc-signer";

import { esploraBaseUrl, getAddressUtxos, getTipHeight } from "./esplora.ts";
import { constructSparkPackages } from "./spark-packages.ts";
import { parseSeed } from "./sweep.ts";
import type {
  AccountNumberInput,
  CpfpUtxo,
  EsploraUtxo,
  RecoveryBundle,
} from "./types.ts";

type BtcNetwork = typeof NETWORK;

const REGTEST_NETWORK: BtcNetwork = { ...TEST_NETWORK, bech32: "bcrt" };
const BTC_NETWORKS = new Map<string, BtcNetwork>([
  ["MAINNET", NETWORK],
  ["TESTNET", TEST_NETWORK],
  ["SIGNET", TEST_NETWORK],
  ["REGTEST", REGTEST_NETWORK],
  ["LOCAL", REGTEST_NETWORK],
]);

// Dedicated BIP32 purpose for this recovery tool's throwaway CPFP funding key.
// It is one above the Spark wallet purpose (8797555') so it can never collide
// with the Spark SDK's own keys -- the SDK derives identity/signing/deposit/
// static-deposit/htlc under 8797555'/<account>'/0'..4' -- nor with a standard
// BIP44/49/84/86 wallet that happens to share the same seed.
// Only the purpose level is hardened: with the account and index public, a
// watch-only wallet (e.g. Sparrow) given the xpub at m/8797556' can derive and
// monitor the funding address without the seed.
const CPFP_FUNDING_PURPOSE = 8797556;

// Large placeholder value so package construction succeeds while we only measure
// fee-bump sizes; the real funding amount is derived from the fees they imply.
const PLACEHOLDER_VALUE_SATS = 1_000_000_000n;
const PLACEHOLDER_TXID = "11".repeat(32);

const DEFAULT_BUFFER_SATS = 1000n;

export class CpfpFundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CpfpFundingError";
  }
}

export interface CpfpFundingKey {
  privateKey: Uint8Array;
  privateKeyHex: string;
  publicKey: string;
  address: string | undefined;
  script: string;
  derivationPath: string;
  purposeXpub: string;
  watchDescriptor: string;
}

// Extended-key version bytes so the exported watch-only key reads as xpub on
// mainnet and tpub elsewhere, matching what Sparrow/Electrum expect per network.
const TESTNET_BIP32_VERSIONS = { private: 0x04358394, public: 0x043587cf };

export function deriveCpfpFundingKey({
  seed,
  network,
  accountNumber = 0,
}: {
  seed: string;
  network: string;
  accountNumber?: AccountNumberInput;
}): CpfpFundingKey {
  const btcNetwork = btcNetworkFor(network);
  const account = normalizeAccountNumber(accountNumber);
  const path = `m/${CPFP_FUNDING_PURPOSE}'/${account}/0`;
  const versions =
    String(network).toUpperCase() === "MAINNET" ? undefined : TESTNET_BIP32_VERSIONS;
  const root = HDKey.fromMasterSeed(parseSeed(seed), versions);
  const derived = root.derive(path);
  if (!derived.privateKey) {
    throw new CpfpFundingError(`Derivation path produced no private key: ${path}`);
  }
  const privateKey = derived.privateKey;
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  const payment = p2wpkh(publicKey, btcNetwork);
  const purposeNode = root.derive(`m/${CPFP_FUNDING_PURPOSE}'`);
  const purposeXpub = purposeNode.publicExtendedKey;
  const fingerprint = root.fingerprint.toString(16).padStart(8, "0");
  return {
    privateKey,
    privateKeyHex: bytesToHex(privateKey),
    publicKey: bytesToHex(publicKey),
    address: payment.address,
    script: bytesToHex(payment.script),
    derivationPath: path,
    purposeXpub,
    watchDescriptor: `wpkh([${fingerprint}/${CPFP_FUNDING_PURPOSE}']${purposeXpub}/${account}/0)`,
  };
}

// Observed vsize of the one-input one-output Taproot key-path sweep the sweep
// command builds; used to price the final leaf-value -> destination spend.
const SWEEP_TX_VSIZE = 111n;

export interface LeafEconomics {
  leafId: string | null | undefined;
  feeBumpTxCount: number;
  feeSats: string;
  valueSats: string | null;
  sweepFeeSats: string;
  netSats: string | null;
  economical: boolean;
}

interface EstimateCpfpFundingOptions {
  bundle: RecoveryBundle;
  feeRate: number;
  fundingScript: string;
  fundingPublicKey: string;
  bufferSats?: bigint | number | string;
  // Extra sats a leaf must net (value - CPFP fees - sweep fee) to count as
  // economical. 0 means "anything that does not lose money".
  minNetSats?: bigint | number | string;
  includeUneconomical?: boolean;
  sparkClient?: unknown;
}

export async function estimateCpfpFunding({
  bundle,
  feeRate,
  fundingScript,
  fundingPublicKey,
  bufferSats = DEFAULT_BUFFER_SATS,
  minNetSats = 0n,
  includeUneconomical = false,
  sparkClient,
}: EstimateCpfpFundingOptions) {
  const normalizedFeeRate = validateFeeRate(feeRate);
  const placeholderUtxo: CpfpUtxo = {
    txid: PLACEHOLDER_TXID,
    vout: 0,
    value: PLACEHOLDER_VALUE_SATS,
    script: fundingScript,
    publicKey: fundingPublicKey,
  };
  const packages = await constructSparkPackages({
    bundle,
    cpfpUtxos: [placeholderUtxo],
    feeRate: normalizedFeeRate,
    sparkClient,
  });
  if (packages.length === 0) {
    throw new CpfpFundingError(
      "Bundle contains no packages; nothing to estimate funding for",
    );
  }

  const leafValues = new Map<string, bigint>();
  for (const leaf of bundle.leaves ?? []) {
    if (leaf?.id && leaf.valueSats !== undefined) {
      leafValues.set(leaf.id, BigInt(leaf.valueSats));
    }
  }
  const sweepFeeSats = feeForVsize(SWEEP_TX_VSIZE, normalizedFeeRate);
  const minNet = BigInt(minNetSats);

  let feeBumpTxCount = 0;
  let totalFeeSats = 0n;
  const perLeaf: LeafEconomics[] = [];
  for (const leafPackage of packages) {
    let leafFee = 0n;
    let leafCount = 0;
    for (const txPkg of leafPackage.txPackages ?? []) {
      if (!txPkg?.feeBumpPsbt) continue;
      leafFee += feeBumpTxFee(txPkg.feeBumpPsbt);
      leafCount += 1;
    }
    const value = leafPackage.leafId
      ? (leafValues.get(leafPackage.leafId) ?? null)
      : null;
    // A leaf is worth exiting when its value covers the CPFP fees spent from
    // the funding UTXO plus the final sweep fee, with minNetSats to spare.
    // Leaves without a known value are kept: losing track of value metadata
    // must not silently drop funds.
    const net = value === null ? null : value - leafFee - sweepFeeSats;
    const economical = net === null || net > minNet;
    if (economical || includeUneconomical) {
      feeBumpTxCount += leafCount;
      totalFeeSats += leafFee;
    }
    perLeaf.push({
      leafId: leafPackage.leafId,
      feeBumpTxCount: leafCount,
      feeSats: leafFee.toString(),
      valueSats: value === null ? null : value.toString(),
      sweepFeeSats: sweepFeeSats.toString(),
      netSats: net === null ? null : net.toString(),
      economical,
    });
  }

  const skippedLeafIds = includeUneconomical
    ? []
    : perLeaf.filter((l) => !l.economical).map((l) => l.leafId);

  const buffer = BigInt(bufferSats);
  const requiredSats = totalFeeSats + buffer;
  return {
    feeRateSatPerVbyte: normalizedFeeRate,
    feeBumpTxCount,
    totalFeeSats: totalFeeSats.toString(),
    bufferSats: buffer.toString(),
    requiredSats: requiredSats.toString(),
    perLeaf,
    skippedLeafIds,
  };
}

function feeForVsize(vsize: bigint, feeRate: number): bigint {
  // Fee rates are validated positive numbers; scale via 1000 to keep sat
  // precision for fractional rates without floating-point drift.
  return (vsize * BigInt(Math.ceil(feeRate * 1000)) + 999n) / 1000n;
}

// P2WPKH weight units: ~68 vbytes per input (incl. witness), 31 per output,
// 10.5 overhead. Rounded up via the *2/2 trick is unnecessary; use ceil parts.
const FAN_OUT_OVERHEAD_VBYTES = 11n;
const P2WPKH_INPUT_VBYTES = 68n;
const P2WPKH_OUTPUT_VBYTES = 31n;
const P2WPKH_DUST_SATS = 546n;

interface BuildFanOutOptions {
  utxos: CpfpUtxo[];
  amounts: bigint[];
  privateKey: Uint8Array;
  feeRate: number;
}

// Splits the funding UTXO(s) into one output per leaf, all paying back to the
// same funding script. Per-leaf UTXOs keep each leaf's CPFP chain independent,
// so leaves exit in parallel instead of serializing behind each other's
// refund timelocks. Any input surplus is added to the last output rather than
// creating a separate change output; it stays at the funding address either way.
export function buildFanOutTransaction({
  utxos,
  amounts,
  privateKey,
  feeRate,
}: BuildFanOutOptions): { txHex: string; txid: string; outputs: CpfpUtxo[] } {
  if (utxos.length === 0) throw new CpfpFundingError("Fan-out requires at least one input UTXO");
  if (amounts.length === 0) throw new CpfpFundingError("Fan-out requires at least one output amount");
  const script = utxos[0]!.script;
  const publicKey = utxos[0]!.publicKey;
  if (utxos.some((u) => u.script !== script)) {
    throw new CpfpFundingError("Fan-out inputs must all pay the funding script");
  }

  const vsize =
    FAN_OUT_OVERHEAD_VBYTES +
    P2WPKH_INPUT_VBYTES * BigInt(utxos.length) +
    P2WPKH_OUTPUT_VBYTES * BigInt(amounts.length);
  const fee = feeForVsize(vsize, validateFeeRate(feeRate));
  const totalIn = utxos.reduce((sum, u) => sum + u.value, 0n);
  const totalOut = amounts.reduce((sum, a) => sum + a, 0n);
  const remainder = totalIn - totalOut - fee;
  if (remainder < 0n) {
    throw new CpfpFundingError(
      `Funding UTXOs hold ${totalIn} sats but the fan-out needs ${totalOut + fee} sats (${totalOut} outputs + ${fee} fee); send ${-remainder} more sats to the funding address`,
    );
  }
  const finalAmounts = [...amounts];
  finalAmounts[finalAmounts.length - 1]! += remainder;
  if (finalAmounts.some((a) => a < P2WPKH_DUST_SATS)) {
    throw new CpfpFundingError(
      `Fan-out output below dust (${P2WPKH_DUST_SATS} sats); raise the per-leaf buffer`,
    );
  }

  const scriptBytes = hexToBytes(script);
  const tx = new Transaction();
  for (const utxo of utxos) {
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      sequence: 0xfffffffd,
      witnessUtxo: { script: scriptBytes, amount: utxo.value },
    });
  }
  for (const amount of finalAmounts) {
    tx.addOutput({ script: scriptBytes, amount });
  }
  tx.sign(privateKey);
  tx.finalize();
  const txid = tx.id;
  return {
    txHex: bytesToHex(tx.extract()),
    txid,
    outputs: finalAmounts.map((value, vout) => ({ txid, vout, value, script, publicKey })),
  };
}

interface FundingUtxoMatch {
  txid: string;
  vout: number;
  value: bigint;
  confirmations: number;
}

interface WatchCpfpFundingOptions {
  address?: string;
  script?: string;
  publicKey?: string;
  network: string;
  esploraUrl?: string;
  minSats?: bigint | number | string;
  minConfirmations?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onPoll?: (info: {
    attempt: number;
    utxos: EsploraUtxo[];
    match: FundingUtxoMatch | null;
    error: Error | null;
  }) => void;
  fetchUtxos?: (address: string, baseUrl: string) => Promise<EsploraUtxo[]>;
  fetchTipHeight?: (baseUrl: string) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function watchCpfpFunding({
  address,
  script,
  publicKey,
  network,
  esploraUrl,
  minSats,
  minConfirmations = 1,
  // Funding waits are dominated by block time, and public Esplora instances
  // rate-limit aggressive pollers, so poll gently by default.
  pollIntervalMs = 30_000,
  timeoutMs = 0,
  onPoll,
  // Injectable for tests; default to the real Esplora client.
  fetchUtxos = getAddressUtxos,
  fetchTipHeight = getTipHeight,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}: WatchCpfpFundingOptions) {
  if (!address) throw new CpfpFundingError("watchCpfpFunding requires an address");
  const baseUrl = esploraBaseUrl(network, esploraUrl);
  const minValue = BigInt(minSats ?? 0);
  const deadline = timeoutMs > 0 ? now() + timeoutMs : null;

  let consecutiveErrors = 0;
  for (let attempt = 1; ; attempt += 1) {
    // A watch loop must survive transient Esplora failures (timeouts, 5xx,
    // rate limiting): report them through onPoll and try again next interval
    // instead of aborting a wait that may span hours.
    let utxos: EsploraUtxo[] = [];
    let match: FundingUtxoMatch | null = null;
    let pollError: Error | null = null;
    try {
      utxos = await fetchUtxos(address, baseUrl);
      // Esplora already distinguishes confirmed from mempool per UTXO, so the
      // tip height (a second request per poll) is only needed to count depth
      // beyond the first confirmation.
      const tipHeight = minConfirmations > 1 ? await fetchTipHeight(baseUrl) : null;
      match = pickFundingUtxo({ utxos, minValue, minConfirmations, tipHeight });
      consecutiveErrors = 0;
    } catch (error) {
      pollError = error instanceof Error ? error : new Error(String(error));
      consecutiveErrors += 1;
    }
    onPoll?.({ attempt, utxos, match, error: pollError });
    if (match) {
      return {
        txid: match.txid,
        vout: match.vout,
        // String for consistency with estimateCpfpFunding's BigInt fields.
        value: match.value.toString(),
        script,
        publicKey,
        confirmations: match.confirmations,
      };
    }
    if (deadline !== null && now() >= deadline) {
      throw new CpfpFundingError(
        `Timed out after ${timeoutMs}ms waiting for >= ${minValue} sats at ${address}`,
      );
    }
    // Back off exponentially while Esplora is failing (likely rate limiting),
    // up to 8x the poll interval, and recover to the normal cadence as soon
    // as a poll succeeds.
    const backoff = Math.min(2 ** consecutiveErrors, 8);
    await sleep(pollIntervalMs * (pollError ? backoff : 1));
  }
}

// Assumes the user funds the address with a single UTXO covering minValue, as
// the docs instruct: this returns the first individually sufficient UTXO and
// never combines smaller ones, so a split deposit is not matched.
export function pickFundingUtxo({
  utxos,
  minValue,
  minConfirmations,
  tipHeight,
}: {
  utxos: EsploraUtxo[];
  minValue: bigint;
  minConfirmations: number;
  tipHeight: number | null;
}): FundingUtxoMatch | null {
  if (!Array.isArray(utxos)) return null;
  for (const utxo of utxos) {
    const value = BigInt(utxo?.value ?? 0);
    if (value < minValue) continue;
    const confirmations = utxoConfirmations(utxo, tipHeight);
    if (confirmations < minConfirmations) continue;
    return { txid: utxo.txid, vout: utxo.vout, value, confirmations };
  }
  return null;
}

function utxoConfirmations(
  utxo: EsploraUtxo,
  tipHeight: number | null | undefined,
): number {
  if (!utxo?.status?.confirmed) return 0;
  const blockHeight = utxo.status.block_height;
  if (tipHeight === null || tipHeight === undefined || !Number.isInteger(blockHeight)) {
    return 1;
  }
  return Math.max(0, tipHeight - blockHeight! + 1);
}

function feeBumpTxFee(psbtHex: string): bigint {
  const tx = Transaction.fromPSBT(hexToBytes(psbtHex), {
    allowUnknown: true,
    allowLegacyWitnessUtxo: true,
    version: 3,
  });
  let inputSum = 0n;
  for (let i = 0; i < tx.inputsLength; i += 1) {
    // Spark is all-segwit, so every input must carry a witnessUtxo; treating a
    // missing one as 0 would silently misestimate the fee.
    const amount = tx.getInput(i)?.witnessUtxo?.amount;
    if (amount === undefined || amount === null) {
      throw new CpfpFundingError(
        `Fee-bump PSBT input ${i} has no witnessUtxo; cannot estimate funding`,
      );
    }
    inputSum += amount;
  }
  let outputSum = 0n;
  for (let i = 0; i < tx.outputsLength; i += 1) {
    outputSum += tx.getOutput(i)?.amount ?? 0n;
  }
  const fee = inputSum - outputSum;
  if (fee < 0n) {
    throw new CpfpFundingError("Fee-bump PSBT has negative fee; cannot estimate funding");
  }
  return fee;
}

function btcNetworkFor(network: string): BtcNetwork {
  const config = BTC_NETWORKS.get(String(network ?? "").toUpperCase());
  if (!config) {
    throw new CpfpFundingError(`Unsupported network for CPFP funding: ${network}`);
  }
  return config;
}

function normalizeAccountNumber(value: AccountNumberInput): number {
  if (value === undefined || value === null || value === "") return 0;
  const account = Number(value);
  if (!Number.isSafeInteger(account) || account < 0) {
    throw new CpfpFundingError("--account-number must be a non-negative integer");
  }
  return account;
}

function validateFeeRate(feeRate: number): number {
  const value = Number(feeRate);
  if (!Number.isFinite(value) || value <= 0) {
    throw new CpfpFundingError("--fee-rate must be a positive number");
  }
  return value;
}
