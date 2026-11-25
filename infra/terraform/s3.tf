# Versioned S3 bucket holding the function ZIPs. Shared across both functions
# with key-prefix isolation (<function>/function.zip). Lambda reads the code by
# object version at revision-create time.

resource "aws_s3_bucket" "code" {
  # checkov:skip=CKV_AWS_18:Private rebuildable deployment ZIPs; S3 server access logging is not provisioned.
  # checkov:skip=CKV_AWS_144:Rebuildable deployment ZIPs in one private region do not require cross-region replication.
  # checkov:skip=CKV2_AWS_62:No application consumer depends on deployment-artifact upload event notifications.
  # checkov:skip=CKV_AWS_145:Rebuildable ZIPs use S3-managed default encryption; this artifact bucket does not require KMS-by-default.
  bucket = local.code_bucket_name
  tags   = local.tags

  # Deliberate: this bucket holds nothing but rebuildable function ZIPs, and
  # versioning is on, so a `terraform destroy` would otherwise fail with
  # BucketNotEmpty and need every object version purged by hand first. The sample
  # environment is meant to be torn down and rebuilt; scripts/teardown.sh is
  # where a human confirms.
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "code" {
  bucket = aws_s3_bucket.code.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "code" {
  bucket = aws_s3_bucket.code.id

  rule {
    id     = "rebuildable-deployment-artifacts"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.code]
}

resource "aws_s3_bucket_public_access_block" "code" {
  bucket                  = aws_s3_bucket.code.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Allow the Lambda service to pull code objects (scoped to this account's
# web functions) — the code bucket is never public.
data "aws_iam_policy_document" "code_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.code.arn,
      "${aws_s3_bucket.code.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "LambdaReadCode"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.code.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "code" {
  bucket = aws_s3_bucket.code.id
  policy = data.aws_iam_policy_document.code_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.code]
}
