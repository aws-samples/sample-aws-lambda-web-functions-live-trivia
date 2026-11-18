# scripts/terraform.sh maps TRIVIA_ENV_NAME to TF_WORKSPACE. The workspace owns
# both the state and its resource names, so changing a name cannot rename an
# existing environment's resources. The default workspace preserves the
# original deployment and its naming variables.
locals {
  environment_name  = terraform.workspace == "default" ? "" : terraform.workspace
  resource_prefix   = local.environment_name == "" ? "serverlessq" : "serverlessq-${local.environment_name}"
  api_function_name = local.environment_name == "" ? var.api_function_name : "${local.resource_prefix}-api"
  web_function_name = local.environment_name == "" ? var.web_function_name : "${local.resource_prefix}-web"
  table_prefix      = local.environment_name == "" ? var.table_prefix : "${local.environment_name}-"
  # Keep the full environment, account and region even for long names. Dropping
  # only the descriptive label avoids S3's 63-character limit without truncating
  # environment names that distinguish otherwise independent workspaces.
  code_bucket_name_full = "${local.resource_prefix}-web-code-${local.account_id}-${var.primary_region}"
  code_bucket_name      = length(local.code_bucket_name_full) <= 63 ? local.code_bucket_name_full : "${local.resource_prefix}-${local.account_id}-${var.primary_region}"
  tags                  = merge(var.tags, local.environment_name == "" ? {} : { Environment = local.environment_name })
}
