import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { sha256 } from "@noble/hashes/sha2";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { NETWORK, TEST_NETWORK, Transaction, p2tr } from "@scure/btc-signer";

const REGTEST_NETWORK = { ...TEST_NETWORK, bech32: "bcrt" };
const NETWORKS = new Map([
  ["MAINNET", { btc: NETWORK, coinType: 0, defaultAccounts: [1] }],
  ["TESTNET", { btc: TEST_NETWORK, coinType: 1, defaultAccounts: [1] }],
  ["SIGNET", { btc: TEST_NETWORK, coinType: 1, defaultAccounts: [1] }],
  ["REGTEST", { btc: REGTEST_NETWORK, coinType: 1, defaultAccounts: [0, 1] }],
  ["LOCAL", { btc: REGTEST_NETWORK, coinType: 1, defaultAccounts: [0, 1] }],
]);

export class SweepError extends Error {
  constructor(message) {
    super(message);
    this.name = "SweepError";
  }
}

export function constructSweepTransactions({
  seed,
  passphrase = "",
  network,
  packages,
  destination,
  feeRate,
  accountNumber,
  dustLimitSats = 330n,
}) {
  const networkConfig = networkConfigFor(network);
  const packageJson = validatePackageJson(packages);
  const destinationAddress = destination ?? packageJson.destination;
  if (!destinationAddress) {
    throw new SweepError("--destination is required when package JSON has no destination");
  }
  validateAddress(destinationAddress, networkConfig.btc);
  const normalizedFeeRate = validateFeeRate(feeRate);
  const seedBytes = parseSeed(seed, passphrase);
  const root = HDKey.fromMasterSeed(seedBytes);
  const accounts = candidateAccounts(accountNumber, networkConfig.defaultAccounts);

  const sweeps = [];
  for (const leafPackage of packageJson.packages) {
    const refundTxHex = lastTxPackage(leafPackage)?.tx;
    if (!refundTxHex) {
      throw new SweepError(`Leaf ${leafPackage?.leafId ?? "unknown"} has no refund tx`);
    }
    sweeps.push(
      constructLeafSweep({
        leafId: leafPackage.leafId,
        refundTxHex,
        root,
        accounts,
        networkConfig,
        destination: destinationAddress,
        feeRate: normalizedFeeRate,
        dustLimitSats: BigInt(dustLimitSats),
      }),
    );
  }

  return {
    destination: destinationAddress,
    feeRateSatPerVbyte: normalizedFeeRate,
    sweeps,
  };
}

export function parseSeed(input, passphrase = "") {
  const value = String(input ?? "").trim();
  if (!value) throw new SweepError("Spark seed or mnemonic is required");
  if (validateMnemonic(value, wordlist)) {
    return mnemonicToSeedSync(value, passphrase, wordlist);
  }
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new SweepError("Seed must be a BIP-39 mnemonic or 64-byte hex seed");
  }
  const seed = hexToBytes(hex);
  if (seed.length !== 64) {
    throw new SweepError(`Hex seed must decode to 64 bytes, got ${seed.length}`);
  }
  return seed;
}

export function deriveRefundKeyCandidates({ seed, network, leafId, accountNumber }) {
  const networkConfig = networkConfigFor(network);
  const root = HDKey.fromMasterSeed(parseSeed(seed));
  return refundKeyCandidates({
    root,
    leafId,
    accounts: candidateAccounts(accountNumber, networkConfig.defaultAccounts),
    coinType: networkConfig.coinType,
    btcNetwork: networkConfig.btc,
  });
}

function constructLeafSweep({
  leafId,
  refundTxHex,
  root,
  accounts,
  networkConfig,
  destination,
  feeRate,
  dustLimitSats,
}) {
  const refundTx = Transaction.fromRaw(hexToBytes(refundTxHex), {
    allowUnknownOutputs: true,
  });
  const refundOutput = refundTx.getOutput(0);
  if (!refundOutput?.script || refundOutput.amount === undefined) {
    throw new SweepError(`Refund tx for leaf ${leafId} has no output 0`);
  }
  const matchingKey = findMatchingRefundKey({
    root,
    leafId,
    script: refundOutput.script,
    accounts,
    coinType: networkConfig.coinType,
    btcNetwork: networkConfig.btc,
  });
  if (!matchingKey) {
    throw new SweepError(
      `No supported seed derivation path matched refund output for leaf ${leafId}`,
    );
  }

  const firstPass = buildSignedSweepTx({
    refundTxid: refundTx.id,
    refundOutput,
    destination,
    feeSats: 1n,
    privateKey: matchingKey.privateKey,
    tapInternalKey: matchingKey.xonlyPublicKey,
    btcNetwork: networkConfig.btc,
  });
  const feeSats = BigInt(Math.ceil(Number(firstPass.vsize) * feeRate));
  if (refundOutput.amount <= feeSats + dustLimitSats) {
    throw new SweepError(
      `Refund output for leaf ${leafId} is too small to sweep: value=${refundOutput.amount} fee=${feeSats} dustLimit=${dustLimitSats}`,
    );
  }
  const finalSweep = buildSignedSweepTx({
    refundTxid: refundTx.id,
    refundOutput,
    destination,
    feeSats,
    privateKey: matchingKey.privateKey,
    tapInternalKey: matchingKey.xonlyPublicKey,
    btcNetwork: networkConfig.btc,
  });

  return {
    leafId,
    refundTxid: refundTx.id,
    refundVout: 0,
    refundValueSats: refundOutput.amount.toString(),
    refundAddress: matchingKey.address,
    derivationPath: matchingKey.path,
    sweepTxid: finalSweep.txid,
    sweepTx: finalSweep.hex,
    feeSats: finalSweep.fee.toString(),
    vsize: finalSweep.vsize,
  };
}

