#!/usr/bin/env bash
# Run Terraform in the workspace selected by TRIVIA_ENV_NAME.
#   export TRIVIA_ENV_NAME=demo1
#   scripts/terraform.sh init
#   scripts/terraform.sh apply
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/environment.sh"
trivia_select_environment "$ROOT_DIR"
exec terraform -chdir="$TRIVIA_TF_DIR" "$@"
