#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if rg -n 'observability_|enable_client_telemetry|publisher_principal_arns|client_publisher|aws_cloudwatch_dashboard|aws_lambda_function\.widget|dashboard_detail_widgets|dashboard_function_name|var\.endpoint_name' \
  "$REPO_ROOT/infra/terraform" --glob '*.tf' --glob '*.tftest.hcl' --glob '*.tfvars.example'; then
  echo "retained Terraform still depends on presentation infrastructure" >&2
  exit 1
fi

printf 'retained Terraform has no presentation dependencies: PASS\n'
