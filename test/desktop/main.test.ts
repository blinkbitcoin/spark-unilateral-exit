import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ handlers: {} as Record<string, (...args: any[]) => any>, events: {} as Record<string, (...args: any[]) => any>,
  wcEvents: {} as Record<string, (...args: any[]) => any>, power: {} as Record<string, (...args: any[]) => any>,
  boot: undefined as Promise<unknown> | undefined, resource: undefined as any, menu: undefined as any, window: undefined as any,
  app: { setName: vi.fn(), setPath: vi.fn(), getPath: vi.fn(() => "/tmp"), enableSandbox: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true), quit: vi.fn(), on: vi.fn(), whenReady: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showErrorBox: vi.fn() },
  session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
  service: Object.fromEntries(["reset", "initialize", "view", "addProfile", "selectProfile", "create", "unlock", "lock", "screenLocked", "setKeepUnlocked", "configure", "configureBitcoin", "refresh", "setAutoRefresh", "estimate", "prepare", "advance", "finish", "approve", "importBundle", "exportBundle", "tick"].map((n) => [n, vi.fn()])) as Record<string, any>,
  readLimited: vi.fn(), durableWrite: vi.fn(), generatePassword: vi.fn(() => "generated"), readFile: vi.fn(), expose: vi.fn(), invoke: vi.fn(),
}));
vi.mock("electron", () => ({
  app: h.app, dialog: h.dialog, session: { defaultSession: h.session },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn((_scheme, handler) => { h.resource = handler; }) },
  ipcMain: { handle: vi.fn((name, handler) => { h.handlers[name] = handler; }) },
  ipcRenderer: { invoke: h.invoke }, contextBridge: { exposeInMainWorld: h.expose },
  powerMonitor: { on: vi.fn((name, handler) => { h.power[name] = handler; }) },
  Menu: { buildFromTemplate: vi.fn((menu) => { h.menu = menu; return menu; }), setApplicationMenu: vi.fn() },
  BrowserWindow: class {
    webContents = { mainFrame: { url: "app://recovery/" }, setWindowOpenHandler: vi.fn(), on: vi.fn((name, handler) => { h.wcEvents[name] = handler; }) };
    loadURL = vi.fn(async () => {}); show = vi.fn(); focus = vi.fn();
    constructor(readonly options: any) { h.window = this; }
  },
}));
vi.mock("../../desktop/service.ts", () => ({ DesktopService: class { constructor() { return h.service; } } }));
vi.mock("../../desktop/vault.ts", () => ({ Vault: class {}, readLimited: h.readLimited, durableWrite: h.durableWrite, generatePassword: h.generatePassword }));
vi.mock("node:fs/promises", () => ({ readFile: h.readFile }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal("__dirname", "/tmp/desktop-dist");
  h.handlers = {}; h.events = {}; h.wcEvents = {}; h.power = {}; h.window = undefined;
  h.app.requestSingleInstanceLock.mockReturnValue(true);
  h.app.on.mockImplementation((name: string, handler: any) => { h.events[name] = handler; });
  h.app.whenReady.mockImplementation(() => ({ then: (fn: any) => { h.boot = Promise.resolve().then(fn); return h.boot; } }) as any);
  h.service.initialize.mockResolvedValue(undefined); h.service.view.mockReturnValue({}); h.service.tick.mockResolvedValue(undefined);
  h.readFile.mockResolvedValue(Buffer.from("asset"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function boot() { await import("../../desktop/main.ts"); await h.boot?.catch(() => {}); await Promise.resolve(); }
function invoke(name: string, ...args: unknown[]) { return h.handlers[`recovery:${name}`]!({ sender: h.window.webContents, senderFrame: h.window.webContents.mainFrame }, ...args); }
describe("Electron security boundary", () => {
  it("requires native destructive consent with Cancel as the safe default", async () => {
    await boot();
    h.service.reset.mockImplementation(async (_text: unknown, confirm: () => Promise<boolean>) => confirm());
    for (const response of [0, 1]) {
      h.dialog.showMessageBox.mockResolvedValueOnce({ response });
      expect(await invoke("reset", "RESET")).toEqual({ ok: true, value: response === 1 });
    }
    expect(h.service.reset).toHaveBeenLastCalledWith("RESET", expect.any(Function));
    expect(h.dialog.showMessageBox).toHaveBeenLastCalledWith(h.window, expect.objectContaining({
      type: "warning", buttons: ["Cancel", "Delete all local vault data"], defaultId: 0, cancelId: 0,
      detail: expect.stringContaining("ALL local seeds, profiles, recovery bundles and recovery progress"),
    }));
  });
  it("distinguishes an empty selected file from cancellation and propagates file-read failures", async () => {
    await boot();
    const options = { label: "Seed", network: "LOCAL" };
    for (const [command, method, args] of [
      ["createFromBundle", "create", ["seed", "vault password", "bundle password", options]],
      ["addProfileFromBundle", "addProfile", ["seed", options, "bundle password"]],
      ["import", "importBundle", ["bundle password"]],
    ] as const) {
      h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/tmp/empty.json"] });
      h.readLimited.mockResolvedValueOnce("");
      h.service[method].mockRejectedValueOnce(new Error("Empty recovery bundle"));
      expect(await invoke(command, ...args)).toEqual({ ok: false, error: "Empty recovery bundle" });
      expect(h.service[method].mock.calls.at(-1)).toContain("");
      const calls = h.service[method].mock.calls.length;
      h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/tmp/unreadable.json"] });
      h.readLimited.mockRejectedValueOnce(new Error("File is unreadable"));
      expect(await invoke(command, ...args)).toEqual({ ok: false, error: "File is unreadable" });
      expect(h.service[method]).toHaveBeenCalledTimes(calls);
    }
  });
  it("sandboxes the window, limits resources, denies navigation and authenticates IPC", async () => {
    await boot();
    expect(h.window.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, devTools: false });
    expect(h.window.options.autoHideMenuBar).toBe(true);
    expect(await h.window.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: "deny" });
    const preventDefault = vi.fn(); h.wcEvents["will-navigate"]!({ preventDefault }); h.wcEvents["will-attach-webview"]!({ preventDefault }); expect(preventDefault).toHaveBeenCalledTimes(2);
    const permit = vi.fn(); (h.session.setPermissionRequestHandler.mock.calls[0] as any)[0](null, "camera", permit); expect(permit).toHaveBeenCalledWith(false);
    expect((h.session.setPermissionCheckHandler.mock.calls[0] as any)[0]()).toBe(false);
    for (const url of ["app://recovery/", "app://recovery/renderer.js", "app://recovery/style.css", "app://recovery/assets/blink-logo.svg", "app://recovery/assets/ibm-plex-sans.ttf"]) {
      const response = await h.resource({ url, method: "GET" }); expect(response.status).toBe(200); expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'");
    }
    expect((await h.resource({ url: "app://recovery/secret", method: "GET" })).status).toBe(404);
    expect((await h.resource({ url: "app://recovery/", method: "POST" })).status).toBe(404);
    for (const event of [{}, { sender: h.window.webContents, senderFrame: {} }]) expect((await h.handlers["recovery:status"]!(event)).ok).toBe(false);
    h.window.webContents.mainFrame.url = "https://evil.test"; expect((await invoke("status")).ok).toBe(false); h.window.webContents.mainFrame.url = "app://recovery/";
    expect((await invoke("create", "x".repeat(150001))).error).toContain("large");
    h.service.unlock.mockRejectedValueOnce(new Error("bad password")); expect((await invoke("unlock", "wrong")).error).toBe("bad password");
    h.service.unlock.mockRejectedValueOnce("untrusted value"); expect((await invoke("unlock", "wrong")).error).toContain("Saved state");
  });
  it("routes only explicit operations and confirms the current recovery natively", async () => {
    await boot();
    for (const name of ["status", "create", "addProfile", "selectProfile", "generatePassword", "unlock", "lock", "configure", "configureBitcoin", "refresh", "autoRefresh", "keepUnlocked", "estimate", "prepare", "advance", "finish"]) {
      expect((await invoke(name, "a", "b", "c", "d")).ok).toBe(true);
    }
    expect(h.service.refresh).toHaveBeenCalledWith(undefined, "a");
    expect(h.service.create).toHaveBeenCalledWith("a", "b", undefined, "", "c");
    expect(h.generatePassword).toHaveBeenCalled();
    expect((await invoke("approve", "id")).ok).toBe(false);
    h.service.view.mockReturnValue({ session: { id: "other", status: "review" } }); expect((await invoke("approve", "id")).ok).toBe(false);
    h.service.view.mockReturnValue({ session: { id: "id", status: "running" } }); expect((await invoke("approve", "id")).ok).toBe(false);
    h.service.view.mockReturnValue({ session: { id: "id", status: "review", destination: "bcrt1test", feeSats: "500", leafId: "leaf" } });
    h.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 }); await invoke("approve", "id"); expect(h.service.approve).not.toHaveBeenCalled();
    h.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 }); await invoke("approve", "id"); expect(h.service.approve).toHaveBeenCalledWith("id");
    h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true }); await invoke("import", "password");
    h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] }); await invoke("import", "password");
    h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/tmp/bundle"] }); h.readLimited.mockResolvedValueOnce("encrypted");
    await invoke("import", "password"); expect(h.service.importBundle).toHaveBeenCalledWith("encrypted", "password");
    h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true }); await invoke("createFromBundle", "seed", "vault", "backup");
    h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] }); await invoke("createFromBundle", "seed", "vault", "backup");
    h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/tmp/bundle"] }); h.readLimited.mockResolvedValueOnce("raw");
    await invoke("createFromBundle", "seed", "vault", "backup"); expect(h.service.create).toHaveBeenCalledWith("seed", "vault", "raw", "backup", undefined);
    const options = { label: "Second seed", network: "MAINNET" };
    h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true }); expect((await invoke("addProfileFromBundle", "seed", options, "backup")).value).toBe(false);
    h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] }); expect((await invoke("addProfileFromBundle", "seed", options, "backup")).value).toBe(false);
    h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/tmp/bundle"] }); h.readLimited.mockResolvedValueOnce("second raw");
    expect((await invoke("addProfileFromBundle", "seed", options, "backup")).value).toBe(true);
    expect(h.service.addProfile).toHaveBeenCalledWith("seed", options, "second raw", "backup");
    h.service.view.mockReturnValue({ settings: { network: "MAINNET" }, activeProfileId: "second", profiles: [{ id: "first", label: "First" }, { id: "second", label: "Second" }], session: { id: "id", status: "review", destination: "bc1test", feeSats: "500", leafId: "leaf" } });
    h.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 }); await invoke("approve", "id");
    expect(h.dialog.showMessageBox).toHaveBeenLastCalledWith(h.window, expect.objectContaining({ message: expect.stringContaining("MAINNET"), detail: expect.stringContaining("Seed profile: Second") }));
    h.service.exportBundle.mockResolvedValue("encrypted");
    h.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true }); await invoke("export", "password");
    h.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false }); await invoke("export", "password");
    h.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: "/tmp/export" }); await invoke("export", "password");
    expect(h.durableWrite).toHaveBeenCalledWith("/tmp/export", "encrypted");
    expect(h.dialog.showSaveDialog).toHaveBeenLastCalledWith(h.window, expect.objectContaining({ defaultPath: "spark-mainnet-second-recovery-bundle.json" }));
    h.service.view.mockReturnValue({ settings: { network: "LOCAL" }, activeProfileId: "../seed-one" });
    h.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true }); await invoke("export", "password");
    expect(h.dialog.showSaveDialog).toHaveBeenLastCalledWith(h.window, expect.objectContaining({ defaultPath: "spark-regtest-seed-one-recovery-bundle.json" }));
  });
  it("locks on OS lock, handles lifecycle events and initialization failure", async () => {
    await boot(); await vi.advanceTimersByTimeAsync(5000); expect(h.service.tick).toHaveBeenCalled();
    h.menu[0].submenu[0].click(); h.power["lock-screen"]!(); expect(h.service.lock).toHaveBeenCalledTimes(1);
    expect(h.service.screenLocked).toHaveBeenCalledTimes(1);
    h.power.resume!(); expect(h.service.tick).toHaveBeenCalledTimes(2);
    h.service.lock.mockImplementationOnce(() => { throw new Error("busy"); }); h.menu[0].submenu[0].click();
    h.events["second-instance"]!(); expect(h.window.focus).toHaveBeenCalled(); h.events["window-all-closed"]!(); expect(h.app.quit).toHaveBeenCalled(); h.events["before-quit"]!();
    vi.resetModules(); h.app.requestSingleInstanceLock.mockReturnValue(false); h.service.initialize.mockRejectedValueOnce(new Error("disk"));
    process.env.SPARK_DESKTOP_TEST_DATA = "/tmp/test-only";
    await boot(); delete process.env.SPARK_DESKTOP_TEST_DATA;
    expect(h.dialog.showErrorBox).toHaveBeenCalled(); expect(h.app.setPath).toHaveBeenCalledWith("userData", "/tmp/test-only");
  });
  it("exposes only the fixed preload command set", async () => {
    await import("../../desktop/preload.ts"); const api = (h.expose.mock.calls[0] as any)[1];
    expect(Object.isFrozen(api)).toBe(true); expect(api.getSeed).toBeUndefined();
    for (const [name, fn] of Object.entries(api)) { await (fn as any)("test"); expect(h.invoke).toHaveBeenLastCalledWith(`recovery:${name}`, "test"); }
  });
});
