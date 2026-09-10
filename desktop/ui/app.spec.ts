import { test, expect, type ElectronApplication } from "@playwright/test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundle, blinkBackup, SEED, PASSWORD } from "../../test/desktop/helpers.ts";
import { encryptBackup } from "../vault.ts";
import { launch } from "./helpers.ts";
test("multiple seeds share one encrypted vault and a global mainnet connection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spark-desktop-profiles-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launch(directory); let page = await app.firstWindow();
    await page.locator("#seed").fill(SEED); await page.locator("#password").fill(PASSWORD); await page.locator("#password-confirm").fill(PASSWORD); await page.locator("#vault-submit").click();
    await expect(page.locator("#workspace")).toBeVisible();
    const first = await page.locator("#profile-select").inputValue();
    const seed = "01".repeat(64), file = path.join(directory, "second.json");
    await writeFile(file, JSON.stringify(bundle(1, seed)));
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    await page.locator("#profiles-tab").click(); await page.locator("#additional-label").fill("Second seed"); await page.locator("#additional-seed").fill(seed); await page.locator("#profile-import").click();
    await expect(page.locator("#recover-panel")).toBeVisible(); await expect(page.locator("#leaf option")).toHaveCount(1);
    const second = await page.locator("#profile-select").inputValue();
    await page.locator("#profile-select").selectOption(first); await expect(page.locator("#backup-summary")).toHaveText("No recovery bundle yet");
    await page.locator("#import").click(); await expect(page.locator("#feedback")).toContainText("does not match");
    await page.locator("#profiles-tab").click(); await page.locator("#additional-label").fill("Mainnet seed"); await page.locator("#additional-network").selectOption("MAINNET"); await page.locator("#additional-seed").fill(seed); await page.locator("#profile-add").click();
    await expect(page.locator("#network-badge")).toHaveText("Mainnet");
    const main = await page.locator("#profile-select").inputValue();
    await expect(page.locator("#funding-address")).toContainText(/^bc1/);
    await page.locator("#settings-details > summary").click();
    await expect(page.locator("#bitcoin-connection")).toHaveValue("explorer"); await expect(page.locator("#rpc-fields")).toBeHidden();
    await page.locator("#bitcoin-connection").selectOption("rpc"); await page.locator("#rpc-username").fill("global-user"); await page.locator("#rpc-password").fill("global-rpc-secret"); await page.locator("#bitcoin-settings-form button").click();
    await expect(page.locator("#feedback")).toContainText("all mainnet seed profiles");
    await expect(page.locator("#rpc-password")).toHaveValue("");
    await page.locator("#profile-select").selectOption(second); await expect(page.locator("#backup-summary")).toContainText("100,000");
    await expect(page.locator("#rpc-username")).toHaveValue("global-user");
    const status = await page.evaluate(async () => (await window.recovery.status!()).value);
    expect(status.profiles).toHaveLength(3); expect(JSON.stringify(status)).not.toContain("global-rpc-secret");
    expect(JSON.stringify(status)).not.toContain(seed);
    const ciphertext = await readFile(path.join(directory, "vault.json"), "utf8"); expect(ciphertext).not.toContain(seed); expect(ciphertext).not.toContain("global-rpc-secret");
    await app.close(); app = await launch(directory); page = await app.firstWindow();
    await page.locator("#password").fill(PASSWORD); await page.locator("#vault-submit").click();
    await expect(page.locator("#profile-select option")).toHaveCount(3); await expect(page.locator("#backup-summary")).toContainText("100,000");
    await page.locator("#profile-select").selectOption(main); await page.locator("#settings-details > summary").click();
    await expect(page.locator("#bitcoin-connection")).toHaveValue("rpc");
    await page.locator("#bitcoin-connection").selectOption("explorer"); await page.locator("#bitcoin-settings-form button").click();
    await expect(page.locator("#feedback")).toContainText("all mainnet seed profiles");
    await page.locator("#profile-select").selectOption(first); await expect(page.locator("#bitcoin-connection")).toHaveValue("explorer");
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});
test("real Electron: encrypted vault, hostile input, backup import/export, lock and restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spark-desktop-ui-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launch(directory); let page = await app.firstWindow();
    await expect(page.locator("#vault-title")).toHaveText("Create your vault");
    expect(await page.evaluate(() => typeof (window as any).require)).toBe("undefined");
    expect(await page.evaluate(() => typeof (window as any).process)).toBe("undefined");
    expect(await page.evaluate(() => Object.keys(window.recovery))).not.toContain("getSeed");
    await page.locator("#seed").fill(SEED); await page.locator("#generate-password").click();
    await expect(page.locator("#password")).toHaveValue(/^[A-Za-z0-9_-]{32}$/);
    const vaultPassword = await page.locator("#password").inputValue();
    await page.locator("#show-password").click(); await expect(page.locator("#password")).toHaveAttribute("type", "text");
    await page.locator("#show-password").click(); await expect(page.locator("#password")).toHaveAttribute("type", "password");
    await page.locator("#vault-submit").click();
    await expect(page.locator("#workspace")).toBeVisible();
    await page.locator("#refresh-options > summary").click(); await page.locator("#keep-unlocked").check();
    await expect(page.locator("#wallet-identity")).toContainText("Kept unlocked");
    await expect(page.locator("#refresh-frequency")).toContainText("hourly");
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); powerMonitor.emit("resume"); });
    await expect.poll(() => page.evaluate(async () => (await window.recovery.status!()).value.unlocked)).toBe(true);
    expect(await readFile(path.join(directory, "vault.json"), "utf8")).not.toContain(SEED);
    const input = path.join(directory, "input.json"), output = path.join(directory, "backup.json");
    await writeFile(input, JSON.stringify(bundle()));
    // Only OS file pickers are stubbed; import, encryption, IPC and disk I/O are real.
    await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, input);
    await page.locator("#import").click(); await expect(page.locator("#backup-summary")).toContainText("100,000");
    await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }); }, output);
    await page.locator("#backup-password").fill(PASSWORD); await page.locator("#export").click();
    await expect(page.locator("#feedback")).not.toHaveText("Working…");
    const exported = await readFile(output, "utf8"); expect(exported).not.toContain("treeNodeHex"); expect(exported).not.toContain(SEED);
    await page.locator("#lock").click(); await expect(page.locator("#locked")).toBeVisible();
    await page.locator("#password").fill("an incorrect password"); await page.locator("#vault-submit").click();
    await expect(page.locator("#feedback")).toContainText("Incorrect password");
    await app.close(); app = await launch(directory); page = await app.firstWindow();
    await expect(page.locator("#vault-submit")).toHaveText("Unlock vault");
    await page.locator("#password").fill(vaultPassword); await page.locator("#vault-submit").click(); await expect(page.locator("#backup-summary")).toContainText("100,000");
    await expect(page.locator("#keep-unlocked")).not.toBeChecked();
    await expect(page.locator("#auto-refresh")).not.toBeChecked();
    await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, output);
    await page.locator("#backup-password").fill(PASSWORD); await page.locator("#import").click(); await expect(page.locator("#feedback")).toContainText("Recovery bundle imported");
    await page.locator("#settings-details > summary").click(); await page.locator("#coordinator").fill("https://example.com"); await page.locator("#settings-form button").click();
    await expect(page.locator("#feedback")).toContainText("loopback");
    expect(await page.evaluate(() => fetch("https://example.com").then(() => true, () => false))).toBe(false);
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await expect(page.locator("#locked")).toBeVisible();
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const format of ["Blink JSON", "Blink encrypted", "desktop encrypted"]) {
  test(`creates a recovery vault from ${format} using the native file picker`, async ({}, testInfo) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "blink-desktop-import-"));
    let app: ElectronApplication | undefined;
    try {
      const value = { ...bundle(0), network: "REGTEST" };
      let raw = JSON.stringify(value);
      if (format === "Blink encrypted") raw = JSON.stringify(await blinkBackup(value));
      if (format === "desktop encrypted") raw = await encryptBackup(value, PASSWORD);
      const input = path.join(directory, "existing-backup.json"); await writeFile(input, raw);
      app = await launch(directory); let page = await app.firstWindow();
      await expect(page.locator("#vault-import")).toBeVisible();
      await expect(page.locator("#vault-import")).toBeDisabled();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(760, 650));
      await page.evaluate(() => document.fonts.ready);
      expect(await page.locator(".brand-logo").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      expect(await page.evaluate(() => document.fonts.check('16px "IBM Plex Sans"'))).toBe(true);
      await expect(page.locator("#vault-import")).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath("create-vault.png") });
      await page.locator("#seed").fill(SEED); await expect(page.locator("#vault-import")).toBeDisabled();
      await page.locator("#password").fill(PASSWORD); await expect(page.locator("#vault-import")).toBeEnabled();
      await page.locator("#password-confirm").fill(PASSWORD);
      await page.locator("#seed").fill(""); await expect(page.locator("#vault-import")).toBeDisabled();
      await page.locator("#seed").fill(SEED);
      if (format === "desktop encrypted") {
        await page.locator("#import-options > summary").click(); await page.locator("#import-password").fill(PASSWORD);
      }
      await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input] }); }, input);
      await page.locator("#vault-import").click(); await expect(page.locator("#recover-panel")).toBeVisible();
      await expect(page.locator("#wallet-identity")).toContainText("Account 0");
      await expect(page.locator("#leaf option")).toContainText("100,000 sats");
      await expect(page.locator("#seed")).toHaveValue(""); await expect(page.locator("#password")).toHaveValue("");
      await expect(page.locator("#import-password")).toHaveValue("");
      expect(await readFile(path.join(directory, "vault.json"), "utf8")).not.toContain("treeNodeHex");
      await page.screenshot({ path: testInfo.outputPath("imported-recovery.png") });
      await app.close(); app = await launch(directory); page = await app.firstWindow();
      await page.locator("#password").fill(PASSWORD); await page.locator("#vault-submit").click();
      await expect(page.locator("#backup-summary")).toContainText("100,000 sats");
      await expect(page.locator("#wallet-identity")).toContainText("Account 0");
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
