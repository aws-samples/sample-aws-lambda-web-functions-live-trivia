#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

export TEST_AWS_LOG="$TMP/aws.log"
export TEST_ENDPOINT_MARKER="$TMP/global-created"
export TEST_UPDATE_CONFIG="$TMP/update-config.json"
export TEST_SCALING_CONFIG="$TMP/scaling-config.json"
export TEST_THROTTLE_CONFIG="$TMP/throttle-config.json"
export TEST_CURL_LOG="$TMP/curl.log"

cat > "$TMP/bin/terraform" <<'FAKE_TERRAFORM'
#!/usr/bin/env bash
cat <<'JSON'
{
  "primary_region":{"value":"us-east-1"},
  "environment_name":{"value":"live"},
  "api_function_name":{"value":"serverlessq-live-api"},
  "web_function_name":{"value":"serverlessq-live-web"},
  "table_prefix":{"value":"live-"},
  "ddb_region":{"value":"us-east-1"},
  "cognito_region":{"value":"us-east-1"},
  "cognito_user_pool_id":{"value":"us-east-1_fixture"},
  "cognito_app_client_id":{"value":"fixtureclient"},
  "regions":{"value":["us-east-1","us-west-2"]},
  "code_bucket":{"value":"unused"},
  "api_execution_role_arn":{"value":"arn:aws:iam::123456789012:role/api"},
  "web_execution_role_arn":{"value":"arn:aws:iam::123456789012:role/web"}
}
JSON
FAKE_TERRAFORM

cat > "$TMP/bin/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
echo "unexpected npm invocation: $*" >&2
exit 99
FAKE_NPM

cat > "$TMP/bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TEST_CURL_LOG"
if [[ "${TEST_SMOKE_FAIL:-}" == 1 ]] ||
   jq -e '.rateLimit == 0' "$TEST_THROTTLE_CONFIG" >/dev/null; then
  printf 'HTTP smoke failed or endpoint blocks all traffic\n' >&2
  exit 22
fi
printf '{"region":"us-west-2","revision":"test","status":"ok"}'
FAKE_CURL

cat > "$TMP/bin/aws" <<'FAKE_AWS'
#!/usr/bin/env bash
printf '%q ' "$@" >> "$TEST_AWS_LOG"
printf '\n' >> "$TEST_AWS_LOG"

if [[ "$1 $2" == "lambda-web help" ]]; then exit 0; fi
if [[ "$1 $2" == "sts get-caller-identity" ]]; then
  printf '123456789012\n'
  exit 0
fi
if [[ "$1 $2" == "logs create-log-group" ]]; then
  exit 0
fi
if [[ "$1 $2" == "logs put-retention-policy" ]]; then exit 0; fi
if [[ "$1 $2" != "lambda-web get-web-function-endpoint" &&
      "$1 $2" != "lambda-web get-web-function-revision" &&
      "$1 $2" != "lambda-web create-web-function-endpoint" &&
      "$1 $2" != "lambda-web update-web-function-endpoint" &&
      "$1 $2" != "lambda-web wait" ]]; then
  echo "unexpected aws call: $*" >&2
  exit 98
fi

endpoint=""
revision=""
endpoint_config=""
scaling_config=""
throttle_config=""
previous=""
for arg in "$@"; do
  if [[ "$previous" == "--endpoint-name" ]]; then endpoint="$arg"; fi
  if [[ "$previous" == "--revision-id" ]]; then revision="$arg"; fi
  if [[ "$previous" == "--endpoint-config" ]]; then endpoint_config="$arg"; fi
  if [[ "$previous" == "--scaling-config" ]]; then scaling_config="$arg"; fi
  if [[ "$previous" == "--throttle-config" ]]; then throttle_config="$arg"; fi
  previous="$arg"
done

