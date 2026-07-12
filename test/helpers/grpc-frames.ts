// Test-side gRPC-web frame builders shared by the operator-client tests and
// the mocked-operator recovery-bundle tests.

import { concatBytes } from "@noble/curves/utils";

export function frame(flag: number, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(5 + payload.length);
  framed[0] = flag;
  new DataView(framed.buffer).setUint32(1, payload.length, false);
  framed.set(payload, 5);
  return framed;
}

/** A complete unary response body: one message frame plus an OK trailer. */
export function grpcBody(message: Uint8Array): Uint8Array {
  return concatBytes(frame(0, message), frame(0x80, textBytes("grpc-status: 0")));
}

export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export { concatBytes };
