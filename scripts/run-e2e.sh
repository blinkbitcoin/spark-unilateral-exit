#!/usr/bin/env bash
#
# Run the Spark local unilateral-exit E2E test end to end: start the local
# Spark stack (postgres, bitcoind, spark-operator-0..2), wait for the operators
# to accept connections, then drive the test suite through the CLI.
#
# The stack is defined by an upstream Spark checkout (docker-compose.yml) plus
# this repo's bitcoind override. Locate the upstream checkout via SPARK_LOCAL_DIR,
# falling back to ./upstream-spark (CI layout) or ../spark (local sibling).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

override="$repo_root/scripts/spark-local-bitcoind29.override.yml"

resolve_spark_dir() {
  if [ -n "${SPARK_LOCAL_DIR:-}" ]; then
    echo "$SPARK_LOCAL_DIR"
  elif [ -d "$repo_root/upstream-spark" ]; then
    echo "$repo_root/upstream-spark"
  elif [ -d "$repo_root/../spark" ]; then
    echo "$repo_root/../spark"
  else
    echo ""
  fi
}

spark_dir="$(resolve_spark_dir)"
if [ -z "$spark_dir" ] || [ ! -f "$spark_dir/docker-compose.yml" ]; then
  echo "Could not find the upstream Spark checkout (docker-compose.yml)." >&2
  echo "Set SPARK_LOCAL_DIR to the upstream Spark repo, or place it at" >&2
  echo "  $repo_root/upstream-spark or $repo_root/../spark" >&2
  exit 1
fi

# Local Spark operators serve self-signed TLS certs, so the SDK cannot verify
# them. Enable the same escape hatch CI uses; allow the caller to override.
export SPARK_DANGEROUSLY_DISABLE_TLS_VERIFICATION="${SPARK_DANGEROUSLY_DISABLE_TLS_VERIFICATION:-true}"

compose() {
  docker compose \
    --project-directory "$spark_dir" \
    -f "$spark_dir/docker-compose.yml" \
    -f "$override" \
    "$@"
}

# Always tear the stack down when the script exits, whether the test passed,
# failed, or the operators never came up.
cleanup() {
  echo "Stopping Spark local stack"
  compose down -v || true
}
trap cleanup EXIT

echo "Starting Spark local stack from $spark_dir"
compose up -d --build \
  postgres bitcoind bitcoin-init spark-operator-0 spark-operator-1 spark-operator-2

# Fail fast with a clear message if the operators never come up, then give them
# a short warmup before exercising the flow.
node scripts/wait-for-spark-local.mjs
sleep 15

# On failure, dump recent Spark logs before the EXIT trap tears the stack down.
if ! npm run test:e2e; then
  echo "E2E test failed; dumping Spark logs" >&2
  compose logs --no-color --tail 300 || true
  exit 1
fi
