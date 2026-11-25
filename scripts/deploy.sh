#!/usr/bin/env bash
#
# deploy.sh — build, package, and deploy a ServerlessQ Lambda Web Function
# Parameterized for both functions:
#
#   scripts/deploy.sh            # deploy API, web, then API with exact web CORS
#   scripts/deploy.sh api        # deploy serverlessq-api
#   scripts/deploy.sh web        # deploy serverlessq-web
#   scripts/deploy.sh api multi-region  # publish the existing revision globally
#
# Reads infra outputs from Terraform (role ARNs, code bucket, Cognito identifiers,
# region). Creates a HomeRegion endpoint by default, with optional MultiRegion
# endpoint support.
#
# Env overrides:
#   TRIVIA_ENV_NAME selects the Terraform workspace and resource names
#   TABLE_PREFIX   optional; must match Terraform's resolved table prefix
#   WEB_ORIGIN     CORS allowlist for the api (comma-separated)
#   ENDPOINT_RATE_LIMIT endpoint-wide requests/second limit (default 100); one of
#                       0, 100–1000 in 100-RPS steps, or 2000–10000 in 1000-RPS steps
#   ENDPOINT_MAX_ENVIRONMENTS endpoint environment cap per region (default 10; 2–10000)
#   LOG_RETENTION_DAYS CloudWatch Logs retention for function groups (default 14)
#   API_BASE_URL   optional api origin published via /config.json; defaults to
#                  the selected environment's deployed API endpoint
#   REVISION_ID    revision label surfaced by /api/health; default git short sha
#   API_FUNCTION   function name for `api` (default serverlessq-api)
#   WEB_FUNCTION   function name for `web` (default serverlessq-web)
#
set -euo pipefail

FUNCTION="${1:-all}"
MODE="${2:-deploy}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$ROOT_DIR/infra/terraform"
source "$ROOT_DIR/scripts/environment.sh"
trivia_select_environment "$ROOT_DIR"
MULTI_REGION_ENDPOINT_NAME="${MULTI_REGION_ENDPOINT_NAME:-global}"
ENDPOINT_RATE_LIMIT="${ENDPOINT_RATE_LIMIT:-100}"
ENDPOINT_MAX_ENVIRONMENTS="${ENDPOINT_MAX_ENVIRONMENTS:-10}"
LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-14}"

log() { printf '\033[1;93m▶ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

validate_endpoint_traffic_controls() {
  if [[ -n "${ENDPOINT_RATE_LIMIT:-}" &&
        ! "${ENDPOINT_RATE_LIMIT}" =~ ^(0|[1-9]00|1000|[2-9]000|10000)$ ]]; then
    die "ENDPOINT_RATE_LIMIT must be 0, 100–1000 in 100-RPS steps, or 2000–10000 in 1000-RPS steps"
  fi
  if [[ -n "${ENDPOINT_MAX_ENVIRONMENTS:-}" ]]; then
    [[ "${ENDPOINT_MAX_ENVIRONMENTS}" =~ ^[1-9][0-9]{0,4}$ ]] ||
      die "ENDPOINT_MAX_ENVIRONMENTS must be an integer from 2 to 10000"
    (( ENDPOINT_MAX_ENVIRONMENTS >= 2 && ENDPOINT_MAX_ENVIRONMENTS <= 10000 )) ||
      die "ENDPOINT_MAX_ENVIRONMENTS must be an integer from 2 to 10000"
  fi
}

validate_log_retention() {
  case "$LOG_RETENTION_DAYS" in
    1|3|5|7|14|30|60|90|120|150|180|365|400|545|731|1096|1827|2192|2557|2922|3288|3653) ;;
    *) die "LOG_RETENTION_DAYS must be a CloudWatch Logs supported retention value" ;;
  esac
}

set_log_group_retention() {
  local group_name="$1"
  local log_region="$2"
  local create_error
  if ! create_error="$(aws logs create-log-group \
    --log-group-name "$group_name" --region "$log_region" 2>&1)"; then
    grep -q "ResourceAlreadyExistsException" <<<"$create_error" ||
      die "Unable to create log group $group_name in $log_region: $create_error"
  fi
  aws logs put-retention-policy \
    --log-group-name "$group_name" \
    --retention-in-days "$LOG_RETENTION_DAYS" \
    --region "$log_region" >/dev/null ||
    die "Unable to set $LOG_RETENTION_DAYS-day retention on $group_name in $log_region"
}

