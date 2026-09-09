import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  EsploraError,
  esploraBaseUrl,
  submitPackage,
  broadcastTransaction,
  getTransaction,
  getOutspend,
} from "../src/esplora.ts";

describe("esploraBaseUrl", () => {
  it("returns default mainnet URL", () => {
    expect(esploraBaseUrl("MAINNET")).toBe("https://blockstream.info/api");
  });

  it("returns default testnet URL", () => {
    expect(esploraBaseUrl("TESTNET")).toBe(
      "https://blockstream.info/testnet/api",
    );
  });

  it("returns default signet URL", () => {
    expect(esploraBaseUrl("SIGNET")).toBe("https://mempool.space/signet/api");
  });

  it("is case-insensitive", () => {
    expect(esploraBaseUrl("mainnet")).toBe("https://blockstream.info/api");
  });

  it("uses custom URL when provided", () => {
    expect(esploraBaseUrl("MAINNET", "https://my-esplora.example.com/api/")).toBe(
      "https://my-esplora.example.com/api",
    );
  });

  it("strips trailing slashes from custom URL", () => {
    expect(esploraBaseUrl("MAINNET", "https://example.com///")).toBe(
      "https://example.com",
    );
  });

  it("throws for unsupported network without custom URL", () => {
    expect(() => esploraBaseUrl("REGTEST")).toThrow(EsploraError);
    expect(() => esploraBaseUrl("LOCAL")).toThrow(EsploraError);
  });

  it("allows unsupported network with custom URL", () => {
    expect(esploraBaseUrl("REGTEST", "http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
  });
});

describe("submitPackage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects arrays with fewer than 2 transactions", async () => {
    await expect(submitPackage(["deadbeef"], "https://example.com")).rejects.toThrow(
      "at least 2",
    );
  });

  it("rejects non-array input", async () => {
    await expect(submitPackage("deadbeef", "https://example.com")).rejects.toThrow(
      "at least 2",
    );
  });

  it("posts JSON array to /txs/package", async () => {
    const mockResponse = { ok: true, status: 200, text: () => Promise.resolve("{}") };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await submitPackage(["aabb", "ccdd"], "https://blockstream.info/api");

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, options] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://blockstream.info/api/txs/package");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(options.body)).toEqual(["aabb", "ccdd"]);
  });

  it("returns parsed JSON on success", async () => {
    const result = { txids: ["abc123"] };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(result)),
    });

    const response = await submitPackage(["aa", "bb"], "https://example.com");
    expect(response).toEqual(result);
  });

  it("throws EsploraError on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("bad-txns-inputs-missingorspent"),
    });

    await expect(
      submitPackage(["aa", "bb"], "https://example.com"),
    ).rejects.toThrow(EsploraError);
  });

  // Bitcoin Core's submitpackage reports policy rejections with HTTP 200; the
  // verdict is package_msg plus per-transaction error strings. This is the
  // exact response a mainnet mempool.space returned for a package whose parent
  // input had already been spent, which the tool used to misread as a
  // successful submit followed by a mempool eviction.
  it("throws when the node rejects the package inside an HTTP 200", async () => {
    const wtxid = "ab".repeat(32);
    const txid = "cd".repeat(32);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            package_msg: "transaction failed",
            "tx-results": {
              [wtxid]: { txid, error: "bad-txns-inputs-missingorspent" },
            },
            "replaced-transactions": [],
          }),
        ),
    });

    const error = (await submitPackage(["aa", "bb"], "https://example.com").catch(
      (e) => e,
    )) as EsploraError;
    expect(error).toBeInstanceOf(EsploraError);
    expect(error.message).toContain("transaction failed");
    expect(error.message).toContain(txid);
    expect(error.message).toContain("bad-txns-inputs-missingorspent");
  });

  it("accepts a package_msg success verdict", async () => {
    const verdict = {
      package_msg: "success",
      "tx-results": {
        ["ab".repeat(32)]: { txid: "cd".repeat(32), vsize: 111 },
      },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(verdict)),
    });

    await expect(submitPackage(["aa", "bb"], "https://example.com")).resolves.toEqual(
      verdict,
    );
  });

  it("throws EsploraError on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      submitPackage(["aa", "bb"], "https://example.com"),
    ).rejects.toThrow(EsploraError);
  });

  it("throws EsploraError on timeout", async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, options) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    await expect(
      submitPackage(["aa", "bb"], "https://example.com"),
    ).rejects.toThrow("timed out");
  }, 35_000);
});

describe("broadcastTransaction", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects empty input", async () => {
    await expect(broadcastTransaction("", "https://example.com")).rejects.toThrow(
      "non-empty",
    );
  });

  it("posts raw hex to /tx", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("abc123def456"),
    });

    const txid = await broadcastTransaction("deadbeef", "https://example.com");
    expect(txid).toBe("abc123def456");

    const [url, options] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://example.com/tx");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("text/plain");
    expect(options.body).toBe("deadbeef");
  });

  it("throws on rejection", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Transaction already in block chain"),
    });

    const error = await broadcastTransaction(
      "deadbeef",
      "https://example.com",
    ).catch((e) => e);
    expect(error).toBeInstanceOf(EsploraError);
    expect(error.status).toBe(400);
    expect(error.body).toContain("already in block chain");
  });
});

describe("getTransaction", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null for 404", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Transaction not found"),
    });

    const result = await getTransaction("abc123", "https://example.com");
    expect(result).toBeNull();
  });

  it("returns parsed transaction on success", async () => {
    const txData = {
      txid: "abc123",
      status: { confirmed: true, block_height: 800000 },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(txData),
    });

    const result = await getTransaction("abc123", "https://example.com");
    expect(result).toEqual(txData);
  });

  it("throws on server error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    await expect(
      getTransaction("abc123", "https://example.com"),
    ).rejects.toThrow(EsploraError);
  });
});

describe("getOutspend", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches /tx/:txid/outspend/:vout and returns the parsed outspend", async () => {
    const outspend = {
      spent: true,
      txid: "def456",
      vin: 0,
      status: { confirmed: true, block_height: 800000 },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(outspend),
    });
    globalThis.fetch = fetchMock;

    const result = await getOutspend("abc123", 2, "https://example.com");
    expect(result).toEqual(outspend);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/tx/abc123/outspend/2",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns null for 404 so callers can try the other byte-order candidate", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Transaction not found"),
    });

    const result = await getOutspend("abc123", 0, "https://example.com");
    expect(result).toBeNull();
  });

  it("throws EsploraError on server error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve("Bad Gateway"),
    });

    await expect(
      getOutspend("abc123", 0, "https://example.com"),
    ).rejects.toThrow(EsploraError);
  });
});
