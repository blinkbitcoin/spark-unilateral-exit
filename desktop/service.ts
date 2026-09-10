import { bytesToHex } from "@noble/curves/utils";
import { deriveIdentityKeyPair } from "../src/operator/identity.ts";
import { Vault, encryptBackup } from "./vault.ts";
import { decodeImportedBundle } from "./import-bundle.ts";
import { RecoveryEngine } from "./engine.ts";
import { bundleCheck, settingsCheck, rpcCheck, bundleModeCheck } from "./validation.ts";
import type { WalletState, Settings, PublicState, VaultState, ProfileOptions, BitcoinRpc } from "./contracts.ts";
import { FIRST_PROFILE, MAX_PROFILES, createProfile, readProfiles } from "./profiles.ts";

type Engine = Pick<RecoveryEngine, "fundingKey" | "refresh" | "estimate" | "prepare" | "approve" | "advance">;
export class DesktopService {
  private data?: VaultState;
  private get state(): WalletState | undefined { return this.data?.profiles.find((profile) => profile.id === this.data!.activeProfileId)!.wallet; }
  private exists = false;
  private busy = false;
  private lockPending = false;
  private autoRefresh = false;
  private keepUnlocked = false;
  private message = "Create or unlock your encrypted seed vault.";
  private unlockedAt = 0;
  private refreshAt = new Map<string, number>();
  private coordinatorOnline = new Map<string, boolean>();
  constructor(readonly vault: Vault, private readonly engine: Engine = new RecoveryEngine(), private readonly now = Date.now) {}
  async initialize(): Promise<void> { this.exists = await this.vault.exists(); }
  view(): PublicState {
    const state = this.state;
    const bitcoinRpc = this.data?.bitcoinRpc;
    const view: PublicState = {
      exists: this.exists, unlocked: !!state, busy: this.busy, autoRefresh: this.autoRefresh, keepUnlocked: this.keepUnlocked, message: this.message,
      bitcoinRpc: bitcoinRpc ? { url: bitcoinRpc.url, username: bitcoinRpc.username } : undefined, hasRpcPassword: !!bitcoinRpc?.password,
    };
    if (!state) return view;

    const { settings, bundle, session } = state;
    view.activeProfileId = this.data!.activeProfileId;
    view.coordinatorOnline = this.coordinatorOnline.get(this.data!.activeProfileId) ?? false;
    view.profiles = this.data!.profiles.map((profile) => ({
      id: profile.id, label: profile.label, network: profile.wallet.settings.network!,
      bundleCreatedAt: profile.wallet.bundle?.createdAt, exitStatus: profile.wallet.session?.status,
    }));
    view.settings = { accountNumber: settings.accountNumber, network: settings.network, coordinatorUrl: settings.coordinatorUrl, coordinatorCa: settings.coordinatorCa };
    view.identity = bytesToHex(deriveIdentityKeyPair(state.seed, settings.network!, settings.accountNumber).publicKey);
    view.fundingAddress = this.engine.fundingKey(state).address;
    if (bundle) {
      view.bundle = {
        createdAt: bundle.createdAt,
        sats: bundle.leaves.reduce((total, leaf) => total + BigInt(leaf.valueSats!), 0n).toString(),
        leaves: bundle.leaves.filter((leaf) => !state.completed.some((exit) => exit.leafId === leaf.id)).map((leaf) => ({ id: leaf.id, sats: leaf.valueSats! })),
      };
    }
    if (session) {
      view.session = { id: session.id, leafId: session.leafId, destination: session.destination,
        feeRate: session.feeRate, feeSats: session.feeSats, approved: session.approved,
        status: session.status, message: session.message, sweepTxid: session.sweep.sweepTxid };
    }
    return view;
  }
  async create(seed: string, password: string, rawBundle?: string, backupPassword = "", options: ProfileOptions = FIRST_PROFILE) {
    return this.run(async () => {
      if (this.exists) throw new Error("Unlock the existing vault.");
      const profile = await createProfile(seed, options, rawBundle, backupPassword);
      const data: VaultState = { version: 2, activeProfileId: profile.id, profiles: [profile] };
      await this.vault.create(data, password);
      this.data = data; this.exists = true; this.unlockedAt = this.now();
      this.message = "Vault unlocked for 15 minutes. Seed profiles share this vault password.";
    });
  }
  async unlock(password: string) {
    return this.run(async () => {
      if (this.data) throw new Error("The vault is already unlocked.");
      const value = await this.vault.unlock(password);
      try {
        const data = readProfiles(value);
        if ((value as { version: number }).version === 1) await this.vault.save(data);
        this.data = data; this.unlockedAt = this.now();
        this.message = "Vault unlocked. All seed profiles are available.";
      } catch (error) { this.vault.lock(); throw error; }
    });
  }
  async reset(confirmation: unknown, confirm: () => Promise<boolean>): Promise<boolean> {
    return this.run(async () => {
      if (!this.exists || this.data) throw new Error("Reset requires a locked existing vault.");
      if (confirmation !== "RESET") throw new Error("Type RESET exactly to delete local app storage.");
      // Hold the operation lock across the native dialog so unlock/work cannot race deletion.
      if (!await confirm()) return false;
      this.data = undefined; this.vault.lock();
      this.keepUnlocked = false; this.autoRefresh = false; this.lockPending = false;
      this.unlockedAt = 0; this.refreshAt.clear(); this.coordinatorOnline.clear();
      await this.vault.reset();
      this.exists = false;
      this.message = "Local vault storage deleted. Create a new vault using your external seed and recovery bundle.";
      return true;
    });
  }
  async addProfile(seed: string, options: ProfileOptions, rawBundle?: string, backupPassword = "") {
    return this.run(async () => {
      this.requireState();
      if (this.data!.profiles.length >= MAX_PROFILES) throw new Error(`A vault supports up to ${MAX_PROFILES} seed profiles.`);
      const profile = await createProfile(seed, options, rawBundle, backupPassword);
      if (this.data!.profiles.some((p) => p.wallet.seed === profile.wallet.seed && p.wallet.settings.network === profile.wallet.settings.network)) throw new Error("This seed already has a profile on this network.");
      await this.saveData({ ...this.data!, profiles: [...this.data!.profiles, profile], activeProfileId: profile.id });
      this.message = "Seed profile added to the encrypted vault.";
    });
  }
  async selectProfile(id: string) {
    return this.run(async () => {
      this.requireState();
      if (!this.data!.profiles.some((profile) => profile.id === id)) throw new Error("Seed profile not found.");
      await this.saveData({ ...this.data!, activeProfileId: id });
      this.message = "Seed profile selected. Its bundle and exit history are separate.";
    });
  }
  lock(): void {
    this.keepUnlocked = false;
    this.autoRefresh = false;
    if (this.busy) {
      this.lockPending = true;
      this.message = "Locking when the current operation finishes.";
      return;
    }
    this.data = undefined;
    this.refreshAt.clear();
    this.vault.lock();
    this.lockPending = false;
    this.message = "Vault locked. Background work is paused.";
  }
  screenLocked(): void {
    if (!this.keepUnlocked) this.lock();
  }
  setKeepUnlocked(enabled: boolean): void {
    this.requireState();
    if (typeof enabled !== "boolean") throw new Error("Invalid unlock preference.");
    if (this.lockPending) throw new Error("The vault is locking. Unlock it again first.");
    this.keepUnlocked = enabled;
    this.unlockedAt = this.now();
    this.message = enabled
      ? "Kept unlocked until you lock or quit, including on screen lock. All unlocked seeds remain in memory."
      : "Automatic locking restored: 15 minutes from now, or when the screen locks.";
  }
  async configure(settings: Settings) {
    return this.run(async () => {
      const state = this.requireState();
      if (settings.accountNumber !== state.settings.accountNumber) throw new Error("The account is fixed when the vault is created.");
      if ((settings.network ?? "LOCAL") !== state.settings.network) throw new Error("The network is fixed for this seed profile. Add a profile for another network.");
      if (state.session) throw new Error("Finish the current unilateral exit before changing its connection settings.");
      if (settings.bitcoinRpc !== undefined) throw new Error("Use the shared Bitcoin connection setting.");
      await this.saveState({ ...state, settings: settingsCheck(settings) });
      this.message = "Connection settings saved.";
    });
  }
  async configureBitcoin(bitcoinRpc?: BitcoinRpc) {
    return this.run(async () => {
      this.requireState();
      const checked = bitcoinRpc === undefined ? undefined : rpcCheck(bitcoinRpc);
      if (checked && !checked.password) checked.password = this.data!.bitcoinRpc?.password ?? "";
      await this.saveData({ ...this.data!, bitcoinRpc: checked });
      this.message = "Bitcoin connection saved for all mainnet seed profiles.";
    });
  }
  private connectedState(state: WalletState): WalletState {
    return { ...state, settings: this.connectionSettings(state.settings) };
  }
  private connectionSettings(settings: Settings): Settings {
    return { ...settings, bitcoinRpc: settings.network === "MAINNET" ? this.data!.bitcoinRpc : undefined };
  }
  async refresh(profileId = this.data?.activeProfileId, rawMode: unknown = "standard") {
    return this.run(async () => {
      const state = this.requireProfile(profileId).wallet;
      if (state.session) throw new Error("Recovery bundle refresh is paused during a unilateral exit.");
      const mode = bundleModeCheck(rawMode);
      try {
        const bundle = await this.engine.refresh(state, mode);
        await this.saveState({ ...state, bundle }, profileId);
        this.coordinatorOnline.set(profileId!, true);
        this.refreshAt.set(profileId!, this.now()); this.message = "Recovery bundle refreshed. Later changes are not covered.";
      } catch (error) {
        this.coordinatorOnline.set(profileId!, false);
        throw error;
      }
    });
  }
  setAutoRefresh(enabled: boolean): void {
    this.requireState();
    if (typeof enabled !== "boolean") throw new Error("Invalid refresh preference.");
    this.autoRefresh = enabled;
  }
  async importBundle(raw: string, password: string) {
    return this.run(async () => {
      const state = this.requireState();
      if (state.session) throw new Error("Finish the current unilateral exit before importing another recovery bundle.");
      const value = await decodeImportedBundle(raw, state.seed, password);
      const bundle = bundleCheck(value, state.seed, state.settings.accountNumber, state.settings.network);
      await this.saveState({ ...state, bundle });
      this.message = "Recovery bundle imported. Its timestamp does not prove that it contains your latest outputs.";
    });
  }
  async exportBundle(password: string): Promise<string> {
    return this.run(async () => {
      const state = this.requireState();
      if (!state.bundle) throw new Error("There is no recovery bundle to export.");
      if (password === "") return JSON.stringify(state.bundle);
      return encryptBackup(state.bundle, password);
    });
  }
  async estimate(leafId: string, feeRate: number) {
    return this.run(() => this.engine.estimate(this.connectedState(this.requireState()), leafId, feeRate));
  }
  async prepare(leafId: string, destination: string, feeRate: number) {
    return this.run(async () => {
      const state = this.requireState();
      if (state.session) throw new Error("A unilateral exit session already exists.");
      const session = await this.engine.prepare(this.connectedState(state), leafId, destination, feeRate);
      await this.saveState({ ...state, session });
      this.message = "Review the unilateral exit. Nothing has been broadcast.";
    });
  }
  async approve(id: string) {
    return this.run(async () => {
      const state = this.requireState();
      if (!state.session || state.session.id !== id || state.session.status !== "review") throw new Error("This unilateral exit review is no longer current.");
      const next = structuredClone(state);
      this.engine.approve(next);
      await this.saveState(next);
      this.message = "Unilateral exit approved and saved. Submission runs while the vault is unlocked.";
    });
  }
  async advance(profileId = this.data?.activeProfileId) {
    return this.run(async () => {
      const state = this.requireProfile(profileId).wallet;
      if (!state.session || state.session.status !== "running") throw new Error("There is no active approved unilateral exit.");
      // Approval already persisted all signed bytes; a failed status write can
      // only cause an idempotent retry of those exact transactions.
      await this.engine.advance(state.session, this.connectionSettings(state.settings));
      await this.vault.save(this.data!);
    });
  }
  async finish() {
    return this.run(async () => {
      const state = this.requireState();
      if (!state.session || state.session.status === "running") throw new Error("An active unilateral exit cannot be discarded.");
      const next = structuredClone(state);
      if (next.session!.status === "complete") next.completed.push(next.session!);
      delete next.session;
      await this.saveState(next);
    });
  }
  async tick(): Promise<void> {
    if (this.busy || !this.state) return;
    const ids = this.data!.profiles.map((profile) => profile.id);
    const failed: string[] = [];
    for (const id of ids) {
      if (!this.data) break;
      if (!this.keepUnlocked && this.now() - this.unlockedAt >= 15 * 60_000) {
        this.lock();
        break;
      }
      const profile = this.requireProfile(id);
      try {
        if (profile.wallet.session?.status === "running") await this.advance(id);
        else if (this.autoRefresh && !profile.wallet.session && this.now() - (this.refreshAt.get(id) ?? -Infinity) >= (this.keepUnlocked ? 60 * 60_000 : 60_000)) {
          this.refreshAt.set(id, this.now()); await this.refresh(id);
        }
      } catch { failed.push(profile.label); }
    }
    if (this.data && failed.length) this.message = `Background operation failed for ${failed.join(", ")}. Saved state is retained; check its connection settings and retry.`;
  }
  private requireProfile(id: string | undefined) {
    this.requireState();
    const profile = this.data!.profiles.find((profile) => profile.id === id);
    if (!profile) throw new Error("Seed profile not found.");
    return profile;
  }
  private requireState(): WalletState {
    const state = this.state;
    if (!state) throw new Error("Unlock the vault first.");
    return state;
  }
  private async saveState(next: WalletState, id = this.data!.activeProfileId): Promise<void> {
    await this.saveData({ ...this.data!, profiles: this.data!.profiles.map((profile) => profile.id === id ? { ...profile, wallet: next } : profile) });
  }
  private async saveData(next: VaultState): Promise<void> {
    // Publish every profile together only after the encrypted checkpoint is durable.
    await this.vault.save(next);
    this.data = next;
  }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Another operation is still running.");
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
      if (this.lockPending) this.lock();
    }
  }
}