ensure_log_retention() {
  local function_name="$1"
  local endpoint_json="$2"
  local base_group="/aws/lambda/web/$function_name"
  local serving_region

  # Lambda Web Functions write the central group in the home region and a
  # service-created .local companion in every serving region.
  set_log_group_retention "$base_group" "$REGION"
  while IFS= read -r serving_region; do
    [[ -n "$serving_region" ]] || continue
    set_log_group_retention "$base_group.local" "$serving_region"
  done < <(jq -r '.regions[]? // empty' <<<"$endpoint_json" | sort -u)
}

# LatestRevision is the HomeRegion workflow's traffic-shift contract. The
# response weights describe the serving revision even though weights cannot be
# supplied when creating an endpoint in this mode.
home_endpoint_is_compatible() {
  jq -e --arg region "$REGION" '
    . as $endpoint |
    .endpointName == "home" and
    .endpointType == "HomeRegion" and
    .authType == "ApplicationManaged" and
    .autoDeploymentMode == "LatestRevision" and
    .regions == [$region] and
    .state == "Active" and
    (.updateStatus == null or .updateStatus == "Successful") and
    (.domainName | type == "string" and length > 0 and . != "None" and . != "null") and
    (.revisionWeights | type == "array" and length == 1) and
    (.revisionWeights[0].revisionId | type == "string" and length > 0 and . != "None" and . != "null") and
    .revisionWeights[0].weight == 100 and
    (.regionalEndpoints | type == "object" and keys == [$region]) and
    (.regionalEndpoints[$region] |
      .state == "Active" and
      (.updateStatus == null or .updateStatus == "Successful") and
      .authType == $endpoint.authType and
      .revisionWeights == $endpoint.revisionWeights and
      .throttleConfig == $endpoint.throttleConfig and
      .scalingConfig == $endpoint.scalingConfig)
  ' <<<"$1" >/dev/null
}

inspect_existing_home() {
  local function_name="$1"
  HOME_EXISTED=false
  EXPECTED_ENDPOINT_CONTROLS="$(jq -cn \
    --argjson rate "$ENDPOINT_RATE_LIMIT" --argjson cap "$ENDPOINT_MAX_ENVIRONMENTS" \
    '{throttleConfig:{rateLimit:$rate},scalingConfig:{maxEnvironments:$cap}}')"
  local inspection
  if inspection="$(aws lambda-web get-web-function --function-name "$function_name" --region "$REGION" 2>&1)"; then
    HOME_EXISTED=true
    local endpoint
    endpoint="$(aws lambda-web get-web-function-endpoint \
      --function-name "$function_name" --endpoint-name home \
      --region "$REGION" --output json)" || die "Unable to inspect $function_name/home; refusing mutation"
    home_endpoint_is_compatible "$endpoint" || \
      die "Existing $function_name/home must be Active HomeRegion/ApplicationManaged/LatestRevision with one serving revision at 100% and matching regional configuration; refusing mutation"
    # Revision updates preserve effective controls, including older endpoints
    # whose controls are absent. Overrides apply only to endpoint creation.
    EXPECTED_ENDPOINT_CONTROLS="$(jq -c '{throttleConfig,scalingConfig}' <<<"$endpoint")"
  elif ! grep -q "ResourceNotFoundException" <<<"$inspection"; then
    die "Unable to inspect function $function_name; refusing mutation: $inspection"
  fi
}

# Environment variables for the deployed revision's service config.
# Cognito identifiers are public configuration; AWS_REGION and the HTTP bind
# address are supplied by the runtime. jq escapes optional overrides.
function_environment() {
  local api_function_name="$1"
  jq -n \
    --arg functionName "$api_function_name" \
    --arg environment "${TRIVIA_ENV_NAME:-}" \
    --arg tablePrefix "$TABLE_PREFIX" \
    --arg ddbRegion "$DDB_REGION" \
    --arg cognitoRegion "$COGNITO_REGION" \
    --arg userPoolId "$COGNITO_USER_POOL_ID" \
    --arg clientId "$COGNITO_APP_CLIENT_ID" \
    --arg revisionId "$REVISION_ID" \
    --arg webOrigin "${WEB_ORIGIN:-}" \
    --arg apiBaseUrl "${API_BASE_URL:-}" \
    --arg earlyReveal "${EARLY_REVEAL:-}" \
    '{
       SERVERLESSQ_TABLE_PREFIX: $tablePrefix,
       DDB_REGION: $ddbRegion,
       COGNITO_REGION: $cognitoRegion,
       COGNITO_USER_POOL_ID: $userPoolId,
       COGNITO_APP_CLIENT_ID: $clientId,
       REVISION_ID: $revisionId,
       TRIVIA_FUNCTION_NAME: $functionName,
       NODE_ENV: "production"
     }
     + (if $environment != "" then { TRIVIA_ENV_NAME: $environment } else {} end)
     + (if $webOrigin != "" then { WEB_ORIGIN: $webOrigin } else {} end)
     + (if $apiBaseUrl != "" then { API_BASE_URL: $apiBaseUrl } else {} end)
     + (if $earlyReveal != "" then { EARLY_REVEAL: $earlyReveal } else {} end)'
}

