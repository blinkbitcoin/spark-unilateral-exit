import { test, expect, type ElectronApplication } from "@playwright/test";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundle, recovery, SEED, PASSWORD } from "../../test/desktop/helpers.ts";
import { Vault } from "../vault.ts";
import { DEFAULT_SETTINGS } from "../contracts.ts";
import { launch } from "./helpers.ts";

test("forgotten password reset cancels safely, rejects wrong text and restarts fresh", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spark-desktop-reset-"));
  const filename = path.join(directory, "vault.json"), crash = "vault.json.0123456789abcdef.tmp";
  let app: ElectronApplication | undefined;
  try {
    const vault = new Vault(filename);
    const wallet = { version: 1, seed: SEED, settings: { ...DEFAULT_SETTINGS, network: "LOCAL" }, bundle: bundle(), session: recovery(), completed: [recovery()] };
    const data = { version: 2, activeProfileId: "one", profiles: [{ id: "one", label: "First", wallet },
      { id: "two", label: "Second", wallet: { ...wallet, seed: "01".repeat(64), bundle: undefined, session: undefined, completed: [] } }] };
    await vault.create(data, PASSWORD); await vault.save(data); vault.lock();
    await writeFile(path.join(directory, crash), "crash ciphertext");
    await writeFile(path.join(directory, "external-backup.json"), "external backup sentinel");
    const original = await readFile(filename, "utf8"), previous = await readFile(filename + ".previous", "utf8");
    app = await launch(directory, true); let page = await app.firstWindow();
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(directory);
    await expect(page.locator("#vault-title")).toHaveText("Unlock your vault");
    await expect(page.locator("#reset-storage")).toBeHidden();
    await page.locator("#forgot-password > summary").click();
    await expect(page.locator("#reset-storage")).toBeVisible();
    await expect(page.locator("#reset-warning")).toContainText("ALL local seeds, profiles, recovery bundles and recovery progress");
    expect(await page.locator("#reset-storage").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 133, 133)");
    // Only native dialog responses are stubbed. Renderer, IPC, service and file deletion are real.
    await app.evaluate(({ dialog }) => {
      (globalThis as any).resetDialogs = [];
      dialog.showMessageBox = (async (_window: unknown, options: unknown) => {
        (globalThis as any).resetDialogs.push(options); return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    await page.locator("#reset-confirmation").fill("reset"); await page.locator("#reset-storage").click();
    await expect(page.locator("#feedback")).toContainText("Type RESET");
    const wrong = await page.evaluate(async () => window.recovery.reset!(" RESET"));
    expect(wrong).toMatchObject({ ok: false, error: expect.stringContaining("Type RESET") });
    expect(await app.evaluate(() => (globalThis as any).resetDialogs.length)).toBe(0);
    expect(await readFile(filename, "utf8")).toBe(original);
    await page.locator("#reset-confirmation").fill("RESET"); await page.locator("#reset-storage").click();
    await expect(page.locator("#reset-confirmation")).toHaveValue("");
    await expect(page.locator("#reset-storage")).toBeEnabled();
    expect(await app.evaluate(() => (globalThis as any).resetDialogs[0])).toMatchObject({ defaultId: 0, cancelId: 0, buttons: ["Cancel", "Delete all local vault data"] });
    expect(await readFile(filename, "utf8")).toBe(original); expect(await readFile(filename + ".previous", "utf8")).toBe(previous);
    await app.close(); app = await launch(directory, true); page = await app.firstWindow();
    await expect(page.locator("#vault-title")).toHaveText("Unlock your vault");
    await expect(page.locator("#reset-storage")).toBeHidden();
    await page.locator("#forgot-password > summary").click();
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await page.locator("#password").fill("forgotten password");
    await page.locator("#reset-confirmation").fill("RESET"); await page.locator("#reset-storage").click();
    await expect(page.locator("#vault-title")).toHaveText("Create your vault");
    await expect(page.locator("#forgot-password")).toBeHidden(); await expect(page.locator("#password")).toHaveValue("");
    const names = await readdir(directory);
    for (const name of ["vault.json", "vault.json.previous", crash]) expect(names).not.toContain(name);
    expect(await readFile(path.join(directory, "external-backup.json"), "utf8")).toBe("external backup sentinel");
    await app.close(); app = await launch(directory, true); page = await app.firstWindow();
    await expect(page.locator("#vault-title")).toHaveText("Create your vault");
    await expect(page.locator("#forgot-password")).toBeHidden();
    await page.locator("#seed").fill(SEED); await page.locator("#password").fill(PASSWORD); await page.locator("#password-confirm").fill(PASSWORD); await page.locator("#vault-submit").click();
    await expect(page.locator("#workspace")).toBeVisible(); await expect(page.locator("#profile-select option")).toHaveCount(1);
    await expect(page.locator("#backup-summary")).toHaveText("No recovery bundle yet");
    const status = await page.evaluate(async () => (await window.recovery.status!()).value);
    expect(status.session).toBeUndefined(); expect(status.autoRefresh).toBe(false); expect(status.keepUnlocked).toBe(false);
    await expect(page.locator("#forgot-password")).toBeHidden();
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});
