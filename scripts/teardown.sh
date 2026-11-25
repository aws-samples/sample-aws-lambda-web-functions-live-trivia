#!/usr/bin/env bash
#
# teardown.sh — destroy the whole ServerlessQ environment, in the order AWS
# actually requires. Counterpart to deploy.sh.
#
#   scripts/teardown.sh              # prompts for confirmation
#   scripts/teardown.sh --yes        # no prompt (CI / scripted rebuilds)
#   scripts/teardown.sh --dry-run    # print what WOULD be destroyed, touch nothing
#
# Order matters, and two steps exist because Terraform cannot do them:
#
#   1. The Lambda Web Functions are created by deploy.sh, NOT by Terraform, so
#      `terraform destroy` leaves them running against deleted roles and tables.
#      They have to be deleted explicitly, and first, so nothing is still serving
#      traffic while its data plane disappears underneath it.
#   2. Log groups are created by the Lambda service, so Terraform never owns them
#      and they outlive both the function and the stack.
#
# Everything is idempotent: each step skips what is already gone, so this is safe
# to re-run against a half-torn-down environment.
#
# Env overrides:
#   TRIVIA_ENV_NAME   selects the environment to destroy
#   REGION            defaults to the Terraform primary_region, else AWS_REGION
#   API_FUNCTION      defaults to serverlessq-api
#   WEB_FUNCTION      defaults to serverlessq-web
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$ROOT_DIR/infra/terraform"
source "$ROOT_DIR/scripts/environment.sh"
trivia_select_environment "$ROOT_DIR"
ASSUME_YES=0
DRY_RUN=0

log() { printf '\033[1;93m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
skip() { printf '\033[0;90m· %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --yes | -y) ASSUME_YES=1 ;;
    --dry-run | -n) DRY_RUN=1 ;;
    *) die "Unknown argument '$arg' (expected: --yes | --dry-run)" ;;
  esac
done

command -v jq >/dev/null 2>&1 || die "jq is required"

# ── Resolve targets ──────────────────────────────────────────────────────────
# Read from Terraform when there is still state to read. After a previous
# teardown the state is empty and `output` returns nothing, so every value falls
# back to the same convention the Terraform itself uses — that is what keeps a
# re-run able to finish a job it started.
TF_OUT="$(terraform -chdir="$TF_DIR" output -json)" || die "Cannot read this environment's Terraform outputs"
tf_out() { jq -r --arg k "$1" '.[$k].value // empty' <<<"$TF_OUT"; }
if jq -e 'length > 0' <<<"$TF_OUT" >/dev/null; then
  trivia_load_outputs "$TF_OUT"
else
  # A successfully destroyed local state has no outputs. Restrict reruns to
  # this environment's known names rather than falling back to the shared ones.
  TRIVIA_API_NAME="$TRIVIA_RESOURCE_PREFIX-api"
  TRIVIA_WEB_NAME="$TRIVIA_RESOURCE_PREFIX-web"
  if [[ -n "${TRIVIA_ENV_NAME:-}" && -n "${TABLE_PREFIX+x}" && "$TABLE_PREFIX" != "$TRIVIA_ENV_NAME-" ]]; then
    die "TABLE_PREFIX differs from the selected environment. Unset TABLE_PREFIX and retry."
  fi
  TABLE_PREFIX="${TABLE_PREFIX:-${TRIVIA_ENV_NAME:+$TRIVIA_ENV_NAME-}}"
fi
API_FUNCTION="${API_FUNCTION:-$TRIVIA_API_NAME}"
WEB_FUNCTION="${WEB_FUNCTION:-$TRIVIA_WEB_NAME}"
trivia_check_function "$API_FUNCTION" "$TRIVIA_API_NAME"
trivia_check_function "$WEB_FUNCTION" "$TRIVIA_WEB_NAME"
FUNCTIONS=("$WEB_FUNCTION" "$API_FUNCTION")
FUNCTION_NAMES="$(printf '%s\n' "${FUNCTIONS[@]}" | sort -u | awk 'BEGIN {s=""} {printf "%s%s", s, $0; s=", "} END {printf "\n"}')"
TABLE_NAMES="$(tf_out table_names)"
if [[ -z "$TABLE_NAMES" ]]; then
  TABLE_NAMES="$(jq -n --arg prefix "$TABLE_PREFIX" \
    '["question-sets", "questions", "games", "participants", "answers", "scores"]
     | map($prefix + "serverlessq-" + .)')"