if [[ "$1 $2" == "lambda-web get-web-function-endpoint" ]]; then
  if [[ "$endpoint" == "home" ]]; then
    cat <<'JSON'
{"endpointName":"home","endpointType":"HomeRegion","domainName":"home.example.test","authType":"ApplicationManaged","autoDeploymentMode":"LatestRevision","revisionWeights":[{"revisionId":"rev-new","weight":100}],"regions":["us-east-1"],"state":"Active"}
JSON
    exit 0
  fi
  if [[ "$endpoint" == "global" && ( -f "$TEST_ENDPOINT_MARKER" || "${TEST_EXISTING:-}" == 1 ) ]]; then
    global_revision=rev-new
    if [[ "${TEST_DRIFT:-}" == 1 && ! -f "$TEST_ENDPOINT_MARKER" ]]; then
      global_revision=rev-old
    fi
    effective_scaling='{"maxEnvironments":50}'
    effective_throttle='{"rateLimit":1000}'
    if [[ "${TEST_EXISTING:-}" != 1 ]]; then
      effective_scaling="$(<"$TEST_SCALING_CONFIG")"
      effective_throttle="$(<"$TEST_THROTTLE_CONFIG")"
    fi
    if [[ -f "$TEST_ENDPOINT_MARKER" ]]; then
      case "${TEST_FINAL_BAD_CONTROL:-}" in
        rate) effective_throttle='{"rateLimit":200}' ;;
        scaling) effective_scaling='{"maxEnvironments":999}' ;;
      esac
    fi
    jq -n --arg revision "$global_revision" --arg mismatch "${TEST_UNSAFE_FIELD:-}" \
      --argjson scaling "$effective_scaling" --argjson throttle "$effective_throttle" '
      {endpointName:"global",endpointType:"MultiRegion",domainName:"global.example.test",
       authType:"ApplicationManaged",autoDeploymentMode:"Disabled",
       revisionWeights:[{revisionId:$revision,weight:100}],
       regions:["us-east-1","us-west-2"],state:"Active",
       scalingConfig:$scaling,throttleConfig:$throttle,
       regionalEndpoints:{"us-east-1":{state:"Active"},"us-west-2":{state:"Active"}}}
      | if $mismatch == "endpointType" then .endpointType="HomeRegion"
        elif $mismatch == "authType" then .authType="AWS_IAM"
        elif $mismatch == "autoDeploymentMode" then .autoDeploymentMode="LatestRevision"
        elif $mismatch == "regions" then .regions=["us-east-1","eu-west-1"]
        else . end'
    exit 0
  fi
  echo "ResourceNotFoundException: endpoint does not exist" >&2
  exit 254
fi

if [[ "$1 $2" == "lambda-web get-web-function-revision" ]]; then
  [[ "$revision" == "rev-new" ]] || exit 97
  # Empty TEST_REVISION_* ⇒ a revision published before that variable existed.
  printf '{"revisionId":"rev-new","state":"%s","serviceConfig":{"environmentVariables":{' "${TEST_REVISION_STATE:-Active}"
  SEP=""
  for PAIR in "DDB_REGION:${TEST_REVISION_DDB_REGION:-}" "COGNITO_REGION:${TEST_REVISION_COGNITO_REGION:-}" \
    "COGNITO_USER_POOL_ID:${TEST_REVISION_COGNITO_USER_POOL_ID:-}" "COGNITO_APP_CLIENT_ID:${TEST_REVISION_COGNITO_APP_CLIENT_ID:-}"; do
    VALUE="${PAIR#*:}"
    if [[ -n "$VALUE" ]]; then
      printf '%s"%s":"%s"' "$SEP" "${PAIR%%:*}" "$VALUE"
      SEP=","
    fi
  done
  printf '}}}\n'
  exit 0
fi

if [[ "$1 $2" == "lambda-web create-web-function-endpoint" ]]; then
  printf '%s' "$scaling_config" > "$TEST_SCALING_CONFIG"
  printf '%s' "$throttle_config" > "$TEST_THROTTLE_CONFIG"
  touch "$TEST_ENDPOINT_MARKER"
  printf '{"endpointName":"global","state":"Creating"}\n'
  exit 0
fi
if [[ "$1 $2" == "lambda-web update-web-function-endpoint" ]]; then
  printf '%s\n' "$endpoint_config" > "$TEST_UPDATE_CONFIG"
  touch "$TEST_ENDPOINT_MARKER"
  printf '{"endpointName":"global","state":"Updating"}\n'
  exit 0
fi

if [[ "$1 $2" == "lambda-web wait" ]]; then exit 0; fi
FAKE_AWS

chmod +x "$TMP/bin/terraform" "$TMP/bin/npm" "$TMP/bin/curl" "$TMP/bin/aws"

run_mode() {
  PATH="$TMP/bin:$PATH" AWS_PROFILE=sample \
    TRIVIA_ENV_NAME=live API_FUNCTION="${TEST_API_FUNCTION:-serverlessq-live-api}" \
    TEST_REVISION_DDB_REGION="${TEST_REVISION_DDB_REGION-us-east-1}" \
    TEST_REVISION_COGNITO_REGION="${TEST_REVISION_COGNITO_REGION-us-east-1}" \
    TEST_REVISION_COGNITO_USER_POOL_ID="${TEST_REVISION_COGNITO_USER_POOL_ID-us-east-1_fixture}" \
    TEST_REVISION_COGNITO_APP_CLIENT_ID="${TEST_REVISION_COGNITO_APP_CLIENT_ID-fixtureclient}" \
    bash "$ROOT_DIR/scripts/deploy.sh" api multi-region
}

