// Public surface of @serverlessq/shared.

// Domain types & DTOs
export type {
  GamePhase,
  ParticipantState,
  QuestionSet,
  Question,
  Game,
  Participant,
  Answer,
  Score,
  PublicGameState,
  LeaderboardEntry,
  LeaderboardSnapshot,
  HealthResponse,
  ApiErrorBody,
  ActiveGameSummary,
  ActiveGamesResponse,
  JoinPlayerRequest,
  JoinPlayerResponse,
  PlayerStatusResponse,
  SubmitAnswerRequest,
  SubmitAnswerResponse,
  QuestionSetInput,
  QuestionSetsResponse,
  QuestionSetResponse,
  CreateQuestionSetResponse,
  QuestionInput,
  QuestionsResponse,
  QuestionResponse,
  CreateQuestionResponse,
  QuestionSelection,
  CreateGameRequest,
  GamesResponse,
  GameResponse,
  CreateGameResponse,
  GameTransitionResponse,
  OkResponse,
  PlayersResponse,
} from './types.js';
export { GAME_PHASES } from './types.js';

// Configuration
export {
  environmentName,
  functionName,
  tables,
  indexes,
  region,
  ddbRegion,
  cognitoConfig,
  revisionId,
  timers,
  sseConnectionLimits,
  defaultQuestionDurationSec,
  earlyRevealWhenAllAnswered,
  leaderboardTopN,
} from './config.js';

// Scoring
export type { ScoringConfig, RoundAnswerInput, RoundScoreResult } from './scoring.js';
export {
  DEFAULT_SCORING,
  applyStreak,
  streakMultiplier,
  rankPoints,
  scoreRound,
} from './scoring.js';

// DynamoDB repositories
export * from './repositories/index.js';
