import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launch } from "./helpers.ts";
import { encryptBackup } from "../vault.ts";
import { wallet, recovery, PASSWORD } from "../../test/desktop/helpers.ts";
async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const size = await page.evaluate(() => ({ content: document.documentElement.scrollHeight, viewport: window.innerHeight }));
  expect(size.content, `Content ${size.content}px exceeds viewport ${size.viewport}px`).toBeLessThanOrEqual(size.viewport);
}
for (const [width, height] of [[1100, 850], [760, 650]]) {
  test(`layout fits ${width}x${height}: backup, preparation and active review`, async ({}, testInfo) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "spark-desktop-layout-"));
    let app: ElectronApplication | undefined;
    try {
      await writeFile(path.join(directory, "vault.json"), await encryptBackup(wallet(), PASSWORD));
      app = await launch(directory);
      let page = await app.firstWindow(); await expect(page.locator("#vault-submit")).toHaveText("Unlock vault");
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size[0]!, size[1]!), [width, height]);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await fits(page);
      await page.locator("#password").fill(PASSWORD); await page.locator("#vault-submit").click(); await expect(page.locator("#workspace")).toBeVisible();
      await fits(page); await expect(page.locator("#export")).toBeInViewport({ ratio: 1 });
      await page.locator("#profiles-tab").click(); await fits(page); await expect(page.locator("#profile-add")).toBeInViewport({ ratio: 1 });
      await page.locator("#backup-tab").click(); await page.locator("#settings-details > summary").click();
      await page.locator("#bitcoin-connection").selectOption("rpc"); await fits(page); await expect(page.locator("#export")).toBeInViewport({ ratio: 1 });
      await page.locator("#settings-details > summary").click();
      await page.locator("#refresh-options > summary").click(); await page.locator("#keep-unlocked").check(); await expect(page.locator("#wallet-identity")).toContainText("Kept unlocked");
      await fits(page); await expect(page.locator("#export")).toBeInViewport({ ratio: 1 });
      await page.locator("#recover-tab").click();
      await page.locator("#estimate-result").evaluate((element) => { element.textContent = "Fund at least 1,500 sats. Estimated net after all fees: 98,500 sats."; });
      await fits(page);
      await expect(page.locator("#recover-form button[type=submit]")).toBeInViewport({ ratio: 1 });
      await app.close();
      const state = wallet(); state.session = recovery();
      // Match actual address and txid lengths, including wrapping at minimum width.
      state.session.destination = `bcrt1p${"q".repeat(58)}`;
      state.session.sweep.sweepTxid = "ab".repeat(32);
      await writeFile(path.join(directory, "vault.json"), await encryptBackup(state, PASSWORD));
      app = await launch(directory);
      page = await app.firstWindow(); await expect(page.locator("#vault-submit")).toHaveText("Unlock vault");
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setSize(size[0]!, size[1]!), [width, height]);
      await page.locator("#password").fill(PASSWORD); await page.locator("#vault-submit").click();
      await expect(page.locator("#recovery-session")).toBeVisible(); await fits(page);
      await expect(page.locator("#approve")).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath("recovery-review.png") });
      await page.locator("#backup-tab").click(); await expect(page.locator("#backup-panel")).toBeVisible();
      await page.locator("#recover-tab").click(); await expect(page.locator("#recovery-session")).toBeVisible();
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
