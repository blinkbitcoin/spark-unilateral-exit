import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  broadcastPackages,
  broadcastSweeps,
  checkTransactionStatus,
  EsploraError,
} from "../src/broadcast.ts";

describe("broadcastPackages", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("submits each txPackage as a 2-element package", async () => {
    const calls: Array<{ url: unknown; body: any }> = [];
    globalThis.fetch = vi.fn().mockImplementation((url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"txids":["t1"]}'),
      });
    });

    const packages = [
      {
        leafId: "leaf-1",
        txPackages: [
          { tx: "parenthex1", signedChildTx: "childhex1" },
          { tx: "parenthex2", signedChildTx: "childhex2" },
        ],
      },
    ];

    const results = await broadcastPackages({
      packages,
      network: "MAINNET",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toEqual(["parenthex1", "childhex1"]);
    expect(calls[1]!.body).toEqual(["parenthex2", "childhex2"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.leafId).toBe("leaf-1");
    expect(results[0]!.packages).toHaveLength(2);
  });

  it("calls onPackageSubmitted callback for each submission", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{}"),
    });

    const submitted: Array<{ leafId: string; packageIndex: number }> = [];
    await broadcastPackages({
      packages: [
        {
          leafId: "leaf-1",
          txPackages: [{ tx: "aa", signedChildTx: "bb" }],
        },
      ],
      network: "MAINNET",
      onPackageSubmitted: (entry) => submitted.push(entry),
    });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.leafId).toBe("leaf-1");
    expect(submitted[0]!.packageIndex).toBe(0);
  });

  it("throws when signedChildTx is missing", async () => {
    await expect(
      broadcastPackages({
        packages: [
          {
            leafId: "leaf-1",
            txPackages: [{ tx: "aa", feeBumpPsbt: "unsigned" }],
          },
        ],
        network: "MAINNET",
      }),
    ).rejects.toThrow("signedChildTx");
  });

  it("throws when tx field is missing", async () => {
    await expect(
      broadcastPackages({
        packages: [
          {
            leafId: "leaf-1",
            txPackages: [{ signedChildTx: "bb" }],
          },
        ],
        network: "MAINNET",
      }),
    ).rejects.toThrow("missing the tx field");
  });

  it("throws for invalid package structure", async () => {
    await expect(
      broadcastPackages({
        packages: [{ leafId: null }],
        network: "MAINNET",
      }),
    ).rejects.toThrow("Invalid package");
  });

  it("uses custom esplora URL", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{}"),
    });

    await broadcastPackages({
      packages: [
        {
          leafId: "leaf-1",
          txPackages: [{ tx: "aa", signedChildTx: "bb" }],
        },
      ],
      network: "REGTEST",
      esploraUrl: "http://localhost:3000",
    });

    expect(vi.mocked(globalThis.fetch).mock.calls[0]![0]).toBe(
      "http://localhost:3000/txs/package",
    );
  });

  it("propagates Esplora HTTP errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("bad-txns-inputs-missingorspent"),
    });

    await expect(
      broadcastPackages({
        packages: [
          {
            leafId: "leaf-1",
            txPackages: [{ tx: "aa", signedChildTx: "bb" }],
          },
        ],
        network: "MAINNET",
      }),
    ).rejects.toThrow(EsploraError);
  });
});

describe("broadcastSweeps", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("broadcasts each sweep transaction", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(`txid-${callCount}`),
      });
    });

    const results = await broadcastSweeps({
      sweeps: [
        { leafId: "leaf-1", sweepTx: "aabbcc", sweepTxid: "txid-1" },
        { leafId: "leaf-2", sweepTx: "ddeeff", sweepTxid: "txid-wrong" },
      ],
      network: "MAINNET",
    });

    expect(results).toHaveLength(2);
    expect(results[0]!).toMatchObject({
      leafId: "leaf-1",
      sweepTxid: "txid-1",
      match: true,
    });
    expect(results[1]!).toMatchObject({
      leafId: "leaf-2",
      sweepTxid: "txid-2",
      match: false,
    });
  });

  it("throws when sweepTx is missing", async () => {
    await expect(
      broadcastSweeps({
        sweeps: [{ leafId: "leaf-1" }],
        network: "MAINNET",
      }),
    ).rejects.toThrow("missing sweepTx");
  });
});

describe("checkTransactionStatus", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns found=false for unknown transaction", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Transaction not found"),
    });

    const status = await checkTransactionStatus({
      txid: "abc123",
      network: "MAINNET",
    });

    expect(status).toEqual({
      txid: "abc123",
      found: false,
      confirmed: false,
    });
  });

  it("returns confirmed status for mined transaction", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          txid: "abc123",
          status: {
            confirmed: true,
            block_height: 850000,
            block_hash: "00000000000000000002abc",
          },
        }),
    });

    const status = await checkTransactionStatus({
      txid: "abc123",
      network: "MAINNET",
    });

    expect(status).toEqual({
      txid: "abc123",
      found: true,
      confirmed: true,
      blockHeight: 850000,
      blockHash: "00000000000000000002abc",
    });
  });

  it("returns unconfirmed status for mempool transaction", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          txid: "abc123",
          status: { confirmed: false },
        }),
    });

    const status = await checkTransactionStatus({
      txid: "abc123",
      network: "MAINNET",
    });

    expect(status).toEqual({
      txid: "abc123",
      found: true,
      confirmed: false,
      blockHeight: null,
      blockHash: null,
    });
  });
});
