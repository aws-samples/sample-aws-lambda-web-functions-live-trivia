#!/usr/bin/env bash
#
# Prove that a Lambda Web Function serving from another region can read the
# ServerlessQ DynamoDB tables in their home region.
#
# Creates a temporary PerRegion endpoint on the revision currently serving the
# API's default endpoint, targets the remote region's domain directly, and
# removes the temporary endpoint on exit.
#
# Usage:
#   scripts/per-region-ddb.sh
#
# Overrides:
#   PER_REGION_FUNCTION       Function to test (default: Terraform API name)
#   PER_REGION_REMOTE_REGION  Remote serving region (default: first configured
#                             additional region, then us-west-2)
#   PER_REGION_ENDPOINT_NAME  Temporary endpoint name
#   KEEP_PER_REGION_ENDPOINT  Set to 1 to leave a newly created endpoint in place

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/environment.sh"
trivia_select_environment "$ROOT_DIR"

log() { printf '▶ %s\n' "$*"; }
die() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}

for command_name in aws curl jq terraform; do
  command -v "$command_name" >/dev/null 2>&1 || die "$command_name is required"
done

TF_OUT="$(terraform -chdir="$TRIVIA_TF_DIR" output -json)" ||
  die "terraform output failed — has the selected environment been applied?"
trivia_load_outputs "$TF_OUT"

HOME_REGION="$(jq -r '.primary_region.value // empty' <<<"$TF_OUT")"
DDB_REGION="$(jq -r '.ddb_region.value // empty' <<<"$TF_OUT")"
API_NAME="$TRIVIA_API_NAME"
REMOTE_REGION="${PER_REGION_REMOTE_REGION:-$(
  jq -r --arg home "$HOME_REGION" \
    '[.regions.value[]? | select(. != $home)][0] // empty' <<<"$TF_OUT"
)}"
FUNCTION_NAME="${PER_REGION_FUNCTION:-$API_NAME}"
ENDPOINT_NAME="${PER_REGION_ENDPOINT_NAME:-ddb-per-region-test}"
KEEP_ENDPOINT="${KEEP_PER_REGION_ENDPOINT:-0}"

[[ -n "$HOME_REGION" && -n "$DDB_REGION" && -n "$API_NAME" ]] ||
  die "primary_region, ddb_region, or api_function_name is missing from Terraform outputs"
[[ -n "$REMOTE_REGION" ]] ||
  die "configure a second Terraform region or set PER_REGION_REMOTE_REGION"
trivia_check_function "$FUNCTION_NAME" "$TRIVIA_API_NAME"
[[ "$REMOTE_REGION" != "$HOME_REGION" ]] ||
  die "remote region must differ from the home region ($HOME_REGION)"
[[ "$KEEP_ENDPOINT" == "0" || "$KEEP_ENDPOINT" == "1" ]] ||
  die "KEEP_PER_REGION_ENDPOINT must be 0 or 1"

CREATED_ENDPOINT=0
cleanup() {
  local status=$?
  trap - EXIT
  if [[ "$CREATED_ENDPOINT" == "1" && "$KEEP_ENDPOINT" != "1" ]]; then
    log "Removing temporary endpoint $FUNCTION_NAME/$ENDPOINT_NAME"
    aws lambda-web delete-web-function-endpoint \
      --function-name "$FUNCTION_NAME" \
      --endpoint-name "$ENDPOINT_NAME" \
      --region "$HOME_REGION" >/dev/null || true
    aws lambda-web wait web-function-endpoint-deleted \
      --function-name "$FUNCTION_NAME" \
      --endpoint-name "$ENDPOINT_NAME" \
      --region "$HOME_REGION" >/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

log "Checking AWS identity"
CALLER_ACCOUNT="$(
  aws sts get-caller-identity --query Account --output text --region "$HOME_REGION"
)" || die "unable to use AWS credentials"

log "Resolving the revision serving $FUNCTION_NAME/home"
HOME_BEFORE="$(
  aws lambda-web get-web-function-endpoint \
    --function-name "$FUNCTION_NAME" \
    --endpoint-name home \
    --region "$HOME_REGION" \
    --output json
)" || die "home endpoint not found for $FUNCTION_NAME"

FUNCTION_ACCOUNT="$(jq -r '.functionArn | split(":")[4]' <<<"$HOME_BEFORE")"
[[ "$CALLER_ACCOUNT" == "$FUNCTION_ACCOUNT" ]] ||
  die "profile account $CALLER_ACCOUNT does not own $FUNCTION_NAME (account $FUNCTION_ACCOUNT)"

ACTIVE_REVISION="$(
  jq -r '[.revisionWeights[] | select(.weight == 100)][0].revisionId // empty' \
    <<<"$HOME_BEFORE"
)"
[[ -n "$ACTIVE_REVISION" ]] ||
  die "home endpoint must have one revision at 100%"

REVISION="$(
  aws lambda-web get-web-function-revision \
    --function-name "$FUNCTION_NAME" \
    --revision-id "$ACTIVE_REVISION" \
    --region "$HOME_REGION" \
    --output json
)" || die "unable to inspect revision $ACTIVE_REVISION"

