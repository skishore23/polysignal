#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_DIR="${ROOT_DIR}/reports/refactor-baseline"
mkdir -p "${BASE_DIR}"

SMOKE_SECONDS="${SMOKE_SECONDS:-600}"
SMOKE_WORKER_PORT="${SMOKE_WORKER_PORT:-3901}"
SMOKE_RAW_LOG="${BASE_DIR}/.baseline_smoke_raw.log"

TEST_REPORT="${BASE_DIR}/baseline_test_report.txt"
LINT_REPORT="${BASE_DIR}/baseline_lint_report.txt"
TYPECHECK_REPORT="${BASE_DIR}/baseline_typecheck_report.txt"
BUILD_REPORT="${BASE_DIR}/baseline_build_report.txt"
COMMANDS_REPORT="${BASE_DIR}/baseline_commands.md"

run_capture() {
  local name="$1"
  local out="$2"
  shift 2
  echo "[verify_baseline] ${name}"
  "$@" 2>&1 | tee "${out}"
}

cat > "${COMMANDS_REPORT}" <<EOF
# Baseline Commands

Generated at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

## Suite

1. \`pnpm test\`
2. \`pnpm lint\`
3. \`pnpm typecheck\`
4. \`pnpm build\`
5. Smoke run for \`${SMOKE_SECONDS}\` seconds:

\`\`\`bash
NODE_ENV=production \
WORKER_PORT=${SMOKE_WORKER_PORT} \
EXECUTION_MODE=paper \
LOOP_TRACE_DEBUG=1 \
DEBUG_REACHABILITY=1 \
DEBUG_REACHABILITY_OUT="${BASE_DIR}/runtime_reachability.json" \
pnpm --filter @polysignal/worker run dev
\`\`\`

7. \`npx tsx scripts/extract-baseline-metrics.ts --input ${SMOKE_RAW_LOG} --excerpt ${BASE_DIR}/baseline_smoke_log_excerpt.jsonl --metrics ${BASE_DIR}/baseline_key_metrics.json\`
EOF

run_capture "tests" "${TEST_REPORT}" pnpm test
run_capture "lint" "${LINT_REPORT}" pnpm lint
run_capture "typecheck" "${TYPECHECK_REPORT}" pnpm typecheck
run_capture "build" "${BUILD_REPORT}" pnpm build
if command -v lsof >/dev/null 2>&1; then
  pids="$(lsof -ti :"${SMOKE_WORKER_PORT}" 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "[verify_baseline] clearing existing process(es) on port ${SMOKE_WORKER_PORT}: ${pids}"
    kill ${pids} 2>/dev/null || true
    sleep 1
    stubborn="$(lsof -ti :"${SMOKE_WORKER_PORT}" 2>/dev/null || true)"
    if [[ -n "${stubborn}" ]]; then
      kill -9 ${stubborn} 2>/dev/null || true
    fi
  fi
fi

echo "[verify_baseline] smoke run (${SMOKE_SECONDS}s)"
rm -f "${SMOKE_RAW_LOG}"
(
  cd "${ROOT_DIR}"
  NODE_ENV=production \
  WORKER_PORT="${SMOKE_WORKER_PORT}" \
  EXECUTION_MODE=paper \
  LOOP_TRACE_DEBUG=1 \
  DEBUG_REACHABILITY=1 \
  DEBUG_REACHABILITY_OUT="${BASE_DIR}/runtime_reachability.json" \
  pnpm --filter @polysignal/worker run dev > "${SMOKE_RAW_LOG}" 2>&1
) &
worker_pid=$!

for ((i=0; i<SMOKE_SECONDS; i+=1)); do
  if ! kill -0 "${worker_pid}" 2>/dev/null; then
    if wait "${worker_pid}"; then
      rc=0
    else
      rc=$?
    fi
    echo "[verify_baseline] worker exited before smoke duration (rc=${rc})."
    exit "${rc}"
  fi
  sleep 1
done

kill -TERM "${worker_pid}" 2>/dev/null || true
if wait "${worker_pid}"; then
  worker_rc=0
else
  worker_rc=$?
fi
if [[ "${worker_rc}" -ne 0 && "${worker_rc}" -ne 130 && "${worker_rc}" -ne 137 && "${worker_rc}" -ne 143 ]]; then
  echo "[verify_baseline] worker exited non-zero after smoke stop (rc=${worker_rc})."
  exit "${worker_rc}"
fi

run_capture "extract smoke metrics" "${BASE_DIR}/baseline_metrics_report.txt" \
  npx tsx scripts/extract-baseline-metrics.ts \
    --input "${SMOKE_RAW_LOG}" \
    --excerpt "${BASE_DIR}/baseline_smoke_log_excerpt.jsonl" \
    --metrics "${BASE_DIR}/baseline_key_metrics.json"

echo "[verify_baseline] baseline verification complete."
