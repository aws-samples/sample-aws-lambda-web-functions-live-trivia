# Run without AWS credentials or API calls:
#   TRIVIA_ENV_NAME=demo1 scripts/terraform.sh test
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

variables {
  primary_region    = "us-east-1"
  replica_regions   = ["eu-west-1", "ap-southeast-1"]
  table_prefix      = "legacy-"
  api_function_name = "custom-api"
  web_function_name = "custom-web"
}

run "environment_names" {
  command = plan

  assert {
    condition     = output.environment_name == "demo1"
    error_message = "Run this test with TRIVIA_ENV_NAME=demo1."
  }
  assert {
    condition     = output.api_function_name == "serverlessq-demo1-api" && output.web_function_name == "serverlessq-demo1-web"
    error_message = "Function names must belong to demo1."
  }
  assert {
    condition = output.table_prefix == "demo1-" && output.table_names == {
      question_sets = "demo1-serverlessq-question-sets"
      questions     = "demo1-serverlessq-questions"
      games         = "demo1-serverlessq-games"
      participants  = "demo1-serverlessq-participants"
      answers       = "demo1-serverlessq-answers"
      scores        = "demo1-serverlessq-scores"
    }
    error_message = "All six tables must use demo1's prefix, ignoring default-workspace naming overrides."
  }
  assert {
    condition     = aws_s3_bucket.code.bucket == "serverlessq-demo1-web-code-123456789012-us-east-1"
    error_message = "The code bucket must include the environment, account and primary region."
  }
  assert {
    condition     = aws_cognito_user_pool.admin.name == "serverlessq-demo1-admins"
    error_message = "The administrator pool must belong to demo1."
  }
  assert {
    condition     = aws_iam_role.api.name == "serverlessq-demo1-api-web-role" && aws_iam_role.web.name == "serverlessq-demo1-web-web-role"
    error_message = "Execution roles must belong to demo1."
  }
}

run "deployment_outputs_track_primary_region" {
  command = plan

  variables {
    primary_region  = "eu-central-1"
    replica_regions = []
  }

  assert {
    condition     = output.primary_region == "eu-central-1" && output.ddb_region == "eu-central-1" && output.cognito_region == "eu-central-1" && output.regions == ["eu-central-1"]
    error_message = "Deployment regions must follow the configured primary region."
  }
  assert {
    condition     = aws_s3_bucket.code.bucket == "serverlessq-demo1-web-code-123456789012-eu-central-1" && output.code_bucket == aws_s3_bucket.code.bucket
    error_message = "The code bucket and deployment output must follow the primary region."
  }
}

run "administrator_authentication_defaults" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool.admin.admin_create_user_config[0].allow_admin_create_user_only && aws_cognito_user_group.admins.name == "admins"
    error_message = "Only an operator may create users, and admins is the authorization group."
  }
  assert {
    condition     = !aws_cognito_user_pool_client.admin.generate_secret && toset(aws_cognito_user_pool_client.admin.explicit_auth_flows) == toset(["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"])
    error_message = "The public SPA must authenticate with SRP and refresh tokens without a client secret."
  }
  assert {
    condition     = aws_cognito_user_pool_client.admin.prevent_user_existence_errors == "ENABLED" && aws_cognito_user_pool_client.admin.enable_token_revocation
    error_message = "Prevent account enumeration and enable refresh token revocation."
  }
  assert {
    condition     = aws_cognito_user_pool_client.admin.access_token_validity == 15 && aws_cognito_user_pool_client.admin.id_token_validity == 15 && aws_cognito_user_pool_client.admin.refresh_token_validity == 8 && aws_cognito_user_pool_client.admin.token_validity_units[0].access_token == "minutes" && aws_cognito_user_pool_client.admin.token_validity_units[0].id_token == "minutes" && aws_cognito_user_pool_client.admin.token_validity_units[0].refresh_token == "hours"
    error_message = "Access and ID tokens last 15 minutes; refresh tokens last 8 hours."
  }
}