fi

REGION="${REGION:-$(tf_out primary_region)}"
REGION="${REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
[[ -n "$REGION" ]] || die "Cannot determine the region — set REGION=<region>"
STACK_REGION="$(tf_out primary_region)"
if [[ -n "$STACK_REGION" && "$REGION" != "$STACK_REGION" ]]; then
  die "REGION differs from this Terraform environment's region"
fi
SERVING_REGIONS=()
while IFS= read -r serving_region; do
  [[ -n "$serving_region" ]] && SERVING_REGIONS+=("$serving_region")
done < <(jq -r '.regions.value[]? // empty' <<<"$TF_OUT")
if [[ "${#SERVING_REGIONS[@]}" -eq 0 ]]; then
  SERVING_REGIONS=("$REGION")
fi
if ! printf '%s\n' "${SERVING_REGIONS[@]}" | grep -Fxq "$REGION"; then
  SERVING_REGIONS+=("$REGION")
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --region "$REGION")" ||
  die "Unable to resolve the AWS account — check your credentials"
STACK_ROLE="$(tf_out api_execution_role_arn)"
if [[ -n "$STACK_ROLE" && "$(cut -d: -f5 <<<"$STACK_ROLE")" != "$ACCOUNT_ID" ]]; then
  die "AWS credentials do not match this Terraform environment's account"
fi

CODE_BUCKET="$(tf_out code_bucket)"
if [[ -z "$CODE_BUCKET" ]]; then
  CODE_BUCKET="$TRIVIA_RESOURCE_PREFIX-web-code-$ACCOUNT_ID-$REGION"
  if [[ "${#CODE_BUCKET}" -gt 63 ]]; then
    CODE_BUCKET="$TRIVIA_RESOURCE_PREFIX-$ACCOUNT_ID-$REGION"
  fi
fi
COGNITO_USER_POOL_ID="$(tf_out cognito_user_pool_id)"
TF_STATE="$(terraform -chdir="$TF_DIR" state list)" || die "Cannot read this environment's Terraform state"
TF_RESOURCES="$(awk 'NF {n++} END {print n+0}' <<<"$TF_STATE")"

cat <<SUMMARY

  Account          $ACCOUNT_ID
  Environment      ${TRIVIA_ENV_NAME:-default (original deployment)}
  Region           $REGION
  Web Functions    $FUNCTION_NAMES (+ all endpoints and revisions)
  Terraform state  $TF_RESOURCES resource instance(s) — tables, IAM, S3, Cognito
  Code bucket      $CODE_BUCKET  (all object versions)
  Cognito pool     ${COGNITO_USER_POOL_ID:-managed in Terraform state}  (users and groups)
  Log groups       Exact groups, .local companions, and subgroups for the functions above

  This destroys this environment's question pool, games, and public endpoints.
  New URLs are generated on the next deploy.

SUMMARY

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Dry run — nothing was touched."
  exit 0
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  # A typed word, not y/N: this is unrecoverable, so a stray keystroke must not
  # be enough to trigger it.
  read -r -p "Type 'destroy' to proceed: " reply
  [[ "$reply" == "destroy" ]] || die "Aborted — nothing was destroyed."
fi
CLEANUP_DIR="$(mktemp -d)"
trap 'rm -rf "$CLEANUP_DIR"' EXIT

