# Administrator identities are created by an operator, never stored in state.
resource "aws_cognito_user_pool" "admin" {
  name                     = "${local.resource_prefix}-admins"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  tags                     = local.tags

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_client" "admin" {
  name                          = "${local.resource_prefix}-admin-spa"
  user_pool_id                  = aws_cognito_user_pool.admin.id
  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  access_token_validity         = 15
  id_token_validity             = 15
  refresh_token_validity        = 8

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "hours"
  }
}

resource "aws_cognito_user_group" "admins" {
  name         = "admins"
  user_pool_id = aws_cognito_user_pool.admin.id
  description  = "Administrators allowed to operate the trivia console"
}
