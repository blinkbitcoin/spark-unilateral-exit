import { expect, it } from "vitest";
import { createProfile, readProfiles, FIRST_PROFILE } from "../../desktop/profiles.ts";
import { profileOptionsCheck, settingsCheck, destinationCheck, rpcCheck } from "../../desktop/validation.ts";
import { p2wpkh } from "@scure/btc-signer";
import { deriveIdentityKeyPair } from "../../src/operator/identity.ts";
import { DEFAULT_SETTINGS } from "../../desktop/contracts.ts";
import { bundle, wallet, SEED, recovery } from "./helpers.ts";
const mainnet = { ...DEFAULT_SETTINGS, network: "MAINNET" as const, coordinatorUrl: "https://0.spark.lightspark.com" };
const rpc = { url: "http://127.0.0.1:8332", username: "bitcoin", password: "private" };
it("creates mainnet profiles, validates imported network ownership, and migrates old bundles and history", async () => {
  const profile = await createProfile(SEED, { label: " Main wallet ", network: "MAINNET" }, JSON.stringify(bundle(1, SEED, "MAINNET")));
  expect(profile.label).toBe("Main wallet"); expect(profile.wallet.settings).toEqual(mainnet);
  await expect(createProfile(SEED, { label: "Main", network: "MAINNET" }, JSON.stringify(bundle()))).rejects.toThrow();
  const legacy = wallet(); legacy.session = recovery(); legacy.completed = [recovery()]; legacy.bundle!.network = "REGTEST";
  const data = readProfiles(legacy); expect(data.profiles[0]!.wallet.bundle!.network).toBe("LOCAL");
  expect(readProfiles({ version: 2, activeProfileId: profile.id, profiles: [profile] })).toMatchObject({ version: 2, activeProfileId: profile.id });
  const bare = await createProfile("01".repeat(64), FIRST_PROFILE);
  expect(readProfiles({ version: 2, activeProfileId: bare.id, profiles: [bare] }).profiles).toHaveLength(1);
});
it("rejects corrupted containers, duplicate identities and missing selected profiles", () => {
  for (const raw of [null, {}, { version: 3 }, { version: 2, profiles: [] }, { version: 2, profiles: Array(51).fill({}) }]) expect(() => readProfiles(raw)).toThrow();
  const profile = () => ({ id: "one", label: "One", wallet: wallet() });
  for (const profiles of [[null], [{ ...profile(), id: null }], [{ ...profile(), id: "" }], [{ ...profile(), id: "x".repeat(81) }], [profile(), profile()], [{ ...profile(), wallet: null }], [{ ...profile(), wallet: { version: 3 } }], [profile(), { ...profile(), id: "two" }]]) {
    expect(() => readProfiles({ version: 2, activeProfileId: "one", profiles })).toThrow();
  }
  expect(() => readProfiles({ version: 2, activeProfileId: "missing", profiles: [profile()] })).toThrow("selected");
});
it("validates immutable profile options, both network destinations and optional own-node credentials", () => {
  for (const value of [null, {}, { label: 1 }, { label: " " }, { label: "x".repeat(61) }, { label: "Wallet", network: "TESTNET" }]) expect(() => profileOptionsCheck(value as any)).toThrow();
  const address = p2wpkh(deriveIdentityKeyPair(SEED, "MAINNET", 1).publicKey).address!;
  expect(destinationCheck(address, "MAINNET")).toBe(address);
  expect(() => destinationCheck("bcrt1invalid", "MAINNET")).toThrow("bc1");
  expect(settingsCheck(mainnet)).toEqual(mainnet);
  expect(settingsCheck({ ...mainnet, bitcoinRpc: rpc }).bitcoinRpc).toEqual(rpc);
  expect(() => settingsCheck({ ...DEFAULT_SETTINGS, bitcoinRpc: rpc })).toThrow("fixed");
  for (const coordinatorUrl of ["http://localhost", "https://a:b@example.com", "https://a@example.com", "https://example.com?q=1", "https://example.com#x", "https://example.com/path"]) expect(() => settingsCheck({ ...mainnet, coordinatorUrl })).toThrow("HTTPS Spark");
  for (const value of [null, {}, { url: 1 }]) expect(() => rpcCheck(value as any)).toThrow("URL");
  for (const url of ["https://localhost", "http://example.com", "http://a:b@localhost", "http://a@localhost", "http://localhost?q=1", "http://localhost#x", "http://localhost/path"]) expect(() => rpcCheck({ ...rpc, url })).toThrow("loopback");
  for (const change of [{ username: null }, { username: "x".repeat(1025) }, { username: "a:b" }, { password: null }, { password: "x".repeat(1025) }]) expect(() => rpcCheck({ ...rpc, ...change } as any)).toThrow("credentials");
});
