#!/usr/bin/env bash
# Seed the tables belonging to TRIVIA_ENV_NAME using Terraform's outputs.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/environment.sh"
trivia_select_environment "$ROOT_DIR"
TF_OUT="$(terraform -chdir="$TRIVIA_TF_DIR" output -json)"
trivia_load_outputs "$TF_OUT"
export DDB_REGION="$(trivia_output "$TF_OUT" ddb_region)"
ROLE_ARN="$(trivia_output "$TF_OUT" api_execution_role_arn)"
[[ -n "$DDB_REGION" && -n "$ROLE_ARN" ]] || {
  echo "✗ Terraform outputs are missing. Run scripts/terraform.sh apply first." >&2
  exit 1
}
trivia_check_account "$ROLE_ARN"
export SERVERLESSQ_TABLE_PREFIX="$TABLE_PREFIX"
exec npm --prefix "$ROOT_DIR" run seed
