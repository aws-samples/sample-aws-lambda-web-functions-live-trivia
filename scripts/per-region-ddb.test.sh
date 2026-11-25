#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/bin"

export TEST_AWS_LOG="$TMP_DIR/aws.log"
export TEST_ENDPOINT_CREATED="$TMP_DIR/endpoint-created"

cat >"$TMP_DIR/bin/terraform" <<'FAKE_TERRAFORM'
#!/usr/bin/env bash
cat <<'JSON'
{
  "primary_region": {"value": "us-east-1"},
  "ddb_region": {"value": "us-east-1"},
  "regions": {"value": ["us-east-1", "us-west-2"]},
  "api_function_name": {"value": "serverlessq-api"}
}
JSON
FAKE_TERRAFORM

cat >"$TMP_DIR/bin/aws" <<'FAKE_AWS'
#!/usr/bin/env bash
printf '%q ' "$@" >>"$TEST_AWS_LOG"
printf '\n' >>"$TEST_AWS_LOG"

if [[ "$1 $2" == "sts get-caller-identity" ]]; then
  printf '123456789012\n'
  exit 0
fi

if [[ "$1 $2" != "lambda-web get-web-function-endpoint" &&
      "$1 $2" != "lambda-web get-web-function-revision" &&
      "$1 $2" != "lambda-web create-web-function-endpoint" &&
      "$1 $2" != "lambda-web delete-web-function-endpoint" &&
      "$1 $2" != "lambda-web wait" ]]; then
  echo "unexpected aws call: $*" >&2
  exit 98
fi

endpoint=""
for ((i = 1; i <= $#; i += 1)); do
  if [[ "${!i}" == "--endpoint-name" ]]; then
    next=$((i + 1))
    endpoint="${!next}"
  fi
done

if [[ "$1 $2" == "lambda-web get-web-function-endpoint" && "$endpoint" == "home" ]]; then
  cat <<'JSON'
{"functionArn":"arn:aws:lambda:us-east-1:123456789012:web-function/serverlessq-api","endpointName":"home","endpointType":"HomeRegion","domainName":"home.example.test","authType":"ApplicationManaged","autoDeploymentMode":"LatestRevision","revisionWeights":[{"revisionId":"rev-current","weight":100}],"regions":["us-east-1"],"state":"Active"}
JSON
  exit 0
fi

if [[ "$1 $2" == "lambda-web get-web-function-revision" ]]; then
  cat <<'JSON'
{"revisionId":"rev-current","state":"Active","serviceConfig":{"environmentVariables":{"DDB_REGION":"us-east-1","COGNITO_REGION":"us-east-1","COGNITO_USER_POOL_ID":"us-east-1_fixture","COGNITO_APP_CLIENT_ID":"fixtureclient"}}}
JSON
  exit 0
fi

if [[ "$1 $2" == "lambda-web get-web-function-endpoint" &&
      "$endpoint" == "ddb-per-region-test" ]]; then
  if [[ ! -f "$TEST_ENDPOINT_CREATED" ]]; then
    echo "ResourceNotFoundException" >&2
    exit 254
  fi
  cat <<'JSON'
{"endpointName":"ddb-per-region-test","endpointType":"PerRegion","domainName":"shared.example.test","authType":"ApplicationManaged","autoDeploymentMode":"Disabled","revisionWeights":[{"revisionId":"rev-current","weight":100}],"regions":["us-east-1","us-west-2"],"state":"Active","regionalEndpoints":{"us-east-1":{"domainName":"east.example.test","state":"Active"},"us-west-2":{"domainName":"west.example.test","state":"Active"}}}
JSON
  exit 0
fi

if [[ "$1 $2" == "lambda-web create-web-function-endpoint" ]]; then
  touch "$TEST_ENDPOINT_CREATED"
  exit 0
fi

if [[ "$1 $2" == "lambda-web delete-web-function-endpoint" ]]; then
  rm -f "$TEST_ENDPOINT_CREATED"
  exit 0
fi

if [[ "$1 $2" == "lambda-web wait" ]]; then
  exit 0
fi

echo "unhandled aws call: $*" >&2
exit 97
FAKE_AWS

cat >"$TMP_DIR/bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
url="${!#}"
case "$url" in
  */api/health)
    printf '{"status":"ok","region":"us-west-2","revision":"568bf84"}'
    ;;
  */api/games/active)
    printf '{"games":[]}'
    ;;
  *)
    echo "unexpected curl URL: $url" >&2
    exit 96
    ;;
esac
FAKE_CURL

chmod +x "$TMP_DIR/bin/terraform" "$TMP_DIR/bin/aws" "$TMP_DIR/bin/curl"

OUTPUT="$(
  PATH="$TMP_DIR/bin:$PATH" \
    AWS_PROFILE=demo-profile \
    bash "$ROOT_DIR/scripts/per-region-ddb.sh"
)"

[[ "$OUTPUT" == *"PASS: us-west-2 served the request and read DynamoDB in us-east-1"* ]]
grep -q '^lambda-web create-web-function-endpoint ' "$TEST_AWS_LOG"
grep -q -- '--function-name serverlessq-api' "$TEST_AWS_LOG"
grep -q -- '--endpoint-name ddb-per-region-test' "$TEST_AWS_LOG"
grep -q -- '--endpoint-type PerRegion' "$TEST_AWS_LOG"
grep -q -- '--auto-deployment-mode Disabled' "$TEST_AWS_LOG"
grep -q -- '--revision-weights .*rev-current.*100' "$TEST_AWS_LOG"
grep -q -- '--regions us-west-2' "$TEST_AWS_LOG"
grep -q '^lambda-web delete-web-function-endpoint ' "$TEST_AWS_LOG"
[[ ! -f "$TEST_ENDPOINT_CREATED" ]]

echo "per-region DDB test harness: PASS"
