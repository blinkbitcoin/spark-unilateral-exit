import fs from "node:fs";

export async function loadSeed(args, options = {}) {
  if (args["seed-file"] && args["seed-file"] !== true) {
    return fs.readFileSync(args["seed-file"], "utf8").trim();
  }
  if (args.seed && args.seed !== true) return String(args.seed).trim();
  if (process.env.SPARK_SEED) return process.env.SPARK_SEED.trim();
  return readHiddenLine("Spark seed or mnemonic: ", options);
}

export function readHiddenLine(
  prompt,
  { input = process.stdin, output = process.stderr } = {},
) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(
      "--seed-file, --seed, SPARK_SEED, or an interactive terminal is required",
    );
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(Boolean(wasRaw));
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

    const onData = (chunk) => {
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

    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    output.write(prompt);
  });
}
