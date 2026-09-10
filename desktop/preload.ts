import { contextBridge, ipcRenderer } from "electron";
const names = ["reset", "status", "create", "createFromBundle", "addProfile", "addProfileFromBundle", "selectProfile", "generatePassword", "unlock", "lock", "configure", "configureBitcoin", "refresh", "autoRefresh", "keepUnlocked",
  "estimate", "prepare", "approve", "advance", "finish", "import", "export"];
const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
for (const name of names) api[name] = (...args) => ipcRenderer.invoke(`recovery:${name}`, ...args);
contextBridge.exposeInMainWorld("recovery", Object.freeze(api));
