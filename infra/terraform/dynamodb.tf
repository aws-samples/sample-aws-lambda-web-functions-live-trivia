# DynamoDB regional tables (design §4), all in var.primary_region. That region is
# published to the functions as DDB_REGION so the data plane is addressed
# explicitly rather than inferred from wherever the sandbox happens to run.
#
# All PAY_PER_REQUEST (on-demand, NFR-10a): no capacity planning, instant scale
# for spiky live-audience traffic, $0 idle.
#
# No replicas and no streams. These were Global Tables; the streams existed only
# to carry that replication, and nothing else in this stack consumes them.

locals {
  table_names = {
    question_sets = "${local.table_prefix}serverlessq-question-sets"
    questions     = "${local.table_prefix}serverlessq-questions"
    games         = "${local.table_prefix}serverlessq-games"
    participants  = "${local.table_prefix}serverlessq-participants"
    answers       = "${local.table_prefix}serverlessq-answers"
    scores        = "${local.table_prefix}serverlessq-scores"
  }
}

# ── QUESTION_SETS: PK questionSetId ──────────────────────────────────────────
# Named containers for questions. A handful of admin-owned rows read whole, so
# there is no index: listing is a scan and lookups are by id.
resource "aws_dynamodb_table" "question_sets" {
  # checkov:skip=CKV_AWS_119:Educational trivia sample retains DynamoDB AWS-owned encryption; customer-managed key control and auditing are outside its scope.
  name         = local.table_names.question_sets
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "questionSetId"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "questionSetId"
    type = "S"
  }

  dynamic "ttl" {
    for_each = var.enable_ttl ? [1] : []
    content {
      attribute_name = "expiresAt"
      enabled        = true
    }
  }

  tags = local.tags
}

# ── QUESTIONS: PK questionId; GSIs question-set-index, category-index ────────
resource "aws_dynamodb_table" "questions" {
  # checkov:skip=CKV_AWS_119:Educational trivia sample retains DynamoDB AWS-owned encryption; customer-managed key control and auditing are outside its scope.
  name         = local.table_names.questions
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "questionId"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "questionId"
    type = "S"
  }
  attribute {
    name = "questionSetId"
    type = "S"
  }
  attribute {
    name = "category"
    type = "S"
  }

  # The read path for both the admin pool view and a game's random draw: every
  # question belongs to exactly one set, so this replaces the full-table scan.
  global_secondary_index {
    name            = "question-set-index"
    projection_type = "ALL"
    key_schema {
      attribute_name = "questionSetId"
      key_type       = "HASH"
    }
  }

  global_secondary_index {
    name            = "category-index"
    projection_type = "ALL"
    key_schema {
      attribute_name = "category"
      key_type       = "HASH"
    }
  }

  dynamic "ttl" {
    for_each = var.enable_ttl ? [1] : []
    content {
      attribute_name = "expiresAt"
      enabled        = true
    }
  }

  tags = local.tags
}

# ── GAMES: PK gameId; sparse GSI active-index (PK active='Y') ────────────────
resource "aws_dynamodb_table" "games" {
  # checkov:skip=CKV_AWS_119:Educational trivia sample retains DynamoDB AWS-owned encryption; customer-managed key control and auditing are outside its scope.
  name         = local.table_names.games
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "gameId"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "gameId"
    type = "S"
  }
  attribute {
    name = "active"
    type = "S"
  }

  # Sparse index: only listed games carry `active='Y'` (several at once — games
  # run in parallel, and activation is additive).
  global_secondary_index {
    name            = "active-index"
    projection_type = "ALL"
    key_schema {
      attribute_name = "active"
      key_type       = "HASH"
    }
  }

  dynamic "ttl" {
    for_each = var.enable_ttl ? [1] : []
    content {
      attribute_name = "expiresAt"
      enabled        = true
    }
  }

  tags = local.tags
}

# ── PARTICIPANTS: composite key (gameId, playerId) ──────────────────────────
resource "aws_dynamodb_table" "participants" {
  # checkov:skip=CKV_AWS_119:Educational trivia sample retains DynamoDB AWS-owned encryption; customer-managed key control and auditing are outside its scope.
  name         = local.table_names.participants
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "gameId"
  range_key    = "playerId"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "gameId"
    type = "S"
  }
  attribute {
    name = "playerId"
    type = "S"
  }

  dynamic "ttl" {
    for_each = var.enable_ttl ? [1] : []
    content {
      attribute_name = "expiresAt"
      enabled        = true
    }
  }

  tags = local.tags
}

# ── ANSWERS: composite key (gameId, sk=Q#<idx>#P#<playerId>) ─────────────────
resource "aws_dynamodb_table" "answers" {
  # checkov:skip=CKV_AWS_119:Educational trivia sample retains DynamoDB AWS-owned encryption; customer-managed key control and auditing are outside its scope.
  name         = local.table_names.answers
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "gameId"
  range_key    = "sk"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "gameId"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  dynamic "ttl" {
    for_each = var.enable_ttl ? [1] : []
    content {
      attribute_name = "expiresAt"
      enabled        = true
    }
  }

  tags = local.tags
}

# ── SCORES: composite key (gameId, playerId); GSI leaderboard-index ─────────
# leaderboard-index: PK gameId, SK cumulativePoints (Number) → top-N via
# ScanIndexForward=false. INCLUDE projection keeps GSI items tiny (§4).
resource "aws_dynamodb_table" "scores" {
  # checkov:skip=CKV_AWS_119:Educational trivia sample retains DynamoDB AWS-owned encryption; customer-managed key control and auditing are outside its scope.
  name         = local.table_names.scores
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "gameId"
  range_key    = "playerId"

  point_in_time_recovery {
    enabled = true
  }

  attribute {
    name = "gameId"
    type = "S"
  }
  attribute {
    name = "playerId"
    type = "S"
  }
  attribute {
    name = "cumulativePoints"
    type = "N"
  }

  # `lastCorrectAt` is load-bearing, not decorative: getLeaderboard reads its rows
  # from this index rather than the table, so an attribute missing from the
  # projection arrives as `undefined` and the points tie-break silently loses its
  # speed component, ranking tied players alphabetically. See compareScoreRows.
  global_secondary_index {
    name               = "leaderboard-index"
    projection_type    = "INCLUDE"
    non_key_attributes = ["name", "currentStreak", "lastCorrectAt"]
    key_schema {
      attribute_name = "gameId"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "cumulativePoints"
      key_type       = "RANGE"
    }
  }

  dynamic "ttl" {
    for_each = var.enable_ttl ? [1] : []
    content {
      attribute_name = "expiresAt"
      enabled        = true
    }
  }

  tags = local.tags
}