run "retained_data_and_rebuildable_artifact_protection" {
  command = plan

  assert {
    condition = alltrue([
      aws_dynamodb_table.question_sets.point_in_time_recovery[0].enabled,
      aws_dynamodb_table.questions.point_in_time_recovery[0].enabled,
      aws_dynamodb_table.games.point_in_time_recovery[0].enabled,
      aws_dynamodb_table.participants.point_in_time_recovery[0].enabled,
      aws_dynamodb_table.answers.point_in_time_recovery[0].enabled,
      aws_dynamodb_table.scores.point_in_time_recovery[0].enabled,
    ])
    error_message = "All six retained tables must enable point-in-time recovery."
  }
  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.code.rule[0].status == "Enabled" && aws_s3_bucket_lifecycle_configuration.code.rule[0].noncurrent_version_expiration[0].noncurrent_days == 30 && aws_s3_bucket_lifecycle_configuration.code.rule[0].abort_incomplete_multipart_upload[0].days_after_initiation == 7
    error_message = "Rebuildable noncurrent ZIPs expire after 30 days and incomplete uploads after 7 days."
  }
  assert {
    condition     = aws_s3_bucket_versioning.code.versioning_configuration[0].status == "Enabled" && aws_s3_bucket_public_access_block.code.block_public_acls && aws_s3_bucket_public_access_block.code.block_public_policy && aws_s3_bucket_public_access_block.code.ignore_public_acls && aws_s3_bucket_public_access_block.code.restrict_public_buckets
    error_message = "Artifact cleanup must retain versioning and every public access block."
  }
  assert {
    condition = one([
      for statement in data.aws_iam_policy_document.code_bucket.statement :
      statement if statement.sid == "DenyInsecureTransport"
      ]).effect == "Deny" && toset(one([
        for statement in data.aws_iam_policy_document.code_bucket.statement :
        statement if statement.sid == "DenyInsecureTransport"
    ]).actions) == toset(["s3:*"])
    error_message = "The artifact bucket policy must deny every insecure transport operation."
  }
}

run "least_privilege_function_logging" {
  command = plan

  assert {
    condition = toset(one([
      for statement in data.aws_iam_policy_document.api.statement :
      statement if statement.sid == "CreateLogGroups"
      ]).resources) == toset([
      "arn:${data.aws_partition.current.partition}:logs:*:123456789012:log-group:/aws/lambda/web/${local.api_function_name}",
      "arn:${data.aws_partition.current.partition}:logs:*:123456789012:log-group:/aws/lambda/web/${local.api_function_name}.local",
    ])
    error_message = "The API role may create only its exact central and regional log groups."
  }
  assert {
    condition = toset(one([
      for statement in data.aws_iam_policy_document.web.statement :
      statement if statement.sid == "WriteFunctionLogs"
      ]).resources) == toset([
      "arn:${data.aws_partition.current.partition}:logs:*:123456789012:log-group:/aws/lambda/web/${local.web_function_name}:*",
      "arn:${data.aws_partition.current.partition}:logs:*:123456789012:log-group:/aws/lambda/web/${local.web_function_name}.local:*",
    ])
    error_message = "The web role may write only streams beneath its exact log groups."
  }
}

run "global_secondary_indexes_use_key_schema" {
  command = plan

  assert {
    condition = toset([
      for key in one([
        for index in aws_dynamodb_table.scores.global_secondary_index :
        index if index.name == "leaderboard-index"
      ]).key_schema :
      "${key.key_type}:${key.attribute_name}"
    ]) == toset(["HASH:gameId", "RANGE:cumulativePoints"])
    error_message = "The leaderboard index must retain its partition and sort key schema."
  }
  assert {
    condition = alltrue([
      one(one([
        for index in aws_dynamodb_table.questions.global_secondary_index :
        index if index.name == "question-set-index"
      ]).key_schema).key_type == "HASH",
      one(one([
        for index in aws_dynamodb_table.questions.global_secondary_index :
        index if index.name == "category-index"
      ]).key_schema).key_type == "HASH",
      one(one([
        for index in aws_dynamodb_table.games.global_secondary_index :
        index if index.name == "active-index"
      ]).key_schema).key_type == "HASH",
    ])
    error_message = "Every single-key GSI must use the provider's current key_schema block."
  }
}