FIRST="$(run_mode)"
SECOND="$(run_mode)"

[[ "$FIRST" == *"https://global.example.test"* ]]
[[ "$SECOND" == *"already matches"* ]]
[[ "$(grep -c '^lambda-web create-web-function-endpoint ' "$TEST_AWS_LOG")" == "1" ]]
! grep -q '^lambda-web create-web-function-revision ' "$TEST_AWS_LOG"
! grep -q '^lambda-web update-web-function-endpoint ' "$TEST_AWS_LOG"
! grep -q '^s3api ' "$TEST_AWS_LOG"
grep -q -- '--endpoint-name global' "$TEST_AWS_LOG"
grep -q -- '--endpoint-type MultiRegion' "$TEST_AWS_LOG"
grep -q -- '--auth-type ApplicationManaged' "$TEST_AWS_LOG"
grep -q -- '--auto-deployment-mode Disabled' "$TEST_AWS_LOG"
grep -q -- '--revision-weights .*rev-new.*100' "$TEST_AWS_LOG"
grep -q -- '--regions us-west-2' "$TEST_AWS_LOG"
jq -e '. == {"maxEnvironments":10}' "$TEST_SCALING_CONFIG" >/dev/null
jq -e '. == {"rateLimit":100}' "$TEST_THROTTLE_CONFIG" >/dev/null
grep -q '^logs put-retention-policy .*serverlessq-live-api .*14 .*us-east-1' "$TEST_AWS_LOG"
grep -q '^logs put-retention-policy .*serverlessq-live-api\.local .*14 .*us-east-1' "$TEST_AWS_LOG"
grep -q '^logs put-retention-policy .*serverlessq-live-api\.local .*14 .*us-west-2' "$TEST_AWS_LOG"

# A revision published before these variables existed must be refused, not
# promoted: the MultiRegion endpoint must retain table and Cognito configuration.
for MISSING in DDB_REGION COGNITO_REGION COGNITO_USER_POOL_ID COGNITO_APP_CLIENT_ID; do
  set +e
  case "$MISSING" in
    DDB_REGION) STALE="$(TEST_REVISION_DDB_REGION= run_mode 2>&1)" ;;
    COGNITO_REGION) STALE="$(TEST_REVISION_COGNITO_REGION= run_mode 2>&1)" ;;
    COGNITO_USER_POOL_ID) STALE="$(TEST_REVISION_COGNITO_USER_POOL_ID= run_mode 2>&1)" ;;
    COGNITO_APP_CLIENT_ID) STALE="$(TEST_REVISION_COGNITO_APP_CLIENT_ID= run_mode 2>&1)" ;;
  esac
  STALE_STATUS=$?
  set -e
  [[ "$STALE_STATUS" -ne 0 ]]
  [[ "$STALE" == *"$MISSING='<unset>'"* ]]
done
# Still exactly the one endpoint creation from the runs above — each refusal
# happens before anything is created.
[[ "$(grep -c '^lambda-web create-web-function-endpoint ' "$TEST_AWS_LOG")" == "1" ]]

# The selected function must reconcile its existing global endpoint to home's
# revision without creating a revision or changing scaling/rate controls.
rm -f "$TEST_ENDPOINT_MARKER"
: > "$TEST_AWS_LOG"
DRIFT="$(TEST_EXISTING=1 TEST_DRIFT=1 run_mode)"
[[ "$DRIFT" == *"Updating global"* ]]
[[ "$(grep -c '^lambda-web update-web-function-endpoint ' "$TEST_AWS_LOG")" == 1 ]]
! grep -q '^lambda-web create-web-function-endpoint ' "$TEST_AWS_LOG"
grep -q '^lambda-web wait web-function-endpoint-updated ' "$TEST_AWS_LOG"
jq -e '. == {"revisionWeights":[{"revisionId":"rev-new","weight":100}]}' "$TEST_UPDATE_CONFIG" >/dev/null
while IFS= read -r call; do
  [[ "$call" == *"--function-name serverlessq-live-api "* ]]
done < <(grep '^lambda-web ' "$TEST_AWS_LOG" | grep -v '^lambda-web help')
[[ "$(grep -c -- '--endpoint-name home ' "$TEST_AWS_LOG")" == 2 ]]

