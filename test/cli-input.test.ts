import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSeed, readHiddenLine } from "../src/cli-input.ts";

describe("CLI seed input", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads the Spark seed from a file first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spark-seed-"));
    const seedPath = join(dir, "seed.txt");
    writeFileSync(seedPath, " seed from file \n", { mode: 0o600 });

    try {
      await expect(
        loadSeed({ "seed-file": seedPath, seed: "ignored" }),
      ).resolves.toBe("seed from file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to SPARK_SEED before prompting", async () => {
    vi.stubEnv("SPARK_SEED", " seed from env \n");

    await expect(loadSeed({})).resolves.toBe("seed from env");
  });

  it("prompts without echoing typed or pasted seed content", async () => {
    const input = createTtyInput();
    const output = createTtyOutput();

    const seed = readHiddenLine("Spark seed or mnemonic: ", { input, output });
    input.write("pasted secret seed\n");

    await expect(seed).resolves.toBe("pasted secret seed");
    expect(output.text()).toBe("Spark seed or mnemonic: \n");
    expect(input.rawModes).toEqual([true, false]);
  });
});

function createTtyInput() {
  const input = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    isRaw?: boolean;
    rawModes: boolean[];
    setRawMode?: (mode: boolean) => unknown;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.rawModes = [];
  input.setRawMode = (mode) => {
    input.rawModes.push(mode);
    input.isRaw = mode;
    return input;
  };
  return input;
}

function createTtyOutput() {
  const output = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    write: (chunk: any) => boolean;
    text: () => string;
  };
  let written = "";
  output.isTTY = true;
  output.write = (chunk) => {
    written += chunk.toString("utf8");
    return true;
  };
  output.text = () => written;
  return output;
}
