export class CpfpUtxoParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "CpfpUtxoParseError";
  }
}

export function parseCpfpUtxo(input) {
  const parts = input.split(":");
  if (parts.length !== 5) {
    throw new CpfpUtxoParseError(
      "CPFP UTXO must use txid:vout:value:script:publicKey format",
    );
  }

  const [txid, voutRaw, valueRaw, script, publicKey] = parts;
  if (!isHex(txid) || txid.length !== 64) {
    throw new CpfpUtxoParseError("CPFP UTXO txid must be 32-byte hex");
  }
  const vout = Number(voutRaw);
  if (!Number.isSafeInteger(vout) || vout < 0) {
    throw new CpfpUtxoParseError("CPFP UTXO vout must be a non-negative integer");
  }
  let value;
  try {
    value = BigInt(valueRaw);
  } catch {
    throw new CpfpUtxoParseError("CPFP UTXO value must be a positive integer");
  }
  if (value <= 0n) {
    throw new CpfpUtxoParseError("CPFP UTXO value must be positive");
  }
  if (!isHex(script)) {
    throw new CpfpUtxoParseError("CPFP UTXO script must be hex");
  }
  if (!isHex(publicKey)) {
    throw new CpfpUtxoParseError("CPFP UTXO publicKey must be hex");
  }

  return { txid, vout, value, script, publicKey };
}

export function serializeForJson(value) {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function isHex(value) {
  return typeof value === "string" && value.length > 0 && /^[0-9a-fA-F]+$/.test(value);
}
