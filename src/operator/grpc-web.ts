// Unary gRPC-web client over fetch, sufficient for the two Spark operator
// services the exporter calls. The Spark operators serve gRPC-web on the same
// URLs as native gRPC (the Spark SDK's browser/WASM builds use it), and unary
// calls need no response streaming, so plain fetch works everywhere.
//
// Mirrors app/self-custodial/recovery-bundle/protocol/grpc-web.ts in
// blink-mobile; keep the two in sync.

const GRPC_WEB_CONTENT_TYPE = "application/grpc-web+proto";
const TRAILER_FLAG = 0x80;
const CALL_TIMEOUT_MS = 30_000;

export class GrpcWebError extends Error {
  readonly grpcStatus: number | undefined;
  readonly httpStatus: number | undefined;

  constructor(
    grpcStatus: number | undefined,
    httpStatus: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GrpcWebError";
    this.grpcStatus = grpcStatus;
    this.httpStatus = httpStatus;
  }
}

function frameRequest(message: Uint8Array): Uint8Array {
  const framed = new Uint8Array(5 + message.length);
  framed[0] = 0;
  new DataView(framed.buffer).setUint32(1, message.length, false);
  framed.set(message, 5);
  return framed;
}

interface Frame {
  flag: number;
  payload: Uint8Array;
}

function parseFrames(body: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  let offset = 0;
  while (offset + 5 <= body.length) {
    const flag = body[offset]!;
    const length = new DataView(body.buffer, body.byteOffset + offset + 1, 4).getUint32(
      0,
      false,
    );
    offset += 5;
    if (offset + length > body.length) {
      throw new GrpcWebError(undefined, undefined, "grpc-web: truncated response frame");
    }
    frames.push({ flag, payload: body.subarray(offset, offset + length) });
    offset += length;
  }
  return frames;
}

function parseTrailers(payload: Uint8Array): Map<string, string> {
  const trailers = new Map<string, string>();
  for (const line of new TextDecoder().decode(payload).split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator !== -1) {
      trailers.set(
        line.slice(0, separator).trim().toLowerCase(),
        line.slice(separator + 1).trim(),
      );
    }
  }
  return trailers;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: Uint8Array;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

interface UnaryCallParams {
  baseUrl: string;
  /** Full method path, e.g. "/spark.SparkService/query_nodes". */
  methodPath: string;
  request: Uint8Array;
  /** Value for the `authorization` header, if the method requires a session. */
  authorization?: string;
  /** Injection seam for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export async function grpcWebUnaryCall({
  baseUrl,
  methodPath,
  request,
  authorization,
  fetchImpl = fetch as unknown as FetchLike,
}: UnaryCallParams): Promise<Uint8Array> {
  const headers: Record<string, string> = {
    "Content-Type": GRPC_WEB_CONTENT_TYPE,
    Accept: GRPC_WEB_CONTENT_TYPE,
    "X-Grpc-Web": "1",
    "X-User-Agent": "spark-unilateral-exit-recovery-bundle",
  };
  if (authorization) headers.Authorization = authorization;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  let response: Awaited<ReturnType<FetchLike>>;
  let body: Uint8Array;
  try {
    response = await fetchImpl(`${baseUrl}${methodPath}`, {
      method: "POST",
      headers,
      body: frameRequest(request),
      signal: controller.signal,
    });
    body = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new GrpcWebError(
      undefined,
      undefined,
      `grpc-web: ${methodPath} network error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new GrpcWebError(
      undefined,
      response.status,
      `grpc-web: ${methodPath} failed with HTTP ${response.status}`,
    );
  }

  // Trailers-only responses carry grpc-status in the HTTP headers
  const headerStatus = response.headers.get("grpc-status");
  if (headerStatus !== null && headerStatus !== "0") {
    throw new GrpcWebError(
      Number(headerStatus),
      response.status,
      `grpc-web: ${methodPath} failed with status ${headerStatus}: ${
        response.headers.get("grpc-message") ?? ""
      }`,
    );
  }

  let message: Uint8Array | undefined;
  for (const frame of parseFrames(body)) {
    // eslint-disable-next-line no-bitwise -- gRPC-web trailer flag is the high bit
    if (frame.flag & TRAILER_FLAG) {
      const trailers = parseTrailers(frame.payload);
      const status = trailers.get("grpc-status");
      if (status !== undefined && status !== "0") {
        throw new GrpcWebError(
          Number(status),
          response.status,
          `grpc-web: ${methodPath} failed with status ${status}: ${
            trailers.get("grpc-message") ?? ""
          }`,
        );
      }
    } else if (message === undefined) {
      message = frame.payload;
    }
  }

  if (message === undefined) {
    throw new GrpcWebError(
      undefined,
      response.status,
      `grpc-web: ${methodPath} returned no message frame`,
    );
  }
  return message;
}