case "$FUNCTION" in
  all|api|web) ;;
  *) die "Unknown function '$FUNCTION' (expected: api | web)" ;;
esac
case "$MODE" in
  deploy|multi-region) ;;
  *) die "Unknown mode '$MODE' (expected: deploy | multi-region)" ;;
esac
[[ "$FUNCTION" != "all" || "$MODE" == "deploy" ]] || die "Choose api or web for multi-region"

validate_endpoint_traffic_controls
validate_log_retention

# ── Preflight: the CLI subcommand must exist (NFR-12). Hard-exit if missing. ──
log "Preflight: aws lambda-web"
if ! aws lambda-web help >/dev/null 2>&1; then
  die "aws lambda-web not found — your AWS CLI is outdated. Update the AWS CLI and retry."
fi

# ── Terraform outputs ────────────────────────────────────────────────────────
log "Reading Terraform outputs"
command -v jq >/dev/null 2>&1 || die "jq is required to parse Terraform outputs"
TF_OUT="$(terraform -chdir="$TF_DIR" output -json)" || die "terraform output failed — has 'terraform apply' run?"
trivia_load_outputs "$TF_OUT"
if [[ "$FUNCTION" == "api" || "$FUNCTION" == "all" ]]; then
  FUNCTION_NAME="${API_FUNCTION:-$TRIVIA_API_NAME}"
  trivia_check_function "$FUNCTION_NAME" "$TRIVIA_API_NAME"
  if [[ "$FUNCTION" == "all" ]]; then
    trivia_check_function "${WEB_FUNCTION:-$TRIVIA_WEB_NAME}" "$TRIVIA_WEB_NAME"
  fi
else
  FUNCTION_NAME="${WEB_FUNCTION:-$TRIVIA_WEB_NAME}"
  trivia_check_function "$FUNCTION_NAME" "$TRIVIA_WEB_NAME"
fi
METRIC_API_FUNCTION="${API_FUNCTION:-$TRIVIA_API_NAME}"
trivia_check_function "$METRIC_API_FUNCTION" "$TRIVIA_API_NAME"

REGION="$(jq -r '.primary_region.value' <<<"$TF_OUT")"
# Where the tables ARE, as opposed to where the function runs. Shipped as
# DDB_REGION so the data plane is never inferred from the sandbox's own region —
# the tables are regional, so a function serving from elsewhere must still
# address this one region.
DDB_REGION="$(jq -r '.ddb_region.value' <<<"$TF_OUT")"
# The same primary-region Cognito identity is used by every serving region.
COGNITO_REGION="$(jq -r '.cognito_region.value' <<<"$TF_OUT")"
COGNITO_USER_POOL_ID="$(jq -r '.cognito_user_pool_id.value' <<<"$TF_OUT")"
COGNITO_APP_CLIENT_ID="$(jq -r '.cognito_app_client_id.value' <<<"$TF_OUT")"
CODE_BUCKET="$(jq -r '.code_bucket.value' <<<"$TF_OUT")"
if [[ "$FUNCTION" == "api" || "$FUNCTION" == "all" ]]; then
  ROLE_ARN="$(jq -r '.api_execution_role_arn.value' <<<"$TF_OUT")"
else
  ROLE_ARN="$(jq -r '.web_execution_role_arn.value' <<<"$TF_OUT")"
fi
[[ -n "$REGION" && -n "$CODE_BUCKET" && -n "$ROLE_ARN" ]] || die "Missing Terraform outputs"
# Guarded rather than defaulted: silently falling back to the deploy region would
# point a function at tables that may not exist there, and the failure would only
# surface as ResourceNotFoundException on the first request of a live session.
[[ -n "$DDB_REGION" && "$DDB_REGION" != "null" ]] || \
  die "Terraform output 'ddb_region' is missing — re-apply infra/terraform (it is required for DDB_REGION)"
