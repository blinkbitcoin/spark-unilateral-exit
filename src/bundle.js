const SUPPORTED_SCHEMA = "spark.unilateral-exit-bundle.v1";

export class BundleValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "BundleValidationError";
  }
}

export function parseRecoveryBundle(raw) {
  let bundle;
  try {
    bundle = JSON.parse(raw);
  } catch (error) {
    throw new BundleValidationError(`Invalid JSON recovery bundle: ${error.message}`);
  }

  return validateRecoveryBundle(bundle);
}

export function validateRecoveryBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new BundleValidationError("Recovery bundle must be a JSON object");
  }
  if (bundle.schema !== SUPPORTED_SCHEMA) {
    throw new BundleValidationError(
      `Unsupported bundle schema: ${bundle.schema ?? "missing"}`,
    );
  }
  if (!isIsoDate(bundle.createdAt)) {
    throw new BundleValidationError("Bundle createdAt must be an ISO timestamp");
  }
  if (!isNonEmptyString(bundle.network)) {
    throw new BundleValidationError("Bundle network is required");
  }
  if (!Array.isArray(bundle.leaves) || bundle.leaves.length === 0) {
    throw new BundleValidationError("Bundle must include at least one leaf");
  }

  const leaves = bundle.leaves.map((leaf, index) => validateLeaf(leaf, index));
  const nodes = validateNodes(bundle.nodes);
  return { ...bundle, leaves, ...(nodes ? { nodes } : {}) };
}

export function getNodeHexStrings(bundle) {
  return bundle.leaves.map((leaf) => leaf.treeNodeHex);
}

function validateLeaf(leaf, index) {
  if (!leaf || typeof leaf !== "object" || Array.isArray(leaf)) {
    throw new BundleValidationError(`Leaf ${index} must be an object`);
  }
  if (!isNonEmptyString(leaf.id)) {
    throw new BundleValidationError(`Leaf ${index} id is required`);
  }
  if (!isHex(leaf.treeNodeHex)) {
    throw new BundleValidationError(`Leaf ${leaf.id} treeNodeHex must be hex`);
  }
  if (leaf.valueSats !== undefined && !Number.isSafeInteger(leaf.valueSats)) {
    throw new BundleValidationError(`Leaf ${leaf.id} valueSats must be an integer`);
  }
  return leaf;
}

function validateNodes(nodes) {
  if (nodes === undefined) return undefined;
  if (!Array.isArray(nodes)) {
    throw new BundleValidationError("Bundle nodes must be an array when present");
  }
  return nodes.map((node, index) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new BundleValidationError(`Node ${index} must be an object`);
    }
    if (!isNonEmptyString(node.id)) {
      throw new BundleValidationError(`Node ${index} id is required`);
    }
    if (!isHex(node.treeNodeHex)) {
      throw new BundleValidationError(`Node ${node.id} treeNodeHex must be hex`);
    }
    return node;
  });
}

function isIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isHex(value) {
  return typeof value === "string" && value.length > 0 && /^[0-9a-fA-F]+$/.test(value);
}
