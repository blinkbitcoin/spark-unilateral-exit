import { describe, expect, it } from "vitest";

import {
  GrpcWebError,
  grpcWebUnaryCall,
  type FetchLike,
} from "../../src/operator/grpc-web.ts";

function frame(flag: number, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(5 + payload.length);
  framed[0] = flag;
  new DataView(framed.buffer).setUint32(1, payload.length, false);
  framed.set(payload, 5);
  return framed;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

interface MockResponse {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

function mockFetch({ ok = true, status = 200, headers = {}, body }: MockResponse): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; init: Parameters<FetchLike>[1] }>;
} {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const payload = body ?? new Uint8Array(0);
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      arrayBuffer: async () =>
        payload.buffer.slice(
          payload.byteOffset,
          payload.byteOffset + payload.byteLength,
        ) as ArrayBuffer,
    };
  };
  return { fetchImpl, calls };
}

describe("grpcWebUnaryCall", () => {
  const params = {
    baseUrl: "https://operator.example",
    methodPath: "/spark.SparkService/query_nodes",
    request: Uint8Array.from([1, 2, 3]),
  };

  it("frames the request and returns the message frame", async () => {
    const message = Uint8Array.from([9, 8, 7]);
    const { fetchImpl, calls } = mockFetch({
      body: concat(frame(0, message), frame(0x80, textBytes("grpc-status: 0"))),
    });

    const result = await grpcWebUnaryCall({
      ...params,
      authorization: "Bearer tok",
      fetchImpl,
    });
    expect(Uint8Array.from(result)).toEqual(message);

    const call = calls[0]!;
    expect(call.url).toBe("https://operator.example/spark.SparkService/query_nodes");
    expect(call.init.headers["Content-Type"]).toBe("application/grpc-web+proto");
    expect(call.init.headers.Authorization).toBe("Bearer tok");
    // 5-byte prefix: flag 0 + big-endian length 3
    expect(call.init.body).toEqual(Uint8Array.from([0, 0, 0, 0, 3, 1, 2, 3]));
  });

  it("throws on non-zero grpc-status in trailers", async () => {
    const { fetchImpl } = mockFetch({
      body: concat(
        frame(0, Uint8Array.from([1])),
        frame(0x80, textBytes("grpc-status: 16\r\ngrpc-message: unauthenticated")),
      ),
    });
    await expect(grpcWebUnaryCall({ ...params, fetchImpl })).rejects.toThrow(
      /status 16.*unauthenticated/,
    );
  });

  it("throws on trailers-only responses with grpc-status in HTTP headers", async () => {
    const { fetchImpl } = mockFetch({
      headers: { "grpc-status": "5", "grpc-message": "not found" },
    });
    await expect(grpcWebUnaryCall({ ...params, fetchImpl })).rejects.toMatchObject({
      grpcStatus: 5,
    });
  });

  it("throws on HTTP errors", async () => {
    const { fetchImpl } = mockFetch({ ok: false, status: 503 });
    await expect(grpcWebUnaryCall({ ...params, fetchImpl })).rejects.toMatchObject({
      httpStatus: 503,
    });
  });

  it("throws when no message frame is present", async () => {
    const { fetchImpl } = mockFetch({ body: frame(0x80, textBytes("grpc-status: 0")) });
    await expect(grpcWebUnaryCall({ ...params, fetchImpl })).rejects.toThrow(
      /no message frame/,
    );
  });

  it("wraps network failures in GrpcWebError", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("boom");
    };
    await expect(grpcWebUnaryCall({ ...params, fetchImpl })).rejects.toBeInstanceOf(
      GrpcWebError,
    );
  });
});