# ── 1. Web Functions (not Terraform-managed) ─────────────────────────────────
# `</dev/null` on both calls for the same reason as section 4: the CLI reads stdin,
# and inside a loop that eats the rest of the script.
while IFS= read -r FN; do
  if aws lambda-web get-web-function --function-name "$FN" --region "$REGION" </dev/null >/dev/null 2>&1; then
    log "Deleting web function $FN (cascades endpoints + revisions)"
    aws lambda-web delete-web-function --function-name "$FN" --region "$REGION" </dev/null
  else
    skip "Web function $FN already gone"
  fi
done < <(printf '%s\n' "${FUNCTIONS[@]}" | sort -u)

# ── 2. Log groups (service-created, never Terraform-owned) ───────────────────
# Clean these before Terraform state disappears. If a regional cleanup fails,
# the retained state preserves the complete serving-region list for a safe retry.
# Every aws call in this section redirects stdin from /dev/null. The CLI reads
# stdin, and a command that does so inside a loop swallows the rest of the script
# — the loop body silently stops after the call and the remaining log groups are
# never deleted. Cheap to prevent, very easy to misread as "nothing to delete".
matching_log_groups() {
  local prefix="$1"
  local include_base="$2"
  jq -r --arg prefix "$prefix" --argjson include_base "$include_base" '
    .logGroups[]?.logGroupName
    | select(
        (. == ($prefix + ".local")) or
        startswith($prefix + ".local/") or
        ($include_base and (. == $prefix or startswith($prefix + "/")))
      )
  '
}

LOG_GROUP_COUNT=0
while IFS= read -r LOG_REGION; do
  [[ -n "$LOG_REGION" ]] || continue
  INCLUDE_BASE=false
  [[ "$LOG_REGION" == "$REGION" ]] && INCLUDE_BASE=true
  while IFS= read -r FN; do
    PREFIX="/aws/lambda/web/$FN"
    FOUND="$(aws logs describe-log-groups --log-group-name-prefix "$PREFIX" \
      --region "$LOG_REGION" --output json </dev/null 2>/dev/null)" ||
      die "Unable to inspect log groups for $FN in $LOG_REGION"
    MATCHES="$(matching_log_groups "$PREFIX" "$INCLUDE_BASE" <<<"$FOUND")"
    [[ -n "$MATCHES" ]] || continue
    while IFS= read -r GROUP; do
      [[ -n "$GROUP" ]] || continue
      log "Deleting log group $GROUP in $LOG_REGION"
      aws logs delete-log-group --log-group-name "$GROUP" \
        --region "$LOG_REGION" </dev/null
      LOG_GROUP_COUNT=$((LOG_GROUP_COUNT + 1))
    done <<<"$MATCHES"
  done < <(printf '%s\n' "${FUNCTIONS[@]}" | sort -u)
done < <(printf '%s\n' "${SERVING_REGIONS[@]}" | sort -u)
if [[ "$LOG_GROUP_COUNT" -eq 0 ]]; then
  skip "No exact function log groups found in the configured serving regions"
fi

LOG_LEFTOVERS=0
while IFS= read -r LOG_REGION; do
  [[ -n "$LOG_REGION" ]] || continue
  INCLUDE_BASE=false
  [[ "$LOG_REGION" == "$REGION" ]] && INCLUDE_BASE=true
  while IFS= read -r FN; do
    PREFIX="/aws/lambda/web/$FN"
    FOUND="$(aws logs describe-log-groups --log-group-name-prefix "$PREFIX" \
      --region "$LOG_REGION" --output json </dev/null 2>/dev/null)" ||
      die "Unable to verify log groups for $FN in $LOG_REGION"
    while IFS= read -r GROUP; do
      [[ -n "$GROUP" ]] || continue
      warn "STILL PRESENT: log group $GROUP in $LOG_REGION"
      LOG_LEFTOVERS=$((LOG_LEFTOVERS + 1))
    done < <(matching_log_groups "$PREFIX" "$INCLUDE_BASE" <<<"$FOUND")
  done < <(printf '%s\n' "${FUNCTIONS[@]}" | sort -u)
