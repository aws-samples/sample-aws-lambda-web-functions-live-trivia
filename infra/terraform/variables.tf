variable "primary_region" {
  description = "AWS region holding the DynamoDB tables and the functions' home region. Deployed to both functions as DDB_REGION."
  type        = string
  default     = "us-east-1"
}

variable "replica_regions" {
  description = "Additional function regions for the Lambda MultiRegion endpoint (excludes primary_region). Resources remain in the primary region, addressed by DDB_REGION and COGNITO_REGION."
  type        = list(string)
  default     = []
}

locals {
  # Every region the FUNCTIONS may serve from (primary + additional). The data
  # plane does not follow this list: the tables live only in primary_region.
  all_regions = concat([var.primary_region], var.replica_regions)
}

variable "table_prefix" {
  description = "Table prefix in the default workspace. Named environments derive this from their workspace instead."
  type        = string
  default     = ""
}

variable "api_function_name" {
  description = "API function name in the default workspace. Named environments derive this from their workspace instead."
  type        = string
  default     = "serverlessq-api"
}

variable "web_function_name" {
  description = "Web function name in the default workspace. Named environments derive this from their workspace instead."
  type        = string
  default     = "serverlessq-web"
}

variable "enable_ttl" {
  description = "Enable DynamoDB TTL for items that include an expiresAt epoch-seconds attribute. The application does not currently populate this attribute."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default = {
    Project = "serverlessq-live-trivia"
  }
}
