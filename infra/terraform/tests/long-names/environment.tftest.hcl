# No AWS API calls:
#   TRIVIA_ENV_NAME=abcdefghijklmnopqrst scripts/terraform.sh test -test-directory=tests/long-names
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
  primary_region = "ap-southeast-7"
}

run "long_environment_bucket_name" {
  command = plan

  assert {
    condition     = output.environment_name == "abcdefghijklmnopqrst"
    error_message = "Run this test with TRIVIA_ENV_NAME=abcdefghijklmnopqrst."
  }
  assert {
    condition     = length(aws_s3_bucket.code.bucket) <= 63 && aws_s3_bucket.code.bucket == "serverlessq-abcdefghijklmnopqrst-123456789012-ap-southeast-7"
    error_message = "The maximum supported environment name must produce a valid bucket name preserving the environment, account and region."
  }
  assert {
    condition     = output.code_bucket == aws_s3_bucket.code.bucket
    error_message = "Deployment scripts must receive the compact bucket name from Terraform."
  }
}