done < <(printf '%s\n' "${SERVING_REGIONS[@]}" | sort -u)
[[ "$LOG_LEFTOVERS" -eq 0 ]] ||
  die "$LOG_LEFTOVERS log group(s) survived — Terraform state was retained for a safe retry"

# ── 3. Terraform stack ───────────────────────────────────────────────────────
# force_destroy on the code bucket means the versioned objects go with it, so no
# manual purge step is needed here any more.
if [[ "$TF_RESOURCES" -gt 0 ]]; then
  log "terraform destroy ($TF_RESOURCES resource instances)"
  # The shared tfvars may target another region. Destroy must use the region
  # recorded in this environment's state, including when a var file was used.
  terraform -chdir="$TF_DIR" destroy -auto-approve -var="primary_region=$REGION"
else
  skip "Terraform state is already empty"
fi

# ── 4. Belt and braces: the code bucket ──────────────────────────────────────
# Terraform owns the bucket; clean up versions if it outlives Terraform.
if aws s3api head-bucket --bucket "$CODE_BUCKET" --region "$REGION" >/dev/null 2>&1; then
  warn "Bucket $CODE_BUCKET outlived Terraform — purging versions and deleting"
  aws s3api list-object-versions --bucket "$CODE_BUCKET" --region "$REGION" \
    --output json --query '{Objects: (Versions[].{Key:Key,VersionId:VersionId} || `[]`)}' \
    >"$CLEANUP_DIR/versions.json"
  if [[ "$(jq '.Objects | length' "$CLEANUP_DIR/versions.json")" -gt 0 ]]; then
    aws s3api delete-objects --bucket "$CODE_BUCKET" --region "$REGION" \
      --delete "file://$CLEANUP_DIR/versions.json" >/dev/null
  fi
  aws s3api list-object-versions --bucket "$CODE_BUCKET" --region "$REGION" \
    --output json --query '{Objects: (DeleteMarkers[].{Key:Key,VersionId:VersionId} || `[]`)}' \
    >"$CLEANUP_DIR/markers.json"
  if [[ "$(jq '.Objects | length' "$CLEANUP_DIR/markers.json")" -gt 0 ]]; then
    aws s3api delete-objects --bucket "$CODE_BUCKET" --region "$REGION" \
      --delete "file://$CLEANUP_DIR/markers.json" >/dev/null
  fi
  aws s3api delete-bucket --bucket "$CODE_BUCKET" --region "$REGION"
else
  skip "Code bucket $CODE_BUCKET already gone"
fi

# ── 5. Verify ────────────────────────────────────────────────────────────────
log "Verifying nothing is left"
LEFTOVERS=0
check() { # label, command...
  local label="$1"
  shift
  if "$@" </dev/null >/dev/null 2>&1; then
    warn "STILL PRESENT: $label"
    LEFTOVERS=$((LEFTOVERS + 1))
  fi
}
while IFS= read -r FN; do
  check "web function $FN" aws lambda-web get-web-function --function-name "$FN" --region "$REGION"
done < <(printf '%s\n' "${FUNCTIONS[@]}" | sort -u)

check "bucket $CODE_BUCKET" aws s3api head-bucket --bucket "$CODE_BUCKET" --region "$REGION"
if [[ -n "$COGNITO_USER_POOL_ID" ]]; then
  check "Cognito pool $COGNITO_USER_POOL_ID" aws cognito-idp describe-user-pool --user-pool-id "$COGNITO_USER_POOL_ID" --region "$REGION"
fi

while IFS= read -r TABLE; do
  check "DynamoDB table $TABLE" aws dynamodb describe-table --table-name "$TABLE" --region "$REGION"
done < <(jq -r '.[]' <<<"$TABLE_NAMES")

[[ "$LEFTOVERS" -eq 0 ]] || die "$LEFTOVERS resource(s) survived — re-run, or inspect the warnings above"

log "Teardown complete. Rebuild with:"
cat <<'NEXT'

  scripts/terraform.sh apply
  scripts/seed.sh
  scripts/deploy.sh api
  scripts/deploy.sh web

NEXT
