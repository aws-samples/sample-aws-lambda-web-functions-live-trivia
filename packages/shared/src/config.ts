/**
 * Runtime configuration resolved from environment variables with safe
 * defaults. Table names support a prefix so local and integration runs can
 * target isolated development tables.
 */

const prefix = process.env.SERVERLESSQ_TABLE_PREFIX ?? '';
export const environmentName = process.env.TRIVIA_ENV_NAME ?? '';
export const functionName = process.env.TRIVIA_FUNCTION_NAME ?? '';

/** DynamoDB table names (regional tables, one per entity — design §4). */
export const tables = {
  questionSets: `${prefix}serverlessq-question-sets`,
  questions: `${prefix}serverlessq-questions`,
  games: `${prefix}serverlessq-games`,
  participants: `${prefix}serverlessq-participants`,
  answers: `${prefix}serverlessq-answers`,
  scores: `${prefix}serverlessq-scores`,
} as const;

/** GSI names (design §4 key/index notes). */
export const indexes = {
  /** QUESTIONS by owning set — the pool is read per set, never as one flat scan. */
  questionSetIndex: 'question-set-index',
  categoryIndex: 'category-index',
  activeIndex: 'active-index',
  leaderboardIndex: 'leaderboard-index',
} as const;

/**
 * The region this code is RUNNING in. Lambda injects AWS_REGION in the sandbox.
 * Outside Lambda, leaving it undefined lets the AWS SDK use its standard region
 * provider chain. Used for the serving-region health field, the EMF `region`
 * dimension — never for DynamoDB or Cognito; see their explicit configuration.
 */
export const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

/**
 * The region the DynamoDB tables are IN — always this, for every DynamoDB call.
 *
 * The tables are regional, not Global Tables, so they exist in exactly one
 * region and a sandbox serving from anywhere else must still address that one.
 * `DDB_REGION` is set at deploy time from the Terraform table region, which is
 * the only thing that actually knows where they live; falling back to the
 * sandbox's own region keeps `make run-api` and the seed script working locally,
 * where the two are the same.
 */
export const ddbRegion = process.env.DDB_REGION ?? region;

/** Non-secret Cognito identifiers, pinned to the infrastructure's primary region. */
export const cognitoConfig = {
  userPoolId: process.env.COGNITO_USER_POOL_ID ?? '',
  clientId: process.env.COGNITO_APP_CLIENT_ID ?? '',
  region: process.env.COGNITO_REGION ?? '',
};

/** Revision identifier surfaced by /api/health for deployment verification. */
export const revisionId = process.env.REVISION_ID ?? 'local';

/** Timers (ms unless noted) — SSE lifecycle & leaderboard polling (DD-3, D5). */
export const timers = {
  /** Server→DynamoDB poll cadence for the shared per-sandbox poller (D5, 1–2 s). */
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 1500),
  /** SSE heartbeat comment cadence. */
  heartbeatMs: Number(process.env.SSE_HEARTBEAT_MS ?? 15_000),
} as const;

/** Per-execution-environment SSE caps; endpoint limits do not bound open streams. */
export const sseConnectionLimits = {
  perGame: Math.max(1, Number(process.env.SSE_MAX_CONNECTIONS_PER_GAME) || 50),
  perEnvironment: Math.max(1, Number(process.env.SSE_MAX_CONNECTIONS_PER_ENVIRONMENT) || 100),
} as const;

/** Default per-question countdown when a game is created without an explicit value. */
export const defaultQuestionDurationSec = Number(process.env.DEFAULT_QUESTION_DURATION_SEC ?? 20);

/**
 * Reveal a round as soon as every joined player has answered, instead of always
 * running the countdown to zero (FR-8).
 *
 * A kill switch rather than a constant because the trigger depends on room
 * dynamics the code cannot see: with a QR-driven lobby, "everyone" only ever
 * means the players who have already joined, so a small room that answers fast
 * can cut a round short while others are still scanning. Set
 * `EARLY_REVEAL=false` to hand pacing back to the countdown and the host.
 */
export const earlyRevealWhenAllAnswered = (process.env.EARLY_REVEAL ?? 'true') !== 'false';

/** How many leaderboard rows to stream/return by default. */
export const leaderboardTopN = Number(process.env.LEADERBOARD_TOP_N ?? 10);