for COGNITO_OUTPUT in cognito_region cognito_user_pool_id cognito_app_client_id; do
  COGNITO_VALUE="$(jq -r --arg k "$COGNITO_OUTPUT" '.[$k].value // empty' <<<"$TF_OUT")"
  [[ -n "$COGNITO_VALUE" ]] || die "Terraform output '$COGNITO_OUTPUT' is missing — re-apply infra/terraform"
done
if [[ -n "${TRIVIA_ENV_NAME:-}" ]]; then
  trivia_check_account "$ROLE_ARN"
fi

# Bootstrap the API with browser access closed, discover its URL for web, then
# publish an API revision allowing only the web origin actually created here.
if [[ "$FUNCTION" == "all" ]]; then
  # Check both existing endpoints before the first child can upload or publish.
  inspect_existing_home "$TRIVIA_API_NAME"
  inspect_existing_home "$TRIVIA_WEB_NAME"
  WEB_ORIGIN= API_BASE_URL= bash "$ROOT_DIR/scripts/deploy.sh" api
  API_DOMAIN="$(aws lambda-web get-web-function-endpoint \
    --function-name "$TRIVIA_API_NAME" --endpoint-name home \
    --region "$REGION" --query domainName --output text)"
  [[ -n "$API_DOMAIN" && "$API_DOMAIN" != "None" && "$API_DOMAIN" != "null" ]] || \
    die "Deployed API endpoint domain is missing"
  DEPLOYED_API_URL="https://$API_DOMAIN"
  WEB_ORIGIN= API_BASE_URL="$DEPLOYED_API_URL" bash "$ROOT_DIR/scripts/deploy.sh" web
  WEB_DOMAIN="$(aws lambda-web get-web-function-endpoint \
    --function-name "$TRIVIA_WEB_NAME" --endpoint-name home \
    --region "$REGION" --query domainName --output text)"
  [[ -n "$WEB_DOMAIN" && "$WEB_DOMAIN" != "None" && "$WEB_DOMAIN" != "null" ]] || \
    die "Deployed web endpoint domain is missing"
  WEB_ORIGIN="https://$WEB_DOMAIN" API_BASE_URL= bash "$ROOT_DIR/scripts/deploy.sh" api
  log "Web → https://$WEB_DOMAIN"
  exit 0
fi

