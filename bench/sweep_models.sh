#!/bin/bash
# Sweep the model cost/quality bench across flash/pro x thinking on/off.
# One PROCESS PER CONFIG (model + thinking are read at module load, so they
# can't be switched in-process). Sequential. Then prints the cross-config report.
#
# Override models / scope via env:
#   FLASH_MODEL=deepseek-v4-flash  PRO_MODEL=deepseek-v4-pro
#   BENCH_SCENARIOS=all | finance | data_science | real_estate | key1,key2
#   BENCH_JUDGE_MODEL=<fixed strong model>   (default = PRO)
#
# Usage:  bash bench/sweep_models.sh        (needs DEEPSEEK_API_KEY in .env — spends tokens)
set -e
cd "$(dirname "$0")/.."

FLASH="${FLASH_MODEL:-deepseek-v4-flash}"
PRO="${PRO_MODEL:-deepseek-v4-pro}"
export BENCH_JUDGE_MODEL="${BENCH_JUDGE_MODEL:-$PRO}"
export BENCH_SCENARIOS="${BENCH_SCENARIOS:-all}"
# Run scenarios concurrently within each config (DeepSeek concurrency limit:
# flash 2500, pro 500 — plenty of room). Drops a 9-scenario config from ~30 min
# sequential to ~5 min parallel. Per-scenario token attribution becomes the even
# split of the config total; per-config sums in the report stay exact.
export BENCH_PARALLEL="${BENCH_PARALLEL:-true}"
export BENCH_CONCURRENCY="${BENCH_CONCURRENCY:-5}"

run() { # label model thinking
  echo ""
  echo "############ CONFIG: $1  ($2, thinking=$3) ############"
  BENCH_CONFIG_LABEL="$1" BENCH_AGENT_MODEL="$2" BENCH_THINKING="$3" node bench/model_cost_quality.js
}

run "flash-no-thinking" "$FLASH" "none"
run "flash-full"        "$FLASH" "full"
run "pro-no-thinking"   "$PRO"   "none"
run "pro-full"          "$PRO"   "full"

echo ""
echo "############ CROSS-CONFIG REPORT ############"
node bench/model_cost_quality_report.js
