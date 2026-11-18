data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id

  # Wildcard-region ARNs. The tables are regional (one region, named by
  # DDB_REGION), so the wildcard is what lets a function serving from another
  # region still reach them — and it keeps the policy stable if the table region
  # ever moves.
  table_arns = [
    for name in values(local.table_names) :
    "arn:${data.aws_partition.current.partition}:dynamodb:*:${local.account_id}:table/${name}"
  ]
  table_index_arns = [
    for name in values(local.table_names) :
    "arn:${data.aws_partition.current.partition}:dynamodb:*:${local.account_id}:table/${name}/index/*"
  ]
}

# Trust policy shared by both web-function execution roles.
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ── API execution role: DynamoDB (own tables) + logs ───────────────────────
resource "aws_iam_role" "api" {
  name               = "${local.api_function_name}-web-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "api" {
  statement {
    sid = "DynamoDataAccess"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = concat(local.table_arns, local.table_index_arns)
  }

  statement {
    sid     = "CreateLogGroups"
    actions = ["logs:CreateLogGroup"]
    resources = [
      "arn:${data.aws_partition.current.partition}:logs:*:${local.account_id}:log-group:/aws/lambda/web/${local.api_function_name}",
      "arn:${data.aws_partition.current.partition}:logs:*:${local.account_id}:log-group:/aws/lambda/web/${local.api_function_name}.local",
    ]
  }

  statement {
    sid = "WriteFunctionLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:logs:*:${local.account_id}:log-group:/aws/lambda/web/${local.api_function_name}:*",
      "arn:${data.aws_partition.current.partition}:logs:*:${local.account_id}:log-group:/aws/lambda/web/${local.api_function_name}.local:*",
    ]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "${local.api_function_name}-policy"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# ── Web execution role: logs only (serves static assets, no data plane) ─────
resource "aws_iam_role" "web" {
  name               = "${local.web_function_name}-web-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "web" {
  statement {
    sid     = "CreateLogGroups"
    actions = ["logs:CreateLogGroup"]
    resources = [
      "arn:${data.aws_partition.current.partition}:logs:*:${local.account_id}:log-group:/aws/lambda/web/${local.web_function_name}",
      "arn:${data.aws_partition.current.partition}:logs:*:${local.account_id}:log-group:/aws/lambda/web/${local.web_function_name}.local",
    ]
  }

  statement {
    sid = "WriteFunctionLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:logs:*:${local.account_id}:log-group:/aws/lambda/web/${local.web_function_name}:*",
      "arn:${data.aws_partition.current.partition}:logs:*:${local.account_id}:log-group:/aws/lambda/web/${local.web_function_name}.local:*",
    ]
  }
}

resource "aws_iam_role_policy" "web" {
  name   = "${local.web_function_name}-policy"
  role   = aws_iam_role.web.id
  policy = data.aws_iam_policy_document.web.json
}
