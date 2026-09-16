import { test, expect, type ElectronApplication } from "@playwright/test";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";
import { ProtoWriter } from "../../src/operator/wire.ts";
import { grpcBody } from "../../test/helpers/grpc-frames.ts";
import { bundle, wallet, PASSWORD } from "../../test/desktop/helpers.ts";
import { encryptBackup } from "../vault.ts";
import { launch } from "./helpers.ts";

test("saved bundle check uses real IPC and read-only operator export", async ({}, testInfo) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spark-freshness-ui-"));
  let app: ElectronApplication | undefined;
  const seen: string[] = [];
  let offline = false;
  const saved = bundle(), node = TreeNode.decode(Buffer.from(saved.leaves[0]!.treeNodeHex, "hex"));
  node.status = "AVAILABLE"; node.treenodeStatus = 1;
  saved.leaves[0]!.treeNodeHex = Buffer.from(TreeNode.encode(node).finish()).toString("hex");
  let observed = node;
  await writeFile(path.join(directory, "tls.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", path.join(directory, "tls.cnf"), "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem")], { stdio: "ignore" });
  const cert = await readFile(path.join(directory, "cert.pem"), "utf8");
  const server = https.createServer({ cert, key: await readFile(path.join(directory, "key.pem")) }, (req, res) => {
    seen.push(req.url!); req.resume();
    if (offline) { res.writeHead(503); res.end("Disposable test coordinator offline"); return; }
    let response: Uint8Array;
    if (req.url!.endsWith("/get_challenge")) {
      const challenge = new ProtoWriter().varint(1, 1).varint(2, 9999999999).bytes(3, new Uint8Array(32).fill(17)).finish();
      response = new ProtoWriter().bytes(1, new ProtoWriter().varint(1, 1).bytes(2, challenge).bytes(3, new Uint8Array(32).fill(170)).finish()).finish();
    } else if (req.url!.endsWith("/verify_challenge")) {
      response = new ProtoWriter().string(1, "disposable-test-token").varint(2, 9999999999).finish();
    } else if (req.url!.endsWith("/query_nodes")) {
      response = new ProtoWriter().bytes(1, new ProtoWriter().string(1, observed.id).bytes(2, TreeNode.encode(observed).finish()).finish()).finish();
    } else { res.writeHead(400); res.end(); return; }
    res.writeHead(200, { "content-type": "application/grpc-web+proto" }); res.end(grpcBody(response));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const state = wallet(); state.bundle = saved;
    state.settings = { ...state.settings, network: "LOCAL", coordinatorUrl: `https://127.0.0.1:${port}`, coordinatorCa: cert };
    const filename = path.join(directory, "vault.json");
    await writeFile(filename, await encryptBackup({ version: 2, activeProfileId: "test", profiles: [{ id: "test", label: "DISPOSABLE SYNTHETIC TEST WALLET", wallet: state }] }, PASSWORD));
    app = await launch(directory);
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(directory);
    const page = await app.firstWindow();
    await page.locator("#password").fill(PASSWORD); await page.locator("#vault-submit").click();
    await expect(page.locator("#workspace")).toBeVisible();
    const ciphertext = await readFile(filename, "utf8");
    const capture = async (name: string) => {
      const destination = process.env.SPARK_FRESHNESS_SCREENSHOTS || testInfo.outputPath("screenshots");
      await mkdir(destination, { recursive: true }); await page.screenshot({ path: path.join(destination, `${name}.png`) });
    };
    await page.getByRole("button", { name: "Check saved bundle", exact: true }).click({ timeout: 5000 });
    await expect(page.locator("#freshness-result")).toContainText("Matches the latest observed coordinator snapshot");
    await expect(page.locator("#freshness-evidence")).toContainText("Saved leaves: 1");
    expect(seen.filter((url) => url.endsWith("/query_nodes"))).toHaveLength(2);
    await capture("matching");
    observed = { ...node, id: "same-balance-replacement", refundTx: new Uint8Array([2]) };
    await page.getByRole("button", { name: "Check saved bundle", exact: true }).click();
    await expect(page.locator("#freshness-result")).toContainText("differs");
    await capture("stale-same-balance");
    offline = true;
    await page.getByRole("button", { name: "Check saved bundle", exact: true }).click();
    await expect(page.locator("#freshness-result")).toContainText("unavailable");
    await capture("offline-unknown");
    expect(await readFile(filename, "utf8")).toBe(ciphertext);
    expect(seen.every((url) => /\/(get_challenge|verify_challenge|query_nodes)$/.test(url))).toBe(true);
    const status = await page.evaluate(async () => (await (window as any).recovery.status()).value);
    expect(status.session).toBeUndefined(); expect(status.bundle.leaves[0].id).toBe("leaf");
    expect(status.bundleFreshness.status).toBe("unknown");
    const requestsBeforeInvalid = seen.length;
    await writeFile(filename, "corrupted disposable test vault");
    await page.getByRole("button", { name: "Check saved bundle", exact: true }).click();
    await expect(page.locator("#freshness-result")).toContainText("Invalid saved bundle");
    expect(seen).toHaveLength(requestsBeforeInvalid);
    expect(await readFile(filename, "utf8")).toBe("corrupted disposable test vault");
    await capture("invalid-saved-vault");
  } finally {
    await app?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
