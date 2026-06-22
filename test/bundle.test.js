import { describe, expect, it } from "vitest";

import {
  BundleValidationError,
  getNodeHexStrings,
  parseRecoveryBundle,
} from "../src/bundle.js";

describe("recovery bundle validation", () => {
  it("parses a valid bundle", () => {
    const bundle = parseRecoveryBundle(
      JSON.stringify({
        schema: "spark.unilateral-exit-bundle.v1",
        createdAt: "2026-06-15T00:00:00.000Z",
        network: "LOCAL",
        leaves: [{ id: "leaf", treeNodeHex: "00", valueSats: 1 }],
      }),
    );

    expect(getNodeHexStrings(bundle)).toEqual(["00"]);
  });

  it("accepts optional ancestor nodes", () => {
    const bundle = parseRecoveryBundle(
      JSON.stringify({
        schema: "spark.unilateral-exit-bundle.v1",
        createdAt: "2026-06-15T00:00:00.000Z",
        network: "LOCAL",
        leaves: [{ id: "leaf", treeNodeHex: "00", valueSats: 1 }],
        nodes: [
          { id: "root", treeNodeHex: "00" },
          { id: "leaf", treeNodeHex: "00" },
        ],
      }),
    );

    expect(bundle.nodes).toHaveLength(2);
  });

  it("rejects seedless bundles without leaves", () => {
    expect(() =>
      parseRecoveryBundle(
        JSON.stringify({
          schema: "spark.unilateral-exit-bundle.v1",
          createdAt: "2026-06-15T00:00:00.000Z",
          network: "LOCAL",
          leaves: [],
        }),
      ),
    ).toThrow(BundleValidationError);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseRecoveryBundle("{")).toThrow(BundleValidationError);
  });

  it("rejects unsupported schemas", () => {
    expect(() =>
      parseRecoveryBundle(
        JSON.stringify({
          schema: "wrong",
          createdAt: "2026-06-15T00:00:00.000Z",
          network: "LOCAL",
          leaves: [{ id: "leaf", treeNodeHex: "00" }],
        }),
      ),
    ).toThrow(/Unsupported bundle schema/);
  });

  it("rejects malformed leaf values", () => {
    expect(() =>
      parseRecoveryBundle(
        JSON.stringify({
          schema: "spark.unilateral-exit-bundle.v1",
          createdAt: "2026-06-15T00:00:00.000Z",
          network: "LOCAL",
          leaves: [{ id: "leaf", treeNodeHex: "not hex" }],
        }),
      ),
    ).toThrow(/treeNodeHex/);
  });

  it("rejects malformed ancestor nodes", () => {
    expect(() =>
      parseRecoveryBundle(
        JSON.stringify({
          schema: "spark.unilateral-exit-bundle.v1",
          createdAt: "2026-06-15T00:00:00.000Z",
          network: "LOCAL",
          leaves: [{ id: "leaf", treeNodeHex: "00" }],
          nodes: [{ id: "root", treeNodeHex: "not hex" }],
        }),
      ),
    ).toThrow(/Node root treeNodeHex/);
  });
});