# ── Additive MultiRegion endpoint mode (§10.1) ───────────────────────────────
# Reuses the AWS revision currently serving `home`. This branch exits before
# build/package/upload, so it cannot create a revision or trigger home's
# LatestRevision auto-deployment while another builder tests the HomeRegion URL.
if [[ "$MODE" == "multi-region" ]]; then
  log "Resolving the revision currently serving $FUNCTION_NAME/home"
  HOME_BEFORE="$(aws lambda-web get-web-function-endpoint \
    --function-name "$FUNCTION_NAME" --endpoint-name home \
    --region "$REGION" --output json)" || die "Home endpoint not found; deploy $FUNCTION first"
  HOME_FINGERPRINT="$(jq -cS '{endpointName,endpointType,domainName,authType,autoDeploymentMode,revisionWeights,regions}' <<<"$HOME_BEFORE")"
  ACTIVE_REVISION="$(jq -r '.revisionWeights[] | select(.weight == 100) | .revisionId' <<<"$HOME_BEFORE")"
  [[ -n "$ACTIVE_REVISION" ]] || die "Home endpoint must have one revision at 100%"

  REVISION_JSON="$(aws lambda-web get-web-function-revision \
    --function-name "$FUNCTION_NAME" --revision-id "$ACTIVE_REVISION" \
    --region "$REGION" --output json)"
  REVISION_STATE="$(jq -r '.state' <<<"$REVISION_JSON")"
  [[ "$REVISION_STATE" == "Active" ]] || die "Revision $ACTIVE_REVISION is not Active (state: $REVISION_STATE)"

  # This mode promotes an EXISTING revision — it never builds one — and
  # environment variables are baked into the revision, then served unchanged from
  # every region in the endpoint. So a revision predating these variables would
  # leave a sandbox without its data and Cognito identity configuration.
  for PINNED in DDB_REGION:"$DDB_REGION" COGNITO_REGION:"$COGNITO_REGION" \
    COGNITO_USER_POOL_ID:"$COGNITO_USER_POOL_ID" COGNITO_APP_CLIENT_ID:"$COGNITO_APP_CLIENT_ID"; do
    PINNED_KEY="${PINNED%%:*}"
    PINNED_WANT="${PINNED#*:}"
    PINNED_GOT="$(jq -r --arg k "$PINNED_KEY" \
      '.serviceConfig.environmentVariables[$k] // empty' <<<"$REVISION_JSON")"
    [[ "$PINNED_GOT" == "$PINNED_WANT" ]] || die \
      "Revision $ACTIVE_REVISION carries $PINNED_KEY='${PINNED_GOT:-<unset>}', expected '$PINNED_WANT'. Run 'scripts/deploy.sh $FUNCTION' first to publish a revision carrying it, then retry multi-region."
  done

  ADDITIONAL_REGIONS=()
  while IFS= read -r additional_region; do
    [[ -n "$additional_region" ]] && ADDITIONAL_REGIONS+=("$additional_region")
  done < <(jq -r --arg home "$REGION" '.regions.value[] | select(. != $home)' <<<"$TF_OUT")
  [[ "${#ADDITIONAL_REGIONS[@]}" -gt 0 ]] || die "MultiRegion requires at least one additional Terraform region"
  EXPECTED_REGIONS="$(jq -cS '.regions.value | sort' <<<"$TF_OUT")"
  WEIGHTS="[{\"revisionId\":\"$ACTIVE_REVISION\",\"weight\":100}]"
  EXPECTED_GLOBAL_CONTROLS="$(jq -cn \
    --argjson rate "$ENDPOINT_RATE_LIMIT" --argjson cap "$ENDPOINT_MAX_ENVIRONMENTS" \
    '{throttleConfig:{rateLimit:$rate},scalingConfig:{maxEnvironments:$cap}}')"

  set +e
  EXISTING="$(aws lambda-web get-web-function-endpoint \
    --function-name "$FUNCTION_NAME" --endpoint-name "$MULTI_REGION_ENDPOINT_NAME" \
    --region "$REGION" --output json 2>&1)"
  EXISTING_STATUS=$?
  set -e

  if [[ "$EXISTING_STATUS" -eq 0 ]]; then
    EXPECTED_GLOBAL_CONTROLS="$(jq -c '{throttleConfig,scalingConfig}' <<<"$EXISTING")"
    if ! jq -e --argjson regions "$EXPECTED_REGIONS" '
      .endpointType == "MultiRegion" and
      .authType == "ApplicationManaged" and
      .autoDeploymentMode == "Disabled" and
      (.regions | sort) == $regions
    ' <<<"$EXISTING" >/dev/null; then
      die "Existing endpoint '$MULTI_REGION_ENDPOINT_NAME' has an unexpected endpointType, authType, autoDeploymentMode, or regions; refusing mutation"
    fi
    if ! jq -e --arg revision "$ACTIVE_REVISION" '
      .revisionWeights == [{"revisionId":$revision,"weight":100}]
    ' <<<"$EXISTING" >/dev/null; then
      UPDATE_CONFIG="$(jq -cn --arg revision "$ACTIVE_REVISION" \
        '{revisionWeights:[{revisionId:$revision,weight:100}]}')"
      log "Updating $MULTI_REGION_ENDPOINT_NAME to home revision $ACTIVE_REVISION"
      aws lambda-web update-web-function-endpoint \
        --function-name "$FUNCTION_NAME" \
        --endpoint-name "$MULTI_REGION_ENDPOINT_NAME" \
        --endpoint-config "$UPDATE_CONFIG" \
        --region "$REGION" >/dev/null
      aws lambda-web wait web-function-endpoint-updated \
        --function-name "$FUNCTION_NAME" \
        --endpoint-name "$MULTI_REGION_ENDPOINT_NAME" \
        --region "$REGION"
    else
      log "Endpoint $MULTI_REGION_ENDPOINT_NAME already matches revision $ACTIVE_REVISION at 100%"
    fi
  elif grep -q "ResourceNotFoundException" <<<"$EXISTING"; then
    log "Creating additive MultiRegion endpoint $MULTI_REGION_ENDPOINT_NAME on revision $ACTIVE_REVISION"
    CREATE_ENDPOINT_ARGS=(lambda-web create-web-function-endpoint \
      --function-name "$FUNCTION_NAME" \
      --endpoint-name "$MULTI_REGION_ENDPOINT_NAME" \
      --description "ServerlessQ public multi-region endpoint" \
      --endpoint-type MultiRegion \
      --auth-type ApplicationManaged \
      --auto-deployment-mode Disabled \
      --revision-weights "$WEIGHTS" \
      --regions "${ADDITIONAL_REGIONS[@]}")
    CREATE_ENDPOINT_ARGS+=(--throttle-config "{\"rateLimit\":$ENDPOINT_RATE_LIMIT}")
    CREATE_ENDPOINT_ARGS+=(--scaling-config "{\"maxEnvironments\":$ENDPOINT_MAX_ENVIRONMENTS}")
    aws "${CREATE_ENDPOINT_ARGS[@]}" --region "$REGION" >/dev/null
  else
    die "Unable to inspect endpoint '$MULTI_REGION_ENDPOINT_NAME': $EXISTING"
  fi

  log "Waiting for MultiRegion endpoint to become Active"
  aws lambda-web wait web-function-endpoint-active \
    --function-name "$FUNCTION_NAME" --endpoint-name "$MULTI_REGION_ENDPOINT_NAME" \
    --region "$REGION"

  FINAL="$(aws lambda-web get-web-function-endpoint \
    --function-name "$FUNCTION_NAME" --endpoint-name "$MULTI_REGION_ENDPOINT_NAME" \
    --region "$REGION" --output json)"
  if ! jq -e --arg revision "$ACTIVE_REVISION" --argjson regions "$EXPECTED_REGIONS" \
    --argjson controls "$EXPECTED_GLOBAL_CONTROLS" '
    .state == "Active" and
    .endpointType == "MultiRegion" and
    .authType == "ApplicationManaged" and
    .autoDeploymentMode == "Disabled" and
    .revisionWeights == [{"revisionId":$revision,"weight":100}] and
    {throttleConfig,scalingConfig} == $controls and
    (.regions | sort) == $regions and
    ([.regionalEndpoints[]?.state] | all(. == "Active"))
  ' <<<"$FINAL" >/dev/null; then
    die "MultiRegion endpoint did not reach the expected Active configuration"
  fi

  HOME_AFTER="$(aws lambda-web get-web-function-endpoint \
    --function-name "$FUNCTION_NAME" --endpoint-name home \
    --region "$REGION" --output json)"
  [[ "$(jq -cS '{endpointName,endpointType,domainName,authType,autoDeploymentMode,revisionWeights,regions}' <<<"$HOME_AFTER")" == "$HOME_FINGERPRINT" ]] || \
    die "Safety check failed: home endpoint changed"

  ensure_log_retention "$FUNCTION_NAME" "$FINAL"
  DOMAIN="$(jq -r '.domainName' <<<"$FINAL")"
  log "MultiRegion endpoint Active → https://$DOMAIN"
  if [[ "$(jq -r '.throttleConfig.rateLimit' <<<"$FINAL")" == 0 ]]; then
    log "Endpoint rate is 0; control-plane revision and endpoint controls verified; HTTP smoke skipped"
  elif [[ "$FUNCTION" == "api" ]]; then
    log "Smoke: GET /api/health through global routing"
    curl -fsS "https://$DOMAIN/api/health"
    echo
  fi
  exit 0