[[ "$(jq -r '.state' <<<"$REVISION")" == "Active" ]] ||
  die "revision $ACTIVE_REVISION is not Active"
REVISION_DDB_REGION="$(
  jq -r '.serviceConfig.environmentVariables.DDB_REGION // empty' <<<"$REVISION"
)"
[[ "$REVISION_DDB_REGION" == "$DDB_REGION" ]] ||
  die "revision $ACTIVE_REVISION has DDB_REGION='${REVISION_DDB_REGION:-<unset>}', expected '$DDB_REGION'"

set +e
EXISTING="$(
  aws lambda-web get-web-function-endpoint \
    --function-name "$FUNCTION_NAME" \
    --endpoint-name "$ENDPOINT_NAME" \
    --region "$HOME_REGION" \
    --output json 2>&1
)"
EXISTING_STATUS=$?
set -e

if [[ "$EXISTING_STATUS" -eq 0 ]]; then
  die "endpoint $FUNCTION_NAME/$ENDPOINT_NAME already exists; remove it or choose PER_REGION_ENDPOINT_NAME"
elif [[ "$EXISTING" != *"ResourceNotFoundException"* ]]; then
  die "unable to inspect endpoint $FUNCTION_NAME/$ENDPOINT_NAME: $EXISTING"
fi

WEIGHTS="[{\"revisionId\":\"$ACTIVE_REVISION\",\"weight\":100}]"
log "Creating temporary PerRegion endpoint: $HOME_REGION + $REMOTE_REGION"
log "Auth matches the existing public API: ApplicationManaged"
aws lambda-web create-web-function-endpoint \
  --function-name "$FUNCTION_NAME" \
  --endpoint-name "$ENDPOINT_NAME" \
  --description "Temporary cross-region DynamoDB connectivity test" \
  --endpoint-type PerRegion \
  --auth-type ApplicationManaged \
  --auto-deployment-mode Disabled \
  --revision-weights "$WEIGHTS" \
  --regions "$REMOTE_REGION" \
  --region "$HOME_REGION" >/dev/null
CREATED_ENDPOINT=1

log "Waiting for both regional endpoints to become Active"
aws lambda-web wait web-function-endpoint-active \
  --function-name "$FUNCTION_NAME" \
  --endpoint-name "$ENDPOINT_NAME" \
  --region "$HOME_REGION"

PER_REGION_ENDPOINT="$(
  aws lambda-web get-web-function-endpoint \
    --function-name "$FUNCTION_NAME" \
    --endpoint-name "$ENDPOINT_NAME" \
    --region "$HOME_REGION" \
    --output json
)"

if ! jq -e \
  --arg revision "$ACTIVE_REVISION" \
  --arg home "$HOME_REGION" \
  --arg remote "$REMOTE_REGION" '
    .state == "Active" and
    .endpointType == "PerRegion" and
    .authType == "ApplicationManaged" and
    .autoDeploymentMode == "Disabled" and
    .revisionWeights == [{"revisionId": $revision, "weight": 100}] and
    (.regions | sort) == ([$home, $remote] | unique | sort) and
    .regionalEndpoints[$remote].state == "Active"
  ' <<<"$PER_REGION_ENDPOINT" >/dev/null; then
  die "PerRegion endpoint did not reach the expected configuration"
fi

REMOTE_DOMAIN="$(
  jq -r --arg remote "$REMOTE_REGION" \
    '.regionalEndpoints[$remote].domainName // empty' <<<"$PER_REGION_ENDPOINT"
)"
[[ -n "$REMOTE_DOMAIN" ]] ||
  die "no regional domain was returned for $REMOTE_REGION"

log "Calling the remote regional domain: https://$REMOTE_DOMAIN"
HEALTH="$(curl -fsS "https://$REMOTE_DOMAIN/api/health")" ||
  die "remote /api/health request failed"
SERVED_REGION="$(jq -r '.region // empty' <<<"$HEALTH")"
[[ "$SERVED_REGION" == "$REMOTE_REGION" ]] ||
  die "remote domain reported region '${SERVED_REGION:-<unset>}', expected '$REMOTE_REGION'"

ACTIVE_GAMES="$(curl -fsS "https://$REMOTE_DOMAIN/api/games/active")" ||
  die "remote DynamoDB-backed request failed"
jq -e '.games | type == "array"' <<<"$ACTIVE_GAMES" >/dev/null ||
  die "remote /api/games/active did not return the expected response"

HOME_AFTER="$(
  aws lambda-web get-web-function-endpoint \
    --function-name "$FUNCTION_NAME" \
    --endpoint-name home \
    --region "$HOME_REGION" \
    --output json
)"
HOME_FIELDS='{endpointName,endpointType,domainName,authType,autoDeploymentMode,revisionWeights,regions}'
[[ "$(jq -cS "$HOME_FIELDS" <<<"$HOME_AFTER")" == \
   "$(jq -cS "$HOME_FIELDS" <<<"$HOME_BEFORE")" ]] ||
  die "safety check failed: the home endpoint changed"

printf '%s\n' "Health: $HEALTH"
printf '%s\n' "DynamoDB response: $ACTIVE_GAMES"
printf 'PASS: %s served the request and read DynamoDB in %s\n' \
  "$REMOTE_REGION" "$DDB_REGION"
