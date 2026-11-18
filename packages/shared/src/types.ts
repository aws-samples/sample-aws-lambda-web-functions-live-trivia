/**
 * ServerlessQ domain types: persisted DynamoDB item shapes and the DTOs the API
 * returns to clients.
 */

// ── Game lifecycle ─────────────────────────────────────────────────────────

/** Game lifecycle phases (design §4 GAMES.status). */
export type GamePhase = 'LOBBY' | 'IN_ROUND' | 'REVEAL' | 'FINISHED';

export const GAME_PHASES = [
  'LOBBY',
  'IN_ROUND',
  'REVEAL',
  'FINISHED',
] as const satisfies readonly GamePhase[];

/** Participant lifecycle (design §4 PARTICIPANTS.state). */
export type ParticipantState = 'ACTIVE' | 'KICKED';

// ── Persisted entities (DynamoDB item shapes) ──────────────────────────────

/**
 * QUESTION_SETS table item — a named container for questions.
 *
 * The pool is no longer one flat bucket: every question belongs to exactly one
 * set, and a game draws its snapshot from exactly one set. That is what lets a
 * general knowledge, AWS, and practice question sets coexist in the same
 * tables without a game accidentally pulling a question from the wrong deck.
 */
export interface QuestionSet {
  questionSetId: string;
  name: string;
  description?: string;
  createdAt: number;
}

/** QUESTIONS table item — the reusable question pool (admin-owned). */
export interface Question {
  questionId: string;
  /** Owning set — every question belongs to exactly one (resolved via set-index). */
  questionSetId: string;
  text: string;
  /** 2..N answer choices. */
  choices: string[];
  /** Must be one of `choices`. */
  correctChoice: string;
  category?: string;
  tags?: string[];
  createdAt: number;
}

/**
 * GAMES table item. `active` holds 'Y' on exactly one game (resolved via the
 * active-index GSI). `questionIds` is the frozen ordered snapshot taken at
 * create time (DD-5a) so pool edits never mutate an in-flight game.
 */
export interface Game {
  gameId: string;
  /** Display name; absent on games created before naming was introduced. */
  name?: string;
  status: GamePhase;
  /** 'Y' on the single active game; absent otherwise (sparse GSI key). */
  active?: 'Y';
  /**
   * The question set the snapshot was drawn from. Recorded for display and
   * traceability only — the snapshot itself is already frozen, so renaming or
   * deleting the set never changes what an in-flight game asks. Absent on games
   * created before question sets existed.
   */
  questionSetId?: string;
  questionIds: string[];
  /** Index into `questionIds` of the current/last round. */
  currentIndex: number;
  /** Epoch ms the current round opened; unset in LOBBY. */
  currentStartedAt?: number;
  questionDurationSec: number;
  createdAt: number;
  /**
   * Live count of joined participants. Maintained atomically (ADD) on join and
   * kick so the lobby/host join counter costs no extra read — the game item is
   * already fetched on every state read and SSE tick. Absent on games created
   * before the counter existed; `setActive` reconciles it from a COUNT query.
   */
  participantCount?: number;
  /**
   * How many answers the round at `currentIndex` has accepted. Maintained
   * atomically (ADD) by the answer path and reset to 0 whenever a round opens,
   * so "has everyone locked in?" is answerable from the game item alone — no
   * per-tick COUNT over the answers table. Compared against
   * `participantCount`; see `isRoundFullyAnswered`.
   */
  roundAnswerCount?: number;
  /**
   * Index of the round whose scoring has been claimed. Set by a conditional
   * write that serves as both the exactly-once scoring mutex and the gate that
   * closes the round to new answers — so scoring can finish BEFORE the phase
   * flips to REVEAL, and the leaderboard published alongside that reveal is
   * already final. Absent until the first round is closed.
   */
  scoredIndex?: number;
}

/** PARTICIPANTS table item — composite key (gameId, playerId). */
export interface Participant {
  gameId: string;
  playerId: string;
  name: string;
  state: ParticipantState;
  joinedAt: number;
  lastSeenAt: number;
}

/**
 * ANSWERS table item — composite key (gameId, sk) where
 * sk = `Q#<index>#P#<playerId>`. Idempotent via attribute_not_exists(sk).
 */
export interface Answer {
  gameId: string;
  /** `Q#<index>#P#<playerId>` */
  sk: string;
  questionId: string;
  playerId: string;
  choice: string;
  correct: boolean;
  /** Server-received epoch ms — the fairness anchor for speed scoring. */
  submittedAt: number;
  /** ms since the round opened; populated when the game start time is known. */
  latencyMs?: number;
  /** Points awarded once the round is scored. */
  awardedPoints?: number;
}

