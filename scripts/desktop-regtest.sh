#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
spark_dir="${SPARK_LOCAL_DIR:-$repo_root/../spark}"
compose() {
  docker compose -p spark-desktop-pilot --project-directory "$spark_dir" \
    -f "$spark_dir/docker-compose.yml" -f "$repo_root/scripts/spark-local-bitcoind29.override.yml" \
    -f "$repo_root/desktop/regtest.compose.yml" "$@"
}
case "${1:-test}" in
  up)
    compose up -d --build postgres bitcoind bitcoin-init spark-operator-0 spark-operator-1 spark-operator-2
    node scripts/wait-for-spark-local.mjs
    cols="id, create_time, update_time, status, secret_share, public_shares, public_key, min_signers, coordinator_index"
    for i in 0 1 2; do
      for attempt in $(seq 1 60); do
        if [ "$(compose exec -T postgres psql -tAqc "SELECT to_regclass('public.signing_keyshares');" -U postgres -d "sparkoperator_$i" 2>/dev/null)" = signing_keyshares ]; then break; fi
        sleep 1
      done
      # Load only on a fresh fixture set; reruns preserve existing test data.
      fixture_id="$(head -1 "test/fixtures/keyshares/sparkoperator_$i.copy" | cut -f1)"
      if [ "$(compose exec -T postgres psql -tAqc "SELECT count(*) FROM signing_keyshares WHERE id = '$fixture_id';" -U postgres -d "sparkoperator_$i")" = 0 ]; then
        compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d "sparkoperator_$i" -c "COPY signing_keyshares ($cols) FROM STDIN" < "test/fixtures/keyshares/sparkoperator_$i.copy"
      fi
    done
    ;;
  offline) compose stop spark-operator-0 spark-operator-1 spark-operator-2 ;;
  online) compose start spark-operator-0 spark-operator-1 spark-operator-2 ;;
  stop) compose stop ;;
  test) RUN_DESKTOP_REGTEST=1 npm run desktop:test:ui ;;
  *) echo "Usage: $0 {up|offline|online|stop|test}" >&2; exit 1 ;;
esac
