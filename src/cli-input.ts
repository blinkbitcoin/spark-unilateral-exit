import fs from "node:fs";

import type { CliArgs } from "./types.ts";

interface HiddenLineInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  off(event: "data", listener: (chunk: Buffer) => void): unknown;
  pause(): unknown;
  resume(): unknown;
}

interface HiddenLineOutput {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface SeedPromptOptions {
  input?: HiddenLineInput;
  output?: HiddenLineOutput;
}

export async function loadSeed(
  args: CliArgs,
  options: SeedPromptOptions = {},
): Promise<string> {
  if (args["seed-file"] && args["seed-file"] !== true) {
    return fs.readFileSync(args["seed-file"] as string, "utf8").trim();
  }
  if (args.seed && args.seed !== true) {
    console.error(
      "Warning: --seed exposes the seed in the process list and shell history; prefer --seed-file or the SPARK_SEED environment variable",
    );
    return String(args.seed).trim();
  }
  if (process.env.SPARK_SEED) return process.env.SPARK_SEED.trim();
  return readHiddenLine("Spark seed or mnemonic: ", options);
}

export function readHiddenLine(
  prompt: string,
  {
    input = process.stdin as unknown as HiddenLineInput,
    output = process.stderr as unknown as HiddenLineOutput,
  }: SeedPromptOptions = {},
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(
      "--seed-file, --seed, SPARK_SEED, or an interactive terminal is required",
    );
  }

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;

    // The `setRawMode!` assertions below are safe: the guard at the top of
    // this function rejects inputs without a setRawMode function, but TS
    // cannot carry that narrowing into these closures.
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode!(Boolean(wasRaw));
      input.pause();
    };

    const finish = () => {
      cleanup();
      output.write("\n");
      const seed = value.trim();
      if (!seed) {
        reject(new Error("Spark seed or mnemonic is required"));
        return;
      }
      resolve(seed);
    };

    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("Seed prompt cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    };

    input.setRawMode!(true);
    input.resume();
    input.on("data", onData);
    output.write(prompt);
  });
}
