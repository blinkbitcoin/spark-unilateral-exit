import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  packagesFileLeafIds,
  timestampedBackupPath,
  writeFileWithBackup,
} from "../src/safe-files.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-files-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeFileWithBackup", () => {
  it("writes a new file without creating a backup", () => {
    const target = path.join(dir, "packages.json");
    const result = writeFileWithBackup(target, "{\"a\":1}\n");

    expect(result).toEqual({ backupPath: null, unchanged: false });
    expect(fs.readFileSync(target, "utf8")).toBe("{\"a\":1}\n");
    expect(fs.readdirSync(dir)).toEqual(["packages.json"]);
  });

  it("leaves identical content untouched with no backup clutter", () => {
    const target = path.join(dir, "packages.json");
    writeFileWithBackup(target, "same\n");
    const result = writeFileWithBackup(target, "same\n");

    expect(result).toEqual({ backupPath: null, unchanged: true });
    expect(fs.readdirSync(dir)).toEqual(["packages.json"]);
  });

  it("never destroys different content: the old bytes survive in a backup", () => {
    const target = path.join(dir, "packages.json");
    writeFileWithBackup(target, "old recovery\n");
    const result = writeFileWithBackup(target, "new recovery\n");

    expect(result.unchanged).toBe(false);
    expect(result.backupPath).toMatch(/packages\.\d{8}T\d{6}Z\.backup\.json$/);
    expect(fs.readFileSync(result.backupPath!, "utf8")).toBe("old recovery\n");
    expect(fs.readFileSync(target, "utf8")).toBe("new recovery\n");
  });

  it("keeps every generation distinct when overwriting within the same second", () => {
    const target = path.join(dir, "packages.json");
    writeFileWithBackup(target, "gen-1\n");
    const second = writeFileWithBackup(target, "gen-2\n");
    const third = writeFileWithBackup(target, "gen-3\n");

    expect(second.backupPath).not.toBe(third.backupPath);
    expect(fs.readFileSync(second.backupPath!, "utf8")).toBe("gen-1\n");
    expect(fs.readFileSync(third.backupPath!, "utf8")).toBe("gen-2\n");
    expect(fs.readFileSync(target, "utf8")).toBe("gen-3\n");
  });

  it("uses a plain .backup suffix for non-json files", () => {
    const target = path.join(dir, "seedless.txt");
    writeFileWithBackup(target, "one");
    const result = writeFileWithBackup(target, "two");

    expect(result.backupPath).toMatch(/seedless\.txt\.\d{8}T\d{6}Z\.backup$/);
  });
});

describe("timestampedBackupPath", () => {
  it("suffixes .json files before the extension", () => {
    expect(timestampedBackupPath(path.join(dir, "bundle.json"))).toMatch(
      /bundle\.\d{8}T\d{6}Z\.backup\.json$/,
    );
  });
});

describe("packagesFileLeafIds", () => {
  it("reads leaf ids from wrapped and bare package lists", () => {
    const wrapped = path.join(dir, "wrapped.json");
    fs.writeFileSync(
      wrapped,
      JSON.stringify({
        purpose: "label",
        packages: [{ leafId: "leaf-a" }, { leafId: "leaf-b" }, { noId: true }],
      }),
    );
    const bare = path.join(dir, "bare.json");
    fs.writeFileSync(bare, JSON.stringify([{ leafId: "leaf-c" }]));

    expect(packagesFileLeafIds(wrapped)).toEqual(["leaf-a", "leaf-b"]);
    expect(packagesFileLeafIds(bare)).toEqual(["leaf-c"]);
  });

  it("returns [] for missing files and null for corrupt ones so callers can warn", () => {
    expect(packagesFileLeafIds(path.join(dir, "missing.json"))).toEqual([]);
    const corrupt = path.join(dir, "corrupt.json");
    fs.writeFileSync(corrupt, "not json");
    expect(packagesFileLeafIds(corrupt)).toBeNull();
    const wrongShape = path.join(dir, "wrong-shape.json");
    fs.writeFileSync(wrongShape, JSON.stringify({ packages: "nope" }));
    expect(packagesFileLeafIds(wrongShape)).toBeNull();
  });
});