fi

inspect_existing_home "$FUNCTION_NAME"

REVISION_ID="${REVISION_ID:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || date +%s)}"
S3_KEY="$FUNCTION_NAME/function.zip"

# ── Build (shared always; web also runs its Vite build) ──────────────────────
# The API runs its TypeScript directly on Node 24. Shared needs compiled output.
log "Building @serverlessq/shared"
npm --prefix "$ROOT_DIR" --workspace @serverlessq/shared run build || die "Shared build failed; no package was uploaded"

if [[ "$FUNCTION" == "web" ]]; then
  # Resolve the API belonging to this environment unless the caller supplies
  # another endpoint explicitly. The web host publishes it via /config.json.
  if [[ -z "${API_BASE_URL:-}" ]]; then
    API_TARGET="${API_FUNCTION:-$TRIVIA_API_NAME}"
    trivia_check_function "$API_TARGET" "$TRIVIA_API_NAME"
    API_ENDPOINT=home
    API_DOMAIN="$(aws lambda-web get-web-function-endpoint \
      --function-name "$API_TARGET" --endpoint-name "$API_ENDPOINT" \
      --region "$REGION" --query domainName --output text)" || die "The $API_ENDPOINT API endpoint for $API_TARGET must exist before deploying web"
    [[ -n "$API_DOMAIN" && "$API_DOMAIN" != "None" && "$API_DOMAIN" != "null" ]] || \
      die "The $API_ENDPOINT API endpoint domain for $API_TARGET is missing"
    API_BASE_URL="https://$API_DOMAIN"
  fi
  log "Building web SPA (Vite)"
  npm --prefix "$ROOT_DIR/packages/web" run build
fi

# ── Stage & package ──────────────────────────────────────────────────────────
PKG_DIR="$ROOT_DIR/packages/$FUNCTION"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
log "Staging into $STAGE"

