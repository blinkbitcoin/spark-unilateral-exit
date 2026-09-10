import { app, BrowserWindow, dialog, ipcMain, protocol, session, Menu, powerMonitor } from "electron";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { DesktopService } from "./service.ts";
import { Vault, readLimited, durableWrite, generatePassword } from "./vault.ts";
import { RPC_URL, RPC_USER, RPC_PASSWORD } from "./chain.ts";
import type { Settings, ProfileOptions, BitcoinRpc } from "./contracts.ts";

// The SDK's LOCAL helpers read these values. Ignore ambient wallet/node config.
process.env.BITCOIN_RPC_URL = RPC_URL;
process.env.BITCOIN_RPC_USER = RPC_USER;
process.env.BITCOIN_RPC_PASSWORD = RPC_PASSWORD;
delete process.env.SPARK_LOCAL_INGRESS_HOST;
delete process.env.SPARK_DANGEROUSLY_DISABLE_TLS_VERIFICATION;

app.setName("Spark recovery bundle backup and unilateral exit");
app.setPath("userData", process.env.SPARK_DESKTOP_TEST_DATA || path.join(app.getPath("appData"), "blink-spark-backup"));
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();

let window: BrowserWindow;
let service: DesktopService;
let timer: ReturnType<typeof setInterval>;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

app.whenReady().then(async () => {
  service = new DesktopService(new Vault(path.join(app.getPath("userData"), "vault.json")));
  await service.initialize();
  protocol.handle("app", async (request) => {
    const resources: Record<string, [string, string]> = {
      "app://recovery/": ["index.html", "text/html"],
      "app://recovery/renderer.js": ["renderer.js", "text/javascript"],
      "app://recovery/style.css": ["style.css", "text/css"],
      "app://recovery/assets/blink-logo.svg": ["assets/blink-logo.svg", "image/svg+xml"],
      "app://recovery/assets/ibm-plex-sans.ttf": ["assets/ibm-plex-sans.ttf", "font/ttf"],
    };
    const resource = resources[request.url];
    if (!resource || request.method !== "GET") return new Response("Not found", { status: 404 });
    return new Response(await readFile(path.join(__dirname, resource[0])), {
      headers: { "content-type": resource[1], "content-security-policy": CSP, "x-content-type-options": "nosniff" },
    });
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({ width: 1100, height: 850, minWidth: 760, minHeight: 650,
    autoHideMenuBar: true,
    title: "Spark recovery bundle backup and unilateral exit", backgroundColor: "#1d1d1d",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), sandbox: true,
      nodeIntegration: false, contextIsolation: true, webSecurity: true, devTools: false, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Spark bundle backup and unilateral exit", submenu: [
    { label: "Lock vault", click: () => { try { service.lock(); } catch { /* UI shows current operation. */ } } },
    { role: "quit" },
  ] }, { role: "editMenu" }]));

  async function readRecoveryBundle(title: string): Promise<string | undefined> {
    const result = await dialog.showOpenDialog(window, {
      title, properties: ["openFile"],
      filters: [{ name: "Recovery bundle", extensions: ["json"] }, { name: "All files", extensions: ["*"] }],
    });
    if (result.canceled || !result.filePaths[0]) return undefined;
    return readLimited(result.filePaths[0]);
  }

  const handlers: Record<string, (...args: any[]) => unknown> = {
    status: () => service.view(),
    create: (seed: string, password: string, options: ProfileOptions) => service.create(seed, password, undefined, "", options),
    addProfile: (seed: string, options: ProfileOptions) => service.addProfile(seed, options),
    selectProfile: (id: string) => service.selectProfile(id),
    createFromBundle: async (seed: string, password: string, backupPassword: string, options: ProfileOptions) => {
      const raw = await readRecoveryBundle("Choose a Blink or CLI recovery bundle");
      if (raw === undefined) return false;
      await service.create(seed, password, raw, backupPassword, options);
      return true;
    },
    addProfileFromBundle: async (seed: string, options: ProfileOptions, backupPassword: string) => {
      const raw = await readRecoveryBundle("Choose a recovery bundle for this seed");
      if (raw === undefined) return false;
      await service.addProfile(seed, options, raw, backupPassword);
      return true;
    },
    generatePassword,
    unlock: (password: string) => service.unlock(password),
    lock: () => service.lock(),
    configureBitcoin: (rpc?: BitcoinRpc) => service.configureBitcoin(rpc),
    configure: (settings: Settings) => service.configure(settings),
    refresh: () => service.refresh(),
    autoRefresh: (enabled: boolean) => service.setAutoRefresh(enabled),
    keepUnlocked: (enabled: boolean) => service.setKeepUnlocked(enabled),
    estimate: (leafId: string, rate: number) => service.estimate(leafId, rate),
    prepare: (leafId: string, destination: string, rate: number) => service.prepare(leafId, destination, rate),
    advance: () => service.advance(),
    finish: () => service.finish(),
    approve: async (id: string) => {
      const view = service.view();
      const review = view.session;
      if (!review || review.id !== id || review.status !== "review") throw new Error("No current unilateral exit review.");
      const result = await dialog.showMessageBox(window, { type: "warning", title: "Confirm unilateral exit",
        message: `Start this Bitcoin ${view.settings?.network === "MAINNET" ? "MAINNET" : "regtest"} unilateral exit?`, detail: `Seed profile: ${view.profiles?.find((profile) => profile.id === view.activeProfileId)?.label ?? "Seed 1"}\nDestination: ${review.destination}\nTransaction fees: ${review.feeSats} sats\nOutput: ${review.leafId}\nThe approved transactions will be broadcast while the vault is unlocked.`,
        buttons: ["Cancel", "Start unilateral exit"], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response === 1) await service.approve(id);
    },
    import: async (password: string) => {
      const raw = await readRecoveryBundle("Import a Blink or CLI recovery bundle");
      if (raw !== undefined) await service.importBundle(raw, password);
    },
    export: async (password: string) => {
      const view = service.view();
      const encrypted = await service.exportBundle(password);
      const network = view.settings!.network === "MAINNET" ? "mainnet" : "regtest";
      const profile = view.activeProfileId!.replace(/[^a-zA-Z0-9_-]/g, "");
      const result = await dialog.showSaveDialog(window, { title: "Save encrypted recovery bundle", defaultPath: `spark-${network}-${profile}-recovery-bundle.json` });
      if (!result.canceled && result.filePath) await durableWrite(result.filePath, encrypted);
    },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`recovery:${name}`, async (event, ...args: unknown[]) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== "app://recovery/") {
        return { ok: false, error: "Untrusted application frame." };
      }
      try {
        // Bound IPC before parsing imports or running expensive key derivation.
        if (JSON.stringify(args).length > 150_000) throw new Error("Request is too large.");
        const value = await handler(...args);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message.slice(0, 400) : "Operation failed. Saved state is retained." };
      }
    });
  }
  timer = setInterval(() => { void service.tick(); }, 5000);
  powerMonitor.on("lock-screen", () => service.screenLocked());
  powerMonitor.on("resume", () => { void service.tick(); });
  await window.loadURL("app://recovery/");
}).catch(() => {
  dialog.showErrorBox("Spark bundle backup and unilateral exit could not start", "Check access to the local vault and restart. Existing files have been preserved.");
  app.quit();
});
app.on("second-instance", () => { window?.show(); window?.focus(); });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => clearInterval(timer));
