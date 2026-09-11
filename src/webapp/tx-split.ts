// Byte-exact transaction splitter for serialized Bitcoin blocks.
//
// Walks the segwit layout directly: [marker/flag] nIn (outpoint+scriptsig+seq)
// nOut (value+script) [witness stacks] locktime. Returns each tx's exact byte
// length so callers can advance a cursor without re-serialization. Throws on
// structural overrun so callers can fall back rather than mis-split.
export function rawTxLength(raw: Uint8Array): number {
  let o = 0;
  const u8 = (i: number): number => {
    if (i >= raw.length) throw new Error("tx overrun");
    return raw[i]!;
  };
  const varint = (): number => {
    const first = u8(o);
    o += 1;
    if (first < 0xfd) return first;
    const len = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    let value = 0;
    for (let i = 0; i < len; i += 1) value += u8(o + i) * 2 ** (8 * i);
    o += len;
    return value;
  };
  const skipVarlen = (): void => {
    o += varint();
  };

  const version = u8(o) + u8(o + 1) * 256;
  o += 4;
  let segwit = false;
  if (u8(o) === 0x00 && u8(o + 1) === 0x01) {
    segwit = true;
    o += 2;
  }
  const nIn = varint();
  for (let i = 0; i < nIn; i += 1) {
    o += 32; // prev txid
    o += 4; // vout
    skipVarlen(); // scriptsig
    o += 4; // sequence
  }
  const nOut = varint();
  for (let i = 0; i < nOut; i += 1) {
    o += 8; // value
    skipVarlen(); // script
  }
  if (segwit) {
    for (let i = 0; i < nIn; i += 1) {
      const stacks = varint();
      for (let s = 0; s < stacks; s += 1) skipVarlen();
    }
  }
  o += 4; // locktime
  if (o > raw.length) throw new Error("tx overrun");
  return o;
}
