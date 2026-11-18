# Run in the original workspace with no AWS API calls:
#   TRIVIA_ENV_NAME= scripts/terraform.sh test -test-directory=tests/legacy
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}


variables {
  primary_region    = "us-east-1"
  replica_regions   = []
  table_prefix      = "dev-"
  api_function_name = "serverlessq-api"
  web_function_name = "serverlessq-web"
}

run "original_names" {
  command = plan

  assert {
    condition     = output.environment_name == "" && output.api_function_name == "serverlessq-api" && output.web_function_name == "serverlessq-web"
    error_message = "The default workspace must preserve the original function names."
  }
  assert {
    condition     = aws_dynamodb_table.games.name == "dev-serverlessq-games" && aws_s3_bucket.code.bucket == "serverlessq-web-code-123456789012-us-east-1"
    error_message = "The default workspace must preserve the existing tables and include the primary region in its code bucket name."
  }
  assert {
    condition = output.table_names == {
      question_sets = "dev-serverlessq-question-sets"
      questions     = "dev-serverlessq-questions"
      games         = "dev-serverlessq-games"
      participants  = "dev-serverlessq-participants"
      answers       = "dev-serverlessq-answers"
      scores        = "dev-serverlessq-scores"
    }
    error_message = "The default workspace must preserve all six legacy table names."
  }
  assert {
    condition     = aws_cognito_user_pool.admin.name == "serverlessq-admins" && aws_iam_role.api.name == "serverlessq-api-web-role"
    error_message = "The default workspace must create its administrator pool and preserve the execution role."
  }
}