function buildSignedSweepTx({
  refundTxid,
  refundOutput,
  destination,
  feeSats,
  privateKey,
  tapInternalKey,
  btcNetwork,
}) {
  const outputAmount = refundOutput.amount - feeSats;
  if (outputAmount <= 0n) {
    throw new SweepError("Sweep fee is greater than or equal to refund output value");
  }
  const tx = new Transaction({ allowUnknownOutputs: true });
  tx.addInput({
    txid: refundTxid,
    index: 0,
    witnessUtxo: {
      amount: refundOutput.amount,
      script: refundOutput.script,
    },
    tapInternalKey,
  });
  tx.addOutputAddress(destination, outputAmount, btcNetwork);
  tx.sign(privateKey);
  tx.finalize();
  return { txid: tx.id, hex: tx.hex, fee: tx.fee, vsize: tx.vsize };
}

function findMatchingRefundKey({ root, leafId, script, accounts, coinType, btcNetwork }) {
  return refundKeyCandidates({ root, leafId, accounts, coinType, btcNetwork }).find(
    (candidate) => bytesToHex(candidate.script) === bytesToHex(script),
  );
}

function refundKeyCandidates({ root, leafId, accounts, coinType, btcNetwork }) {
  const signingChildIndex = leafSigningChildIndex(leafId);
  const paths = [];
  for (const account of accounts) {
    paths.push(
      { path: `m/8797555'/${account}'/0'`, label: "identity key" },
      { path: `m/8797555'/${account}'`, label: "identity master" },
      {
        path: `m/8797555'/${account}'/1'/${signingChildIndex}'`,
        label: "node signing key",
      },
      { path: `m/86'/${coinType}'/${account}'/0/0`, label: "BIP86 taproot" },
    );
  }

  return paths.map(({ path, label }) => {
    const derived = root.derive(path);
    if (!derived.privateKey) {
      throw new SweepError(`Derivation path did not produce a private key: ${path}`);
    }
    const privateKey = derived.privateKey;
    const xonlyPublicKey = secp256k1.getPublicKey(privateKey, true).slice(1);
    const payment = p2tr(xonlyPublicKey, undefined, btcNetwork);
    return {
      path,
      label,
      privateKey,
      xonlyPublicKey,
      address: payment.address,
      script: payment.script,
    };
  });
}

function leafSigningChildIndex(leafId) {
  const hash = sha256(new TextEncoder().encode(String(leafId)));
  return (
    ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0
  ) % 0x80000000;
}

function validatePackageJson(packages) {
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new SweepError("Package JSON must be an object");
  }
  if (!Array.isArray(packages.packages) || packages.packages.length === 0) {
    throw new SweepError("Package JSON must include at least one package");
  }
  for (const leafPackage of packages.packages) {
    if (!leafPackage?.leafId || !Array.isArray(leafPackage.txPackages)) {
      throw new SweepError("Each package must include leafId and txPackages");
    }
  }
  return packages;
}

function lastTxPackage(leafPackage) {
  return leafPackage.txPackages[leafPackage.txPackages.length - 1];
}

function candidateAccounts(accountNumber, defaults) {
  const values = [];
  if (accountNumber !== undefined && accountNumber !== null && accountNumber !== "") {
    const parsed = Number(accountNumber);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new SweepError("--account-number must be a non-negative integer");
    }
    values.push(parsed);
  }
  for (const value of defaults) {
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

function networkConfigFor(network) {
  const normalized = String(network ?? "").toUpperCase();
  const config = NETWORKS.get(normalized);
  if (!config) throw new SweepError(`Unsupported network for sweep: ${network}`);
  return config;
}

function validateFeeRate(feeRate) {
  const value = Number(feeRate);
  if (!Number.isFinite(value) || value <= 0) {
    throw new SweepError("--fee-rate must be a positive number");
  }
  return value;
}

function validateAddress(address, btcNetwork) {
  try {
    const tx = new Transaction({ allowUnknownOutputs: true });
    tx.addOutputAddress(address, 1n, btcNetwork);
  } catch (error) {
    throw new SweepError(`Invalid destination address for network: ${error.message}`);
  }
}
