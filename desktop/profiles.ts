import { randomUUID } from "node:crypto";
import { bytesToHex } from "@noble/curves/utils";
import { parseSeed } from "../src/sweep.ts";
import { deriveIdentityKeyPair } from "../src/operator/identity.ts";
import { decodeImportedBundle } from "./import-bundle.ts";
import { bundleCheck, profileOptionsCheck, settingsCheck, rpcCheck } from "./validation.ts";
import { DEFAULT_SETTINGS, type ProfileOptions, type SeedProfile, type VaultState, type WalletState } from "./contracts.ts";

export const MAX_PROFILES = 50;
export const FIRST_PROFILE: ProfileOptions = { label: "Seed 1", network: "LOCAL" };
export async function createProfile(seed: string, options: ProfileOptions, rawBundle?: string, backupPassword = ""): Promise<SeedProfile> {
  options = profileOptionsCheck(options);
  if (typeof seed !== "string" || seed.length > 2048) throw new Error("Invalid seed input.");
  const wallet: WalletState = { version: 1, seed: bytesToHex(parseSeed(seed)), settings: {
    ...DEFAULT_SETTINGS, network: options.network,
    coordinatorUrl: options.network === "MAINNET" ? "https://0.spark.lightspark.com" : DEFAULT_SETTINGS.coordinatorUrl,
  }, completed: [] };
  if (rawBundle !== undefined) {
    const imported = await decodeImportedBundle(rawBundle, wallet.seed, backupPassword);
    const account = [1, 0].find((number) => bytesToHex(deriveIdentityKeyPair(wallet.seed, options.network, number).publicKey) === imported.walletIdentityPublicKey);
    if (account === undefined) throw new Error("Backup does not match this seed at the supported default accounts.");
    wallet.settings.accountNumber = account;
    wallet.bundle = bundleCheck(imported, wallet.seed, account, options.network);
  }
  return { id: randomUUID(), label: options.label, wallet };
}
export function readProfiles(raw: unknown): VaultState {
  const value = raw as VaultState | WalletState;
  if (!value || ![1, 2].includes(value.version)) throw new Error("Unsupported vault format.");
  const data: VaultState = value.version === 1
    ? { version: 2, activeProfileId: "seed-1", profiles: [{ id: "seed-1", label: "Seed 1", wallet: value }] }
    : value;
  if (!Array.isArray(data.profiles) || !data.profiles.length || data.profiles.length > MAX_PROFILES) throw new Error("Invalid vault profiles.");
  if (data.bitcoinRpc !== undefined) data.bitcoinRpc = rpcCheck(data.bitcoinRpc);
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const profile of data.profiles) {
    if (!profile || typeof profile.id !== "string" || !profile.id || profile.id.length > 80 || ids.has(profile.id)) throw new Error("Invalid or duplicate seed profile ID.");
    ids.add(profile.id);
    const wallet = profile.wallet;
    if (!wallet || wallet.version !== 1 || !Array.isArray(wallet.completed)) throw new Error("Unsupported seed profile format.");
    wallet.seed = bytesToHex(parseSeed(wallet.seed));
    wallet.settings = settingsCheck(wallet.settings);
    profile.label = profileOptionsCheck({ label: profile.label, network: wallet.settings.network! }).label;
    const identity = `${wallet.settings.network}:${wallet.seed}`;
    if (identities.has(identity)) throw new Error("This seed already has a profile on this network.");
    identities.add(identity);
    if (wallet.bundle) wallet.bundle = bundleCheck(wallet.bundle, wallet.seed, wallet.settings.accountNumber, wallet.settings.network);
    for (const session of [...wallet.completed, ...(wallet.session ? [wallet.session] : [])]) {
      session.bundle = bundleCheck(session.bundle, wallet.seed, wallet.settings.accountNumber, wallet.settings.network);
    }
  }
  if (!ids.has(data.activeProfileId)) throw new Error("The selected seed profile is missing.");
  return data;
}