/** SCORES table item — composite key (gameId, playerId). Leaderboard source. */
export interface Score {
  gameId: string;
  playerId: string;
  name: string;
  cumulativePoints: number;
  correctCount: number;
  currentStreak: number;
  longestStreak: number;
  lastCorrectAt?: number;
}

// ── DTOs (API responses) ────────────────────────────────────────────────────

/** Public game state (design §5.2 GET /api/games/:gameId). `correctChoice` withheld while a round is open. */
export interface PublicGameState {
  gameId: string;
  /** Display name; absent on games created before naming was introduced. */
  name?: string;
  status: GamePhase;
  questionIndex: number;
  /** How many players have joined — drives the lobby and host-screen join counter. */
  playerCount: number;
  /** Total questions in the frozen snapshot, so the lobby can preview game length. */
  questionCount: number;
  /**
   * Seconds each round runs. Per-game, so the countdown dials on the player and
   * projector screens can size their ring against the real round length instead
   * of a hardcoded guess. Presentation only — `endsAt` is the authority.
   */
  questionDurationSec: number;
  question?: {
    questionId: string;
    text: string;
    choices: string[];
  };
  /** Epoch ms the current round closes (currentStartedAt + duration). Present only while IN_ROUND. */
  endsAt?: number;
  /** Revealed answer — present only at REVEAL/FINISHED (withheld while the round is open, US-B3). */
  correctChoice?: string;
}

/** One row of the live leaderboard. */
export interface LeaderboardEntry {
  name: string;
  points: number;
  streak: number;
}

/** Leaderboard snapshot (long-poll body and SSE `leaderboard` frame payload). */
export interface LeaderboardSnapshot {
  topN: LeaderboardEntry[];
  updatedAt: number;
}

/** Health payload for verifying the serving region and application revision. */
export interface HealthResponse {
  region: string;
  revision: string;
  status: 'ok';
}

/** Structured API error envelope: `{ error: { code, message } }`. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
// ── HTTP API contracts (browser/client-facing) ─────────────────────────────

/**
 * One row of the public game directory (`GET /api/games/active`). Enough to
 * render and rank the list without a follow-up read per game.
 */
export interface ActiveGameSummary {
  gameId: string;
  name?: string;
  status: GamePhase;
  playerCount: number;
  questionCount: number;
  createdAt: number;
  /** False once the game has ended — the directory still lists it, greyed out. */
  joinable: boolean;
}

/** Public game directory. Plural: parallel sessions are supported by design. */
export interface ActiveGamesResponse {
  games: ActiveGameSummary[];
}

export interface JoinPlayerRequest {
  name: string;
}

export interface JoinPlayerResponse {
  gameId: string;
  playerId: string;
  name: string;
}

export interface PlayerStatusResponse {
  playerId: string;
  name: string;
  state: ParticipantState;
  points: number;
  streak: number;
}

export interface SubmitAnswerRequest {
  playerId: string;
  choice: string;
}

export interface SubmitAnswerResponse {
  accepted: true;
}

export interface QuestionSetInput {
  name: string;
  description?: string;
}

export interface QuestionSetsResponse {
  questionSets: QuestionSet[];
}

export interface QuestionSetResponse {
  questionSet: QuestionSet;
}

export interface CreateQuestionSetResponse {
  questionSetId: string;
}

export interface QuestionInput {
  questionSetId: string;
  text: string;
  choices: string[];
  correctChoice: string;
  category?: string;
  tags?: string[];
}

export interface QuestionsResponse {
  questions: Question[];
}

export interface QuestionResponse {
  question: Question;
}

export interface CreateQuestionResponse {
  questionId: string;
}

/** Random draw for a new game — always scoped to one question set (FR-19a). */
export interface QuestionSelection {
  questionSetId: string;
  count: number;
  categories?: string[];
  shuffle?: boolean;
}

type CreateGameOptions = {
  /** Blank or omitted names receive a generated workplace-safe name. */
  name?: string;
  questionDurationSec?: number;
  activate?: boolean;
};

export type CreateGameRequest = CreateGameOptions &
  (
    | { questionIds: string[]; selection?: never }
    | { selection: QuestionSelection; questionIds?: never }
  );

export interface GamesResponse {
  games: Game[];
}

export interface GameResponse {
  game: Game;
}

export interface CreateGameResponse {
  gameId: string;
  name: string;
}

export interface GameTransitionResponse {
  status: GamePhase;
  questionIndex: number;
}

export interface OkResponse {
  ok: true;
}

export interface PlayersResponse {
  players: Participant[];
}
