import { describe, expect, it } from "vitest";

import { constructSparkPackages } from "../src/spark-packages.ts";
import type { RecoveryBundle } from "../src/types.ts";

describe("Spark package construction", () => {
  it("rejects unsupported Spark networks before constructing packages", async () => {
    await expect(
      constructSparkPackages({
        bundle: {
          network: "NOT_A_NETWORK",
          leaves: [{ treeNodeHex: "00" }],
        } as unknown as RecoveryBundle,
        cpfpUtxos: [],
        feeRate: 1,
      }),
    ).rejects.toThrow(/Unsupported Spark network/);
  });
});
