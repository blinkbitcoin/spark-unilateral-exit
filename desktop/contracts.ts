import type { RecoveryBundle, LeafPackage, LeafSweep } from "../src/types.ts";

export type Network = "LOCAL" | "MAINNET";
export interface BitcoinRpc { url: string; username: string; password: string }
export interface ProfileOptions { label: string; network: Network }
export interface Settings {
  network?: Network;
  bitcoinRpc?: BitcoinRpc;
  accountNumber: number;
  coordinatorUrl: string;
  coordinatorCa: string;
}
export const DEFAULT_SETTINGS: Settings = {
  accountNumber: 1, coordinatorUrl: "https://localhost:8535", coordinatorCa: "",
};
export interface RecoverySession {
  id: string;
  leafId: string;
  bundle: RecoveryBundle;
  destination: string;
  feeRate: number;
  feeSats: string;
  packages: LeafPackage[];
  sweep: LeafSweep;
  approved: boolean;
  status: "review" | "running" | "complete";
  message: string;
}
export interface WalletState {
  version: 1;
  seed: string;
  settings: Settings;
  bundle?: RecoveryBundle;
  session?: RecoverySession;
  completed: RecoverySession[];
}
export interface SeedProfile { id: string; label: string; wallet: WalletState }
export interface VaultState { bitcoinRpc?: BitcoinRpc; version: 2; activeProfileId: string; profiles: SeedProfile[] }
export type PublicSettings = Omit<Settings, "bitcoinRpc">;
export interface PublicState {
  bitcoinRpc?: Omit<BitcoinRpc, "password">;
  hasRpcPassword?: boolean;
  activeProfileId?: string;
  profiles?: { id: string; label: string; network: Network; bundleCreatedAt?: string; exitStatus?: RecoverySession["status"] }[];
  exists: boolean;
  unlocked: boolean;
  busy: boolean;
  autoRefresh: boolean;
  keepUnlocked: boolean;
  message: string;
  settings?: PublicSettings;
  identity?: string;
  bundle?: { createdAt: string; leaves: { id: string; sats: number }[]; sats: string };
  fundingAddress?: string;
  session?: Pick<RecoverySession, "id" | "leafId" | "destination" | "feeRate" | "feeSats" | "approved" | "status" | "message"> & { sweepTxid: string };
}
