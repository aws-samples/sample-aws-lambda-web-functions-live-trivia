# Consumed by scripts/deploy.sh (via `terraform output -json`).

output "environment_name" {
  value = local.environment_name

  precondition {
    condition = local.environment_name == "" || (
      local.environment_name != "default" &&
      length(local.environment_name) <= 20 &&
      can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", local.environment_name))
    )
    error_message = "Environment names must be 1–20 lowercase letters, digits or hyphens, start with a letter, and have no leading, trailing or consecutive hyphens."
  }
}

output "api_function_name" {
  value = local.api_function_name
}

output "web_function_name" {
  value = local.web_function_name
}

output "table_prefix" {
  value = local.table_prefix
}

output "primary_region" {
  value = var.primary_region
}

# Consumed by deploy.sh and set as the DDB_REGION environment variable on both
# functions. Named separately from `primary_region` because the two mean
# different things once a function serves from somewhere else: this one is where
# the tables ARE, not where the code runs.
output "ddb_region" {
  description = "Region holding the DynamoDB tables. Deployed as DDB_REGION."
  value       = var.primary_region
}

output "cognito_region" {
  description = "Primary region holding the administrator User Pool."
  value       = var.primary_region
}

output "regions" {
  description = "All regions the functions may serve from (primary + additional)."
  value       = local.all_regions
}

output "api_execution_role_arn" {
  value = aws_iam_role.api.arn
}

output "web_execution_role_arn" {
  value = aws_iam_role.web.arn
}

output "code_bucket" {
  value = aws_s3_bucket.code.bucket
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.admin.id
}

output "cognito_app_client_id" {
  value = aws_cognito_user_pool_client.admin.id
}

output "table_names" {
  value = local.table_names
}