cp "$PKG_DIR/index.js" "$STAGE/"
cp "$ROOT_DIR/deploy/locks/$FUNCTION/package.json" \
   "$ROOT_DIR/deploy/locks/$FUNCTION/package-lock.json" "$STAGE/"
# The api loads ./src/*.ts at runtime (Node 24 type-stripping). The web host
# serves the pre-bundled SPA from dist/, so its TSX sources stay out of the ZIP.
if grep -q './src/' "$PKG_DIR/index.js"; then
  cp -R "$PKG_DIR/src" "$STAGE/"
fi
[[ -d "$PKG_DIR/public" ]] && cp -R "$PKG_DIR/public" "$STAGE/"
[[ -d "$PKG_DIR/dist" ]] && cp -R "$PKG_DIR/dist" "$STAGE/"     # web: built SPA assets

# The AWS SDK's public @aws/lambda-invoke-store dependency must resolve from
# npmjs even when a developer's user-level .npmrc routes @aws to CodeArtifact.
printf 'registry=https://registry.npmjs.org/\n@aws:registry=https://registry.npmjs.org/\n' > "$STAGE/.npmrc"

log "Installing production dependencies"
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null )

# npm ci replaces node_modules. Add shared only after the locked external
# dependencies are installed; the API lock includes shared's runtime deps.
if [[ "$FUNCTION" == "api" ]]; then
  log "Copying built @serverlessq/shared"
  mkdir -p "$STAGE/node_modules/@serverlessq/shared"
  cp "$ROOT_DIR/packages/shared/package.json" "$STAGE/node_modules/@serverlessq/shared/"
  cp -R "$ROOT_DIR/packages/shared/dist" "$STAGE/node_modules/@serverlessq/shared/"
fi

log "Zipping function.zip"
( cd "$STAGE" && zip -qr function.zip index.js package.json \
    $( [[ -d src ]] && echo src ) \
    $( [[ -d public ]] && echo public ) \
    $( [[ -d dist ]] && echo dist ) \
    node_modules \
    -x "*.test.*" -x "*.map" -x ".env" )

log "Uploading to s3://$CODE_BUCKET/$S3_KEY"
VERSION_ID="$(aws s3api put-object \
  --bucket "$CODE_BUCKET" --key "$S3_KEY" \
  --body "$STAGE/function.zip" \
  --query VersionId --output text --region "$REGION")"

# ── Service config (shared by create + revision) ─────────────────────────────
# Only public Cognito identifiers are published; AWS_REGION is runtime-injected.
# DDB_REGION goes to BOTH functions so one env contract covers the pair, even
# though only the api has a data plane (the web role is logs-only).
# EARLY_REVEAL is only passed when set, preserving the code's default.
ENV_JSON="$(function_environment "$METRIC_API_FUNCTION")"
SERVICE_CONFIG=$(cat <<JSON
{
  "executionRoleArn": "$ROLE_ARN",
  "timeoutSeconds": 300,
  "maxConcurrencyPerEnvironment": 128,
  "environmentVariables": $ENV_JSON
}
JSON
)
BUILD_CONFIG=$(cat <<JSON
{
  "codeConfig": {"s3Object": {"bucket": "$CODE_BUCKET", "key": "$S3_KEY", "versionId": "$VERSION_ID"}},
  "runtimeConfig": {"runtime": "nodejs24.x"}
}
JSON
)

# ── Create (first deploy) or add a revision (subsequent deploys) ─────────────
if [[ "$HOME_EXISTED" == true ]]; then
  log "Creating new revision of $FUNCTION_NAME"
  AWS_REVISION_ID="$(aws lambda-web create-web-function-revision \
    --function-name "$FUNCTION_NAME" \
    --description "Revision $REVISION_ID" \
    --build-config "$BUILD_CONFIG" \
    --service-config "$SERVICE_CONFIG" \
    --region "$REGION" --query revisionId --output text)"
else
  log "Creating function $FUNCTION_NAME (HomeRegion, ApplicationManaged)"
  REVISION_CONFIG="$(jq -n \
    --arg description "Revision $REVISION_ID" \
    --argjson build "$BUILD_CONFIG" \
    --argjson service "$SERVICE_CONFIG" \
    '{description: $description, buildConfig: $build, serviceConfig: $service}')"
  ENDPOINT_CONFIG="$(jq -cn \
    --argjson rateLimit "$ENDPOINT_RATE_LIMIT" \
    --argjson maxEnvironments "$ENDPOINT_MAX_ENVIRONMENTS" \
    '{
       endpointName: "home",
       endpointType: "HomeRegion",
       authType: "ApplicationManaged",
       autoDeploymentMode: "LatestRevision",
       throttleConfig: {rateLimit: $rateLimit},
       scalingConfig: {maxEnvironments: $maxEnvironments}
     }')"
  AWS_REVISION_ID="$(aws lambda-web create-web-function \
    --function-name "$FUNCTION_NAME" \
    --revision-config "$REVISION_CONFIG" \
    --endpoint-config "$ENDPOINT_CONFIG" \
    --region "$REGION" --query revision.revisionId --output text)"
