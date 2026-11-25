# Shared environment selection for repository shell scripts.
# Pass the repository root explicitly so sourcing never depends on the caller's
# working directory or shell-specific script-path syntax.

trivia_select_environment() {
  local trivia_root="$1"
  local trivia_name="${TRIVIA_ENV_NAME:-}"
  if [[ -n "$trivia_name" ]]; then
    if [[ "$trivia_name" == "default" || ${#trivia_name} -gt 20 ||
          ! "$trivia_name" =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ ]]; then
      echo "✗ TRIVIA_ENV_NAME must be 1–20 lowercase letters, digits or hyphens, start with a letter, and have no trailing or consecutive hyphens; 'default' is reserved." >&2
      return 1
    fi
  fi

  # An explicit process-local workspace also lets two terminals work on
  # different environments without changing Terraform's shared workspace file.
  export TF_WORKSPACE="${trivia_name:-default}"
  TRIVIA_TF_DIR="$trivia_root/infra/terraform"
  TRIVIA_RESOURCE_PREFIX="serverlessq${trivia_name:+-$trivia_name}"
}

trivia_output() {
  jq -r --arg key "$2" '.[$key].value // empty' <<<"$1"
}

trivia_load_outputs() {
  local trivia_outputs="$1"
  local trivia_state_name
  trivia_state_name="$(trivia_output "$trivia_outputs" environment_name)" || return 1
  if [[ "$trivia_state_name" != "${TRIVIA_ENV_NAME:-}" ]]; then
    echo "✗ Terraform outputs do not match TRIVIA_ENV_NAME=${TRIVIA_ENV_NAME:-<unset>}. Run scripts/terraform.sh apply for this environment first." >&2
    return 1
  fi
  TRIVIA_API_NAME="$(trivia_output "$trivia_outputs" api_function_name)"
  TRIVIA_WEB_NAME="$(trivia_output "$trivia_outputs" web_function_name)"
  TRIVIA_TABLE_PREFIX="$(trivia_output "$trivia_outputs" table_prefix)"
  if [[ -n "${TRIVIA_ENV_NAME:-}" ]]; then
    [[ -n "$TRIVIA_API_NAME" && -n "$TRIVIA_WEB_NAME" && -n "$TRIVIA_TABLE_PREFIX" ]] || {
      echo "✗ Terraform naming outputs are missing. Run scripts/terraform.sh apply first." >&2
      return 1
    }
  else
    # Old default-workspace state predates these outputs. Infer its table
    # prefix from the existing table names without requiring an infrastructure
    # apply just to deploy a function.
    TRIVIA_API_NAME="${TRIVIA_API_NAME:-serverlessq-api}"
    TRIVIA_WEB_NAME="${TRIVIA_WEB_NAME:-serverlessq-web}"
    if ! jq -e 'has("table_prefix")' <<<"$trivia_outputs" >/dev/null; then
      TRIVIA_TABLE_PREFIX="$(jq -r '.table_names.value.games // "" | sub("serverlessq-games$"; "")' <<<"$trivia_outputs")"
    fi
  fi
  if [[ -n "${TABLE_PREFIX+x}" && "$TABLE_PREFIX" != "$TRIVIA_TABLE_PREFIX" ]]; then
    echo "✗ TABLE_PREFIX differs from the selected Terraform environment. Unset TABLE_PREFIX and retry." >&2
    return 1
  fi
  TABLE_PREFIX="$TRIVIA_TABLE_PREFIX"
}

trivia_check_function() {
  local trivia_function="$1"
  local trivia_base="$2"
  if [[ "$trivia_function" != "$trivia_base" ]]; then
    echo "✗ Function '$trivia_function' does not match the selected Terraform environment. Unset API_FUNCTION and WEB_FUNCTION and retry." >&2
    return 1
  fi
}

trivia_check_account() {
  local trivia_role="$1"
  local trivia_account
  trivia_account="$(cut -d: -f5 <<<"$trivia_role")"
  local trivia_caller
  trivia_caller="$(aws sts get-caller-identity --query Account --output text)" || return 1
  if [[ "$trivia_account" != "$trivia_caller" ]]; then
    echo "✗ AWS credentials are for account $trivia_caller, but this Terraform environment belongs to $trivia_account. Set AWS_PROFILE to the matching profile." >&2
    return 1
  fi
}
