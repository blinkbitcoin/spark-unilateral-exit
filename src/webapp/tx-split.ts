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

  const walk = (segwit: boolean): number => {
    let p = o;
    const at2 = (i: number): number => {
      if (i >= raw.length) throw new Error("tx overrun");
      return raw[i]!;
    };
    const vi = (): number => {
      const first = at2(p);
      p += 1;
      if (first < 0xfd) return first;
      const len = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
      let value = 0;
      for (let i = 0; i < len; i += 1) value += at2(p + i) * 2 ** (8 * i);
      p += len;
      return value;
    };
    const skip = (): void => {
      // NOT `p += vi()`: compound assignment reads the old value of p
      // before evaluating the RHS, so vi()'s internal advance of p would
      // be overwritten and the varint prefix byte lost on every skip.
      const length = vi();
      p += length;
    };
    if (segwit) p += 2;
    const nIn = vi();
    for (let i = 0; i < nIn; i += 1) {
      p += 32 + 4;
      skip();
      p += 4;
    }
    const nOut = vi();
    for (let i = 0; i < nOut; i += 1) {
      p += 8;
      skip();
    }
    if (segwit) {
      for (let i = 0; i < nIn; i += 1) {
        // Stack count 0 is legal: inputs spending non-witness programs
        // carry an empty witness inside a segwit tx.
        const stacks = vi();
        for (let s = 0; s < stacks; s += 1) skip();
      }
    }
    p += 4;
    if (p > raw.length) throw new Error("tx overrun");
    return p;
  };

  o += 4; // version
  // Marker disambiguation: a legacy tx would read raw[4] as its input count,
  // and 0 inputs is invalid - so 00 01 at bytes 4-5 can only be the segwit
  // marker/flag. Legacy fallback covers only a structural walk failure.
  const maybeSegwit = u8(o) === 0x00 && u8(o + 1) === 0x01;
  if (maybeSegwit) {
    try {
      return walk(true);
    } catch {
      // structurally invalid segwit reading; fall through to legacy
    }
  }
  return walk(false);
}
