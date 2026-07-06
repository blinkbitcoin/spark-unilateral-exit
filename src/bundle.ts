import type {
  BundleLeaf,
  BundleNode,
  RecoveryBundle,
} from "./types.ts";

const SUPPORTED_SCHEMA = "spark.unilateral-exit-bundle.v1";

export class BundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleValidationError";
  }
}

export function parseRecoveryBundle(raw: string): RecoveryBundle {
  let bundle: unknown;
  try {
    bundle = JSON.parse(raw);
  } catch (error) {
    throw new BundleValidationError(
      `Invalid JSON recovery bundle: ${(error as Error).message}`,
    );
  }

  return validateRecoveryBundle(bundle);
}

export function validateRecoveryBundle(bundle: unknown): RecoveryBundle {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new BundleValidationError("Recovery bundle must be a JSON object");
  }
  const record = bundle as Record<string, unknown>;
  if (record.schema !== SUPPORTED_SCHEMA) {
    throw new BundleValidationError(
      `Unsupported bundle schema: ${String(record.schema ?? "missing")}`,
    );
  }
  if (!isIsoDate(record.createdAt)) {
    throw new BundleValidationError("Bundle createdAt must be an ISO timestamp");
  }
  if (!isNonEmptyString(record.network)) {
    throw new BundleValidationError("Bundle network is required");
  }
  if (!Array.isArray(record.leaves) || record.leaves.length === 0) {
    throw new BundleValidationError("Bundle must include at least one leaf");
  }

  const leaves = record.leaves.map((leaf, index) => validateLeaf(leaf, index));
  const nodes = validateNodes(record.nodes);
  return { ...record, leaves, ...(nodes ? { nodes } : {}) } as RecoveryBundle;
}

export function getNodeHexStrings(bundle: RecoveryBundle): string[] {
  return bundle.leaves.map((leaf) => leaf.treeNodeHex);
}

function validateLeaf(leaf: unknown, index: number): BundleLeaf {
  if (!leaf || typeof leaf !== "object" || Array.isArray(leaf)) {
    throw new BundleValidationError(`Leaf ${index} must be an object`);
  }
  const record = leaf as Record<string, unknown>;
  if (!isNonEmptyString(record.id)) {
    throw new BundleValidationError(`Leaf ${index} id is required`);
  }
  if (!isHex(record.treeNodeHex)) {
    throw new BundleValidationError(`Leaf ${record.id} treeNodeHex must be hex`);
  }
  if (record.valueSats !== undefined && !Number.isSafeInteger(record.valueSats)) {
    throw new BundleValidationError(`Leaf ${record.id} valueSats must be an integer`);
  }
  return leaf as BundleLeaf;
}

function validateNodes(nodes: unknown): BundleNode[] | undefined {
  if (nodes === undefined) return undefined;
  if (!Array.isArray(nodes)) {
    throw new BundleValidationError("Bundle nodes must be an array when present");
  }
  return nodes.map((node, index): BundleNode => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new BundleValidationError(`Node ${index} must be an object`);
    }
    const record = node as Record<string, unknown>;
    if (!isNonEmptyString(record.id)) {
      throw new BundleValidationError(`Node ${index} id is required`);
    }
    if (!isHex(record.treeNodeHex)) {
      throw new BundleValidationError(`Node ${record.id} treeNodeHex must be hex`);
    }
    return node as BundleNode;
  });
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && /^[0-9a-fA-F]+$/.test(value);
}
