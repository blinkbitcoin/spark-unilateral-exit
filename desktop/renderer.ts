import type { PublicState, Settings, ProfileOptions } from "./contracts.ts";
declare global { interface Window { recovery: Record<string, (...args: unknown[]) => Promise<{ ok: boolean; value?: any; error?: string }>> } }
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
let current: PublicState;
let working = false;
// Bumped by every user action so a status snapshot fetched before the action
// is never applied over the action's result.
let updateSeq = 0;
let settingsLoaded = false;
let tab: "backup" | "recover" | "profiles" = "backup";
let activeProfileId: string | undefined;
let sessionId: string | undefined;
let lastServiceMessage = "";
function showTab() {
  el("profiles-panel").hidden = tab !== "profiles";
  el("profiles-tab").setAttribute("aria-selected", String(tab === "profiles"));
  el("backup-panel").hidden = tab !== "backup";
  el("recover-panel").hidden = tab !== "recover" || !!current.session;
  el("recovery-session").hidden = tab !== "recover" || !current.session;
  el("backup-tab").setAttribute("aria-selected", String(tab === "backup"));
  el("recover-tab").setAttribute("aria-selected", String(tab === "recover"));
}
function showPassword(visible: boolean) {
  input("password").type = visible ? "text" : "password";
  el("show-password").textContent = visible ? "Hide password" : "Show password";
  el("show-password").setAttribute("aria-pressed", String(visible));
}
function updateImportAvailability() {
  const password = input("password");
  const hasSeed = !!input("seed").value.trim();
  input("vault-import").disabled = working || !hasSeed || password.value.length < password.minLength || password.value.length > password.maxLength;
  input("profile-import").disabled = working || !input("additional-seed").value.trim();
  el("import-options").hidden = !!current?.exists || !hasSeed;
}
const feedback = (message: string, error = false) => { el("feedback").textContent = message; el("feedback").classList.toggle("error", error); };
async function call(name: string, ...args: unknown[]) {
  const result = await window.recovery[name]!(...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function update() {
  const seq = updateSeq;
  const next = await call("status") as PublicState;
  if (seq !== updateSeq) return;
  current = next;
  if (current.message !== lastServiceMessage) { lastServiceMessage = current.message; feedback(current.message); }
  el("locked").hidden = current.unlocked; el("workspace").hidden = !current.unlocked;
  el("navigation").hidden = !current.unlocked;
  el("create-fields").hidden = current.exists;
  el("generate-password").hidden = current.exists;
  el("password-help").hidden = current.exists;
  el("vault-import").hidden = current.exists;
  updateImportAvailability();
  el("vault-title").textContent = current.exists ? "Unlock your vault" : "Create your vault";
  el("vault-submit").textContent = current.exists ? "Unlock vault" : "Create encrypted vault";
  if (!current.unlocked) {
    if (activeProfileId) for (const id of ["additional-seed", "additional-password", "rpc-password", "backup-password"]) input(id).value = "";
    activeProfileId = undefined; settingsLoaded = false; showNetwork(); return;
  }
  updateProfile();
  el("wallet-identity").textContent = `Account ${current.settings!.accountNumber} · ${current.identity!.slice(0, 20)}…${current.keepUnlocked ? " · Kept unlocked" : ""}`;
  el("funding-address").textContent = current.fundingAddress!;
  el("backup-summary").textContent = current.bundle ? `${Number(current.bundle.sats).toLocaleString()} sats in recovery bundle` : "No recovery bundle yet";
  el("backup-date").textContent = current.bundle ? `Bundle created: ${current.bundle.createdAt}. Latest state is unknown until refreshed.` : current.message;
  input("auto-refresh").checked = current.autoRefresh;
  input("keep-unlocked").checked = current.keepUnlocked;
  el("refresh-frequency").textContent = current.keepUnlocked ? "Refresh all profiles hourly while unlocked" : "Refresh all profiles every minute while unlocked";
  updateLeaves();
  updateExit();
}
function updateProfile() {
  if (activeProfileId !== current.activeProfileId) {
    activeProfileId = current.activeProfileId; settingsLoaded = false; sessionId = undefined;
    for (const id of ["destination", "rpc-password", "backup-password"]) input(id).value = "";
    el("estimate-result").textContent = "";
  }
  const profiles = el<HTMLSelectElement>("profile-select");
  const profileSignature = JSON.stringify(current.profiles);
  if (profiles.dataset.signature !== profileSignature) {
    profiles.replaceChildren(...current.profiles!.map((profile) => {
      const option = document.createElement("option"); option.value = profile.id;
      option.textContent = `${profile.label} · ${profile.network === "MAINNET" ? "Mainnet" : "Regtest"}`; return option;
    }));
    profiles.dataset.signature = profileSignature;
  }
  profiles.value = activeProfileId!;
  showNetwork();
  if (!settingsLoaded) {
    input("coordinator").value = current.settings!.coordinatorUrl; input("ca").value = current.settings!.coordinatorCa;
    input("rpc-url").value = current.bitcoinRpc?.url ?? "http://127.0.0.1:8332";
    input("rpc-username").value = current.bitcoinRpc?.username ?? "";
    input("bitcoin-connection").value = current.bitcoinRpc ? "rpc" : "explorer";
    showConnection();
    settingsLoaded = true;
  }
}
function updateLeaves() {
  const select = el<HTMLSelectElement>("leaf");
  const selected = select.value;
  const leaves = current.bundle?.leaves ?? [];
  const signature = JSON.stringify(leaves);
  if (select.dataset.signature !== signature) {
    select.replaceChildren(...leaves.map((leaf) => {
      const option = document.createElement("option"); option.value = leaf.id;
      option.textContent = `${leaf.sats.toLocaleString()} sats · ${leaf.id.slice(0, 12)}…`; return option;
    }));
    if (leaves.some((leaf) => leaf.id === selected)) select.value = selected;
    select.dataset.signature = signature;
  }
}
function updateExit() {
  const session = current.session;
  if (session?.id !== sessionId) {
    sessionId = session?.id;
    tab = "recover";
  }
  showTab();
  if (!session) return;
  let title = "Review unilateral exit";
  if (session.status === "complete") {
    title = "Unilateral exit confirmed";
  } else if (session.approved) {
    title = "Unilateral exit in progress";
  }
  el("session-title").textContent = title;
  el("session-summary").textContent = `Destination: ${session.destination}\nFees: ${session.feeSats} sats at ${session.feeRate} sat/vB\nOutput: ${session.leafId}\nDestination transaction: ${session.sweepTxid}`;
  el("session-message").textContent = session.message;
  el("approve").hidden = session.approved;
  el("advance").hidden = session.status !== "running";
  el("finish").hidden = session.status === "running";
  el("finish").textContent = session.status === "complete" ? "Exit another output" : "Cancel exit review";
}
async function action(work: () => Promise<unknown>) {
  if (working) return;
  working = true;
  updateSeq++;
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.disabled = true);
  feedback("Working…");
  try {
    await work();
    await update();
    feedback(current.message);
  } catch (error) {
    feedback((error as Error).message, true);
  } finally {
    working = false;
    document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.disabled = false);
    updateImportAvailability();
  }
}
function showNetwork() {
  const mainnet = (current?.unlocked ? current.settings!.network : input("network").value) === "MAINNET";
  el("network-badge").textContent = mainnet ? "Mainnet" : "Regtest";
  el("network-notice").textContent = mainnet ? "Bitcoin mainnet: unilateral exits move real bitcoin. USDB is not covered." : "Bitcoin regtest: use disposable test seeds. USDB is not covered.";
  input("destination").placeholder = mainnet ? "bc1…" : "bcrt1…";
  el("funding-label").textContent = mainnet ? "Send mainnet bitcoin for fees to" : "Send regtest bitcoin for fees to";
}
function showConnection() { el("rpc-fields").hidden = input("bitcoin-connection").value !== "rpc"; }
input("bitcoin-connection").addEventListener("change", showConnection);
function profileOptions(label: string, network: string): ProfileOptions { return { label: input(label).value, network: input(network).value as ProfileOptions["network"] }; }
const click = (id: string, handler: () => Promise<unknown>) => el(id).addEventListener("click", () => void action(handler));
for (const id of ["seed", "password", "additional-seed"]) input(id).addEventListener("input", updateImportAvailability);
click("generate-password", async () => { input("password").value = await call("generatePassword"); showPassword(false); });
el("show-password").addEventListener("click", () => showPassword(input("password").type === "password"));
for (const name of ["backup", "recover", "profiles"] as const) el(`${name}-tab`).addEventListener("click", () => { tab = name; showTab(); });
el("vault-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const fromBundle = (event as SubmitEvent).submitter?.id === "vault-import";
  const options = profileOptions("profile-name", "network");
  const seed = input("seed").value, password = input("password").value, backupPassword = input("import-password").value;
  input("seed").value = ""; input("password").value = ""; input("import-password").value = "";
  showPassword(false);
  void action(async () => {
    if (current.exists) return call("unlock", password);
    if (fromBundle) {
      if (await call("createFromBundle", seed, password, backupPassword, options)) tab = "recover";
      return;
    }
    return call("create", seed, password, options);
  });
});
input("network").addEventListener("change", showNetwork);
input("profile-select").addEventListener("change", () => {
  const id = input("profile-select").value;
  void action(async () => { await call("selectProfile", id); tab = "backup"; });
});
el("profile-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const seed = input("additional-seed").value, password = input("additional-password").value;
  const options = profileOptions("additional-label", "additional-network");
  const fromBundle = (event as SubmitEvent).submitter?.id === "profile-import";
  input("additional-seed").value = ""; input("additional-password").value = "";
  void action(async () => {
    if (fromBundle) {
      if (await call("addProfileFromBundle", seed, options, password)) tab = "recover";
      return;
    }
    await call("addProfile", seed, options);
    tab = "backup";
  });
});
el("bitcoin-settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const rpc = input("bitcoin-connection").value === "rpc" ? { url: input("rpc-url").value, username: input("rpc-username").value, password: input("rpc-password").value } : undefined;
  input("rpc-password").value = "";
  void action(() => call("configureBitcoin", rpc));
});
el("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value: Settings = { accountNumber: current.settings!.accountNumber, network: current.settings!.network,
    coordinatorUrl: input("coordinator").value, coordinatorCa: input("ca").value };
  input("rpc-password").value = "";
  void action(() => call("configure", value));
});
el("recover-form").addEventListener("submit", (event) => { event.preventDefault(); void action(() => call("prepare", input("leaf").value, input("destination").value, Number(input("fee-rate").value))); });
click("lock", () => call("lock")); click("refresh", () => call("refresh"));
click("estimate", async () => { const result = await call("estimate", input("leaf").value, Number(input("fee-rate").value));
  el("estimate-result").textContent = `Fund at least ${result.requiredSats} sats. Estimated net after all fees: ${result.netSats ?? "unknown"} sats.`; });
click("approve", () => call("approve", current.session?.id)); click("advance", () => call("advance")); click("finish", () => call("finish"));
for (const name of ["import", "export"]) click(name, () => {
  const password = input("backup-password").value; input("backup-password").value = ""; return call(name, password);
});
input("auto-refresh").addEventListener("change", () => void action(() => call("autoRefresh", input("auto-refresh").checked)));
input("keep-unlocked").addEventListener("change", () => void action(() => call("keepUnlocked", input("keep-unlocked").checked)));
void update().catch(() => feedback("Unable to connect to the app backend.", true));
setInterval(() => { if (!working) void update().catch(() => feedback("Backend unavailable. Restart to resume the saved unilateral exit.", true)); }, 2000);
