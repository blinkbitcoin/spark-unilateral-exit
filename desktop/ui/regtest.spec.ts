import { test, expect, type ElectronApplication } from "@playwright/test";
import { launch } from "./helpers.ts";
import { BitcoinFaucet, SparkWalletTesting, createNewTree, signerTypes } from "@buildonspark/spark-sdk/test-utils";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { bytesToHex, hexToBytes } from "@noble/curves/utils";
import { REGTEST } from "../validation.ts";
import { LocalChain } from "../chain.ts";
const exec = promisify(execFile);
const PASSWORD = "disposable regtest vault password";
test("regtest: background refresh saves two independent seeds in one encrypted vault", async () => {
  test.skip(process.env.RUN_DESKTOP_REGTEST !== "1", "Start the isolated stack first.");
  test.setTimeout(300_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "spark-desktop-regtest-multiple-"));
  const wallets: SparkWalletTesting[] = [];
  let app: ElectronApplication | undefined;
  try {
    await exec("bash", ["scripts/desktop-regtest.sh", "online"]);
    await exec("node", ["scripts/wait-for-spark-local.mjs"]);
    process.env.SPARK_DANGEROUSLY_DISABLE_TLS_VERIFICATION = "true";
    const seeds: string[] = [];
    const faucet = BitcoinFaucet.getInstance();
    for (const amount of [100_000n, 200_000n]) {
      const fixture = await SparkWalletTesting.initialize({ accountNumber: 1, options: { network: "LOCAL" }, signer: new signerTypes[0]!.Signer() });
      wallets.push(fixture.wallet); seeds.push(fixture.mnemonic!);
      await createNewTree(fixture.wallet, randomUUID(), faucet, amount);
      await expect.poll(async () => { await fixture.wallet.experimental_syncWallet?.(); return (await fixture.wallet.getLeaves()).length; }, { timeout: 60_000 }).toBe(1);
    }
    const { stdout: certificate } = await exec("docker", ["exec", "spark-desktop-pilot-spark-operator-0-1", "cat", "/opt/spark/tls/server_0.crt"]);
    app = await launch(directory, true); let page = await app.firstWindow();
    await page.locator("#seed").fill(seeds[0]!); await page.locator("#password").fill(PASSWORD); await page.locator("#vault-submit").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.locator("#settings-details > summary").click(); await page.locator("#ca").fill(certificate); await page.locator("#settings-form button").click();
    await expect(page.locator("#feedback")).toContainText("settings saved");
    const first = await page.locator("#profile-select").inputValue();
    await page.locator("#profiles-tab").click(); await page.locator("#additional-label").fill("Second regtest seed"); await page.locator("#additional-seed").fill(seeds[1]!); await page.locator("#profile-add").click();
    await expect(page.locator("#profile-select option")).toHaveCount(2);
    const second = await page.locator("#profile-select").inputValue();
    await page.locator("#ca").fill(certificate); await page.locator("#settings-form button").click();
    await expect(page.locator("#feedback")).toContainText("settings saved");
    await page.locator("#settings-details > summary").click(); await page.locator("#refresh-options > summary").click();
    await page.locator("#keep-unlocked").check(); await page.locator("#auto-refresh").check();
    await expect.poll(async () => (await page.evaluate(async () => (await window.recovery.status!()).value)).profiles.every((profile: any) => !!profile.bundleCreatedAt), { timeout: 90_000 }).toBe(true);
    await expect(page.locator("#backup-summary")).toContainText("200,000");
    await page.locator("#profile-select").selectOption(first); await expect(page.locator("#backup-summary")).toContainText("100,000");
    const firstAddress = await page.locator("#funding-address").textContent();
    await page.locator("#profile-select").selectOption(second); await expect(page.locator("#backup-summary")).toContainText("200,000");
    expect(await page.locator("#funding-address").textContent()).not.toBe(firstAddress);
    await app.close(); app = await launch(directory, true); page = await app.firstWindow();
    await page.locator("#password").fill(PASSWORD); await page.locator("#vault-submit").click();
    await expect(page.locator("#backup-summary")).toContainText("200,000");
    await page.locator("#profile-select").selectOption(first); await expect(page.locator("#backup-summary")).toContainText("100,000");
  } finally {
    await app?.close(); for (const wallet of wallets) await wallet.cleanup?.();
    await rm(directory, { recursive: true, force: true });
  }
});
test("regtest: refresh, encrypted export/import, offline exit and restart through confirmed sweep", async () => {
  test.skip(process.env.RUN_DESKTOP_REGTEST !== "1", "Start the isolated stack with scripts/desktop-regtest.sh up first.");
  test.setTimeout(600_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "spark-desktop-regtest-"));
  let app: ElectronApplication | undefined;
  let wallet: SparkWalletTesting | undefined;
  const start = () => launch(directory, true);
  try {
    await exec("bash", ["scripts/desktop-regtest.sh", "online"]);
    await exec("node", ["scripts/wait-for-spark-local.mjs"]);
    // The upstream fixture wallet needs all local self-signed operator certs.
    // This switch is confined to test setup; the Electron app explicitly deletes it.
    process.env.SPARK_DANGEROUSLY_DISABLE_TLS_VERIFICATION = "true";
    const fixture = await SparkWalletTesting.initialize({ accountNumber: 1, options: { network: "LOCAL" }, signer: new signerTypes[0]!.Signer() });
    console.log("Regtest wallet initialized");
    wallet = fixture.wallet;
    const faucet = BitcoinFaucet.getInstance();
    await createNewTree(wallet, randomUUID(), faucet, 100_000n);
    await expect.poll(async () => { await wallet!.experimental_syncWallet?.(); return (await wallet!.getLeaves()).length; }, { timeout: 60_000 }).toBe(1);
    console.log("Regtest deposit claimed");
    const { stdout: certificate } = await exec("docker", ["exec", "spark-desktop-pilot-spark-operator-0-1", "cat", "/opt/spark/tls/server_0.crt"]);
    app = await start(); let page = await app.firstWindow();
    await page.locator("#seed").fill(fixture.mnemonic!); await page.locator("#password").fill(PASSWORD); await page.locator("#vault-submit").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.locator("#settings-details > summary").click(); await page.locator("#ca").fill(certificate); await page.locator("#settings-form button").click();
    await expect(page.locator("#feedback")).toContainText("settings saved");
    expect(await page.evaluate(async () => (await window.recovery.status!()).value.settings.coordinatorCa)).toBe(certificate);
    await page.locator("#settings-details > summary").click();
    await page.locator("#refresh").click(); await expect(page.locator("#refresh")).toBeEnabled({ timeout: 60_000 });
    await expect(page.locator("#feedback")).toContainText("Recovery bundle refreshed");
    await expect(page.locator("#backup-summary")).toContainText("100,000");
    const backup = path.join(directory, "export.json");
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, backup);
    await page.locator("#backup-password").fill(PASSWORD); await page.locator("#export").click(); await expect(page.locator("#export")).toBeEnabled();
    await wallet.cleanup?.(); wallet = undefined;
    await exec("bash", ["scripts/desktop-regtest.sh", "offline"]);
    await page.locator("#backup-password").fill(PASSWORD); await page.locator("#import").click(); await expect(page.locator("#feedback")).toContainText("Recovery bundle imported");
    await page.locator("#refresh").click(); await expect(page.locator("#refresh")).toBeEnabled();
    await expect(page.locator("#backup-summary")).toContainText("100,000");
    const destination = await faucet.getNewAddress();
    await page.locator("#recover-tab").click();
    await page.locator("#destination").fill(destination); await page.locator("#estimate").click(); await expect(page.locator("#estimate")).toBeEnabled({ timeout: 60_000 });
    console.log(`Regtest estimate: ${await page.locator("#feedback").textContent()}`);
    await expect(page.locator("#estimate-result")).toContainText("Fund at least");
    const feeAddress = (await page.locator("#funding-address").textContent())!;
    await faucet.sendToAddress(feeAddress, 50_000n); await faucet.mineBlocksAndWaitForMiningToComplete(6);
    await page.locator("#recover-form button[type=submit]").click(); await expect(page.locator("#recover-form button[type=submit]")).toBeEnabled({ timeout: 60_000 });
    console.log(`Regtest preparation: ${await page.locator("#feedback").textContent()}`);
    await expect(page.locator("#recovery-session")).toBeVisible(); await expect(page.locator("#session-title")).toHaveText("Review unilateral exit");
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await page.locator("#approve").click(); await expect(page.locator("#session-title")).toHaveText("Unilateral exit in progress");
    // Simulate application shutdown after durable approval, before completion.
    await app.close(); app = await start(); page = await app.firstWindow();
    await expect(page.locator("#vault-submit")).toHaveText("Unlock vault");
    await page.locator("#password").fill(PASSWORD); await page.locator("#vault-submit").click();
    await expect(page.locator("#session-title")).toHaveText("Unilateral exit in progress");
    for (let step = 0; step < 12; step++) {
      await page.locator("#recover-tab").click();
      if (await page.locator("#session-title").textContent() === "Unilateral exit confirmed") break;
      // Background polling can finish between checking the title and clicking.
      // It can also hold the service mid-advance, leaving the resume button
      // briefly unavailable on a slow machine; only a durable failure matters.
      try { await page.locator("#advance").click({ timeout: 30_000 }); }
      catch {
        if (await page.locator("#session-title").textContent() === "Unilateral exit confirmed") break;
        throw new Error("The resume button stayed unavailable while the exit is still in progress.");
      }
      await expect(page.locator("#advance")).toBeEnabled({ timeout: 60_000 });
      console.log(`Regtest recovery step ${step}: ${await page.locator("#session-message").textContent()}`);
      const feedback = await page.locator("#feedback").textContent();
      // A background tick advancing first rejects the manual click as busy;
      // that is benign, any other error fails the test.
      if (await page.locator("#feedback").getAttribute("class") === "error" && !feedback?.includes("Another operation is still running")) throw new Error(feedback!);
      await faucet.mineBlocksAndWaitForMiningToComplete(2050);
    }
    await expect(page.locator("#session-title")).toHaveText("Unilateral exit confirmed", { timeout: 20_000 });
    const view = await page.evaluate(async () => (await window.recovery.status!()).value);
    const chain = new LocalChain(); const tx = await chain.rpc<{ hex: string; confirmations: number }>("getrawtransaction", [view.session.sweepTxid, true]);
    expect(tx.confirmations).toBeGreaterThan(0);
    const output = Transaction.fromRaw(hexToBytes(tx.hex)).getOutput(0);
    expect(bytesToHex(output.script!)).toBe(bytesToHex(OutScript.encode(Address(REGTEST).decode(destination))));
    expect(output.amount).toBeGreaterThan(0n);
    await page.locator("#finish").click(); await expect(page.locator("#leaf option")).toHaveCount(0);
  } finally {
    await app?.close(); await wallet?.cleanup?.();
    await exec("bash", ["scripts/desktop-regtest.sh", "online"]);
    await rm(directory, { recursive: true, force: true });
  }
});
