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
}

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
  const path = `m/${CPFP_FUNDING_PURPOSE}'/${account}'/0'`;
  const root = HDKey.fromMasterSeed(parseSeed(seed));
  const derived = root.derive(path);
  if (!derived.privateKey) {
    throw new CpfpFundingError(`Derivation path produced no private key: ${path}`);
  }
  const privateKey = derived.privateKey;
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  const payment = p2wpkh(publicKey, btcNetwork);
  return {
    privateKey,
    privateKeyHex: bytesToHex(privateKey),
    publicKey: bytesToHex(publicKey),
    address: payment.address,
    script: bytesToHex(payment.script),
    derivationPath: path,
  };
}

interface EstimateCpfpFundingOptions {
  bundle: RecoveryBundle;
  feeRate: number;
  fundingScript: string;
  fundingPublicKey: string;
  bufferSats?: bigint | number | string;
  sparkClient?: unknown;
}

export async function estimateCpfpFunding({
  bundle,
  feeRate,
  fundingScript,
  fundingPublicKey,
  bufferSats = DEFAULT_BUFFER_SATS,
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

  let feeBumpTxCount = 0;
  let totalFeeSats = 0n;
  const perLeaf: Array<{
    leafId: string | null | undefined;
    feeBumpTxCount: number;
    feeSats: string;
  }> = [];
  for (const leafPackage of packages) {
    let leafFee = 0n;
    let leafCount = 0;
    for (const txPkg of leafPackage.txPackages ?? []) {
      if (!txPkg?.feeBumpPsbt) continue;
      leafFee += feeBumpTxFee(txPkg.feeBumpPsbt);
      leafCount += 1;
    }
    feeBumpTxCount += leafCount;
    totalFeeSats += leafFee;
    perLeaf.push({
      leafId: leafPackage.leafId,
      feeBumpTxCount: leafCount,
      feeSats: leafFee.toString(),
    });
  }

  const buffer = BigInt(bufferSats);
  const requiredSats = totalFeeSats + buffer;
  return {
    feeRateSatPerVbyte: normalizedFeeRate,
    feeBumpTxCount,
    totalFeeSats: totalFeeSats.toString(),
    bufferSats: buffer.toString(),
    requiredSats: requiredSats.toString(),
    perLeaf,
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
  pollIntervalMs = 5_000,
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

  for (let attempt = 1; ; attempt += 1) {
    const utxos = await fetchUtxos(address, baseUrl);
    const tipHeight = minConfirmations > 0 ? await fetchTipHeight(baseUrl) : null;
    const match = pickFundingUtxo({ utxos, minValue, minConfirmations, tipHeight });
    onPoll?.({ attempt, utxos, match });
    if (match) {
      return {
        txid: match.txid,
        vout: match.vout,
        value: BigInt(match.value),
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
    await sleep(pollIntervalMs);
  }
}

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
    inputSum += tx.getInput(i)?.witnessUtxo?.amount ?? 0n;
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