fi
[[ -n "$AWS_REVISION_ID" && "$AWS_REVISION_ID" != "None" && "$AWS_REVISION_ID" != "null" ]] || \
  die "Created revision ID is missing"
log "Waiting for revision $AWS_REVISION_ID to become Active"
aws lambda-web wait web-function-revision-active \
  --function-name "$FUNCTION_NAME" --revision-id "$AWS_REVISION_ID" --region "$REGION"
aws lambda-web wait web-function-endpoint-active \
  --function-name "$FUNCTION_NAME" --endpoint-name home --region "$REGION"

# ── Verify serving revision/configuration before reporting success ──────────
DEPLOYED_REVISION="$(aws lambda-web get-web-function-revision \
  --function-name "$FUNCTION_NAME" --revision-id "$AWS_REVISION_ID" \
  --region "$REGION" --output json)"
if ! jq -e --arg revision "$AWS_REVISION_ID" \
  --argjson build "$BUILD_CONFIG" --argjson service "$SERVICE_CONFIG" '
    .revisionId == $revision and .state == "Active" and
    .buildConfig.codeConfig == $build.codeConfig and
    .buildConfig.runtimeConfig == $build.runtimeConfig and
    .serviceConfig.executionRoleArn == $service.executionRoleArn and
    .serviceConfig.timeoutSeconds == $service.timeoutSeconds and
    .serviceConfig.maxConcurrencyPerEnvironment == $service.maxConcurrencyPerEnvironment and
    .serviceConfig.environmentVariables == $service.environmentVariables
  ' <<<"$DEPLOYED_REVISION" >/dev/null; then
  die "Revision $AWS_REVISION_ID did not reach the expected Active configuration"
fi
DEPLOYED_ENDPOINT="$(aws lambda-web get-web-function-endpoint \
  --function-name "$FUNCTION_NAME" --endpoint-name home \
  --output json --region "$REGION")"
if [[ "$(jq -r '.updateStatus' <<<"$DEPLOYED_ENDPOINT")" == InProgress ]]; then
  # LatestRevision auto-follow need not set updateStatus. Wait on that field
  # only when the service actually reports an endpoint update in progress.
  log "Waiting for home endpoint update to complete"
  aws lambda-web wait web-function-endpoint-updated \
    --function-name "$FUNCTION_NAME" --endpoint-name home --region "$REGION"
  DEPLOYED_ENDPOINT="$(aws lambda-web get-web-function-endpoint \
    --function-name "$FUNCTION_NAME" --endpoint-name home \
    --output json --region "$REGION")"
fi
if ! home_endpoint_is_compatible "$DEPLOYED_ENDPOINT" ||
   ! jq -e --arg revision "$AWS_REVISION_ID" \
      --argjson controls "$EXPECTED_ENDPOINT_CONTROLS" '
        .revisionWeights == [{"revisionId":$revision,"weight":100}] and
        {throttleConfig,scalingConfig} == $controls
      ' <<<"$DEPLOYED_ENDPOINT" >/dev/null; then
  die "Home endpoint did not reach the expected Active configuration serving revision $AWS_REVISION_ID at 100%"
fi
ensure_log_retention "$FUNCTION_NAME" "$DEPLOYED_ENDPOINT"
DOMAIN="$(jq -r '.domainName' <<<"$DEPLOYED_ENDPOINT")"
EFFECTIVE_RATE_LIMIT="$(jq -r '.throttleConfig.rateLimit' <<<"$DEPLOYED_ENDPOINT")"
log "Deployed $FUNCTION_NAME (rev $REVISION_ID, AWS revision $AWS_REVISION_ID) → https://$DOMAIN"

if [[ "$EFFECTIVE_RATE_LIMIT" == 0 ]]; then
  log "Endpoint rate is 0; control-plane revision and endpoint controls verified; HTTP smoke skipped"
elif [[ "$FUNCTION" == "api" ]]; then
  log "Smoke: GET /api/health"
  curl -fsS "https://$DOMAIN/api/health"
  echo
fi
