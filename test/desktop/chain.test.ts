import { describe, expect, it, vi } from "vitest";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Transaction } from "@scure/btc-signer";
import { bytesToHex } from "@noble/curves/utils";
import { LocalChain, RpcError, coordinatorFetch, parseTx } from "../../desktop/chain.ts";

function raw(sequence = 0xffffffff, version = 2): string {
  const tx = new Transaction({ version, allowUnknownInputs: true, allowUnknownOutputs: true });
  tx.addInput({ txid: "11".repeat(32), index: 0, sequence });
  tx.addOutput({ script: new Uint8Array([0x51]), amount: 100n });
  return bytesToHex(tx.toBytes(true, true));
}
describe("local Bitcoin chain adapter", () => {
  it("pins RPC to loopback, checks regtest and rejects errors", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ result: { chain: "regtest" }, error: null })));
    const chain = new LocalChain(request); await chain.verify();
    expect((request.mock.calls[0] as any)[0]).toBe("http://127.0.0.1:8332");
    expect((request.mock.calls[0] as any)[1].redirect).toBe("error");
    request.mockResolvedValueOnce(new Response(JSON.stringify({ result: { chain: "main" } })));
    await expect(chain.verify()).rejects.toThrow("not on regtest");
    request.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: -1, message: "secret" } })));
    await expect(chain.rpc("fail")).rejects.toThrow("failed (-1)");
    request.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(chain.rpc("fail")).rejects.toThrow("unavailable");
  });
  it("distinguishes absent transactions, mempool, confirmations and transport errors", async () => {
    const chain = new LocalChain(); const rpc = vi.spyOn(chain, "rpc");
    rpc.mockResolvedValueOnce({ confirmations: 3 }); expect(await chain.status("id")).toEqual({ confirmations: 3 });
    rpc.mockResolvedValueOnce({}); expect(await chain.status("id")).toEqual({ confirmations: 0 });
    rpc.mockRejectedValueOnce(new RpcError(-5, "missing")); expect(await chain.status("id")).toBeNull();
    rpc.mockRejectedValueOnce(new Error("offline")); await expect(chain.status("id")).rejects.toThrow("offline");
    rpc.mockResolvedValueOnce({ unspents: [] }); expect(await chain.funding("address")).toEqual({ unspents: [] });
    rpc.mockResolvedValueOnce("id"); await chain.broadcast("00"); expect(rpc).toHaveBeenLastCalledWith("sendrawtransaction", ["00"]);
    rpc.mockResolvedValueOnce({ package_msg: "success" }); await chain.submit("parent", "child");
    rpc.mockResolvedValueOnce({ package_msg: "success", "tx-results": { a: {} } }); await chain.submit("p", "c");
    for (const result of [{ package_msg: "rejected" }, { package_msg: "success", "tx-results": { a: { error: "bad" } } }]) {
      rpc.mockResolvedValueOnce(result); await expect(chain.submit("p", "c")).rejects.toThrow("not accepted");
    }
  });
  it("enforces relative locks using parent confirmations", async () => {
    const chain = new LocalChain(); const status = vi.spyOn(chain, "status");
    expect(parseTx(raw()).inputsLength).toBe(1);
    expect(await chain.maturity(raw())).toBeNull();
    expect(await chain.maturity(raw(100, 1))).toBeNull();
    await expect(chain.maturity(raw(0x00400001))).rejects.toThrow("Time-based");
    status.mockResolvedValueOnce(null); expect(await chain.maturity(raw(100))).toContain("parent");
    status.mockResolvedValueOnce({ confirmations: 0 }); expect(await chain.maturity(raw(100))).toContain("parent");
    status.mockResolvedValueOnce({ confirmations: 20 }); expect(await chain.maturity(raw(100))).toContain("80");
    expect(status).toHaveBeenLastCalledWith("11".repeat(32));
    status.mockResolvedValueOnce({ confirmations: 100 }); expect(await chain.maturity(raw(100))).toBeNull();
    // Raw transactions always have these fields; explicitly exercise the
    // defensive checks at the parser boundary as well.
    const getInput = vi.spyOn(Transaction.prototype, "getInput");
    getInput.mockReturnValueOnce({ sequence: undefined }); expect(await chain.maturity(raw())).toBeNull();
    getInput.mockReturnValueOnce({ sequence: 1 }); await expect(chain.maturity(raw())).rejects.toThrow("no parent");
    getInput.mockRestore();
  });
  it("uses explicit CA trust and bounds coordinator responses", async () => {
    let next: (request: EventEmitter, response: EventEmitter & Record<string, any>) => void;
    const requestSpy = vi.spyOn(https, "request").mockImplementation((...args: any[]) => {
      const request = new EventEmitter() as any;
      request.end = () => {
        const response = new EventEmitter() as any;
        response.headers = { "grpc-status": "0" }; response.statusCode = 200;
        response.destroy = (error: Error) => response.emit("error", error);
        args[2](response); next(request, response);
      };
      return request;
    });
    const init = { method: "POST", headers: {}, body: new Uint8Array([1]), signal: AbortSignal.timeout(1000) };
    try {
      next = (_req, res) => { res.emit("data", Buffer.from([1, 2])); res.emit("end"); };
      const response = await coordinatorFetch("certificate")("https://localhost", init);
      expect((requestSpy.mock.calls[0] as any)[1].ca).toBe("certificate");
      expect((requestSpy.mock.calls[0] as any)[1].allowPartialTrustChain).toBe(true);
      expect((requestSpy.mock.calls[0] as any)[1].rejectUnauthorized).not.toBe(false);
      expect(response.ok).toBe(true); expect(response.headers.get("grpc-status")).toBe("0"); expect(response.headers.get("absent")).toBeNull();
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
      next = (_req, res) => { res.statusCode = undefined; res.emit("end"); };
      expect((await coordinatorFetch("")("https://localhost", init)).status).toBe(500);
      next = (_req, res) => { res.emit("data", Buffer.alloc(32 * 1024 * 1024 + 1)); };
      await expect(coordinatorFetch("")("https://localhost", init)).rejects.toThrow("too large");
      next = (req) => { req.emit("error", new Error("TLS failure")); };
      await expect(coordinatorFetch("")("https://localhost", init)).rejects.toThrow("TLS failure");
    } finally { requestSpy.mockRestore(); }
  });
});