for FIELD in endpointType authType autoDeploymentMode regions; do
  rm -f "$TEST_ENDPOINT_MARKER"
  : > "$TEST_AWS_LOG"
  set +e
  UNSAFE="$(TEST_EXISTING=1 TEST_DRIFT=1 TEST_UNSAFE_FIELD="$FIELD" run_mode 2>&1)"
  UNSAFE_STATUS=$?
  set -e
  [[ "$UNSAFE_STATUS" -ne 0 ]]
  [[ "$UNSAFE" == *"$FIELD"* ]]
  ! grep -q '^lambda-web \(create\|update\)-web-function-endpoint ' "$TEST_AWS_LOG"
done

# Missing, mismatched, and inactive revision prerequisites all precede mutation.
for PIN in DDB_REGION COGNITO_REGION COGNITO_USER_POOL_ID COGNITO_APP_CLIENT_ID; do
  for WRONG_VALUE in "" eu-west-1; do
    : > "$TEST_AWS_LOG"
    set +e
    case "$PIN" in
      DDB_REGION) REFUSAL="$(TEST_EXISTING=1 TEST_DRIFT=1 TEST_REVISION_DDB_REGION="$WRONG_VALUE" run_mode 2>&1)" ;;
      COGNITO_REGION) REFUSAL="$(TEST_EXISTING=1 TEST_DRIFT=1 TEST_REVISION_COGNITO_REGION="$WRONG_VALUE" run_mode 2>&1)" ;;
      COGNITO_USER_POOL_ID) REFUSAL="$(TEST_EXISTING=1 TEST_DRIFT=1 TEST_REVISION_COGNITO_USER_POOL_ID="$WRONG_VALUE" run_mode 2>&1)" ;;
      COGNITO_APP_CLIENT_ID) REFUSAL="$(TEST_EXISTING=1 TEST_DRIFT=1 TEST_REVISION_COGNITO_APP_CLIENT_ID="$WRONG_VALUE" run_mode 2>&1)" ;;
    esac
    REFUSAL_STATUS=$?
    set -e
    [[ "$REFUSAL_STATUS" -ne 0 ]]
    [[ "$REFUSAL" == *"$PIN="* ]]
    ! grep -q '^lambda-web \(create\|update\)-web-function-endpoint ' "$TEST_AWS_LOG"
  done
done
: > "$TEST_AWS_LOG"
if TEST_EXISTING=1 TEST_DRIFT=1 TEST_REVISION_STATE=Pending run_mode >"$TMP/inactive.log" 2>&1; then
  printf 'An inactive revision must not be promoted.\n' >&2
  exit 1
fi
! grep -q '^lambda-web \(create\|update\)-web-function-endpoint ' "$TEST_AWS_LOG"

# Configured traffic controls are supplied only when a MultiRegion endpoint is
# created. Unset runs above always use the finite defaults.
rm -f "$TEST_ENDPOINT_MARKER"
: > "$TEST_AWS_LOG"
ENDPOINT_RATE_LIMIT=300 ENDPOINT_MAX_ENVIRONMENTS=12 run_mode >/dev/null
jq -e '. == {"rateLimit":300}' "$TEST_THROTTLE_CONFIG" >/dev/null
jq -e '. == {"maxEnvironments":12}' "$TEST_SCALING_CONFIG" >/dev/null

# Creation must not be reported as successful when effective controls differ.
for CONTROL in rate scaling; do
  rm -f "$TEST_ENDPOINT_MARKER"
  if TEST_FINAL_BAD_CONTROL="$CONTROL" run_mode >"$TMP/control.log" 2>&1; then
    printf 'Mismatched effective MultiRegion %s control must fail.\n' "$CONTROL" >&2
    exit 1
  fi
done

# A zero-rate creation remains closed to HTTP but must complete control-plane
# verification successfully, without attempting a request that must be 429.
rm -f "$TEST_ENDPOINT_MARKER"
: > "$TEST_CURL_LOG"
ZERO="$(ENDPOINT_RATE_LIMIT=0 ENDPOINT_MAX_ENVIRONMENTS=5 run_mode)"
[[ "$ZERO" == *"HTTP smoke skipped"* ]]
[[ ! -s "$TEST_CURL_LOG" ]]
jq -e '. == {"rateLimit":0}' "$TEST_THROTTLE_CONFIG" >/dev/null
jq -e '. == {"maxEnvironments":5}' "$TEST_SCALING_CONFIG" >/dev/null

# A traffic-enabled endpoint still propagates HTTP failure.
rm -f "$TEST_ENDPOINT_MARKER"
if ENDPOINT_RATE_LIMIT=100 TEST_SMOKE_FAIL=1 run_mode >"$TMP/smoke.log" 2>&1; then
  printf 'Traffic-enabled MultiRegion smoke failure must propagate.\n' >&2
  exit 1
fi
[[ -s "$TEST_CURL_LOG" ]]

echo "deploy multi-region regression: PASS"
