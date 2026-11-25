terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

# Single provider in the primary region, and that is now the whole story: every
# resource here lives in exactly one region. Nothing is replicated, so there are
# no per-region provider aliases. Functions serving from other regions reach back
# to these resources via DDB_REGION and COGNITO_REGION.
provider "aws" {
  region = var.primary_region
}
