import type {
  ActiveGamesResponse,
  ApiErrorBody,
  CreateGameRequest,
  CreateGameResponse,
  CreateQuestionResponse,
  CreateQuestionSetResponse,
  GameTransitionResponse,
  GamesResponse,
  JoinPlayerRequest,
  JoinPlayerResponse,
  LeaderboardSnapshot,
  OkResponse,
  PlayerStatusResponse,
  PlayersResponse,
  PublicGameState,
  QuestionInput,
  QuestionResponse,
  QuestionsResponse,
  QuestionSetInput,
  QuestionSetResponse,
  QuestionSetsResponse,
  SubmitAnswerRequest,
  SubmitAnswerResponse,
} from '@serverlessq/shared';

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(endpoint(baseUrl, path), { ...init, headers });
  if (response.status === 204) return undefined as T;

  const body = (await response.json().catch(() => undefined)) as T | ApiErrorBody | undefined;
  if (!response.ok) {
    const error = body as ApiErrorBody | undefined;
    throw new ApiClientError(
      error?.error.message ?? `Request failed with status ${response.status}`,
      response.status,
      error?.error.code ?? 'HTTP_ERROR',
    );
  }
  return body as T;
}

const gamePath = (gameId: string) => `/api/games/${encodeURIComponent(gameId)}`;
const adminGamePath = (gameId: string) => `/api/admin/games/${encodeURIComponent(gameId)}`;

/** Public game directory — every active game, newest first. */
export const getActiveGames = (baseUrl: string, signal?: AbortSignal) =>
  requestJson<ActiveGamesResponse>(baseUrl, '/api/games/active', { signal });

export const getGameState = (baseUrl: string, gameId: string, signal?: AbortSignal) =>
  requestJson<PublicGameState>(baseUrl, gamePath(gameId), { signal });

export const joinGame = (baseUrl: string, gameId: string, body: JoinPlayerRequest) =>
  requestJson<JoinPlayerResponse>(baseUrl, `${gamePath(gameId)}/players`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const getPlayerStatus = (
  baseUrl: string,
  gameId: string,
  playerId: string,
  signal?: AbortSignal,
) =>
  requestJson<PlayerStatusResponse>(
    baseUrl,
    `${gamePath(gameId)}/players/${encodeURIComponent(playerId)}`,
    { signal },
  );

export const submitAnswer = (
  baseUrl: string,
  gameId: string,
  questionId: string,
  body: SubmitAnswerRequest,
) =>
  requestJson<SubmitAnswerResponse>(
    baseUrl,
    `${gamePath(gameId)}/questions/${encodeURIComponent(questionId)}/answers`,
    { method: 'POST', body: JSON.stringify(body) },
  );

export const getLeaderboard = (baseUrl: string, gameId: string, signal?: AbortSignal) =>
  requestJson<LeaderboardSnapshot>(baseUrl, `${gamePath(gameId)}/leaderboard`, { signal });

export const leaderboardStreamUrl = (baseUrl: string, gameId: string) =>
  endpoint(baseUrl, `${gamePath(gameId)}/leaderboard/stream`);

const questionSetPath = (questionSetId: string) =>
  `/api/admin/question-sets/${encodeURIComponent(questionSetId)}`;

export const listQuestionSets = (baseUrl: string, token: string, signal?: AbortSignal) =>
  requestJson<QuestionSetsResponse>(baseUrl, '/api/admin/question-sets', { signal }, token);

export const createQuestionSet = (baseUrl: string, token: string, body: QuestionSetInput) =>
  requestJson<CreateQuestionSetResponse>(
    baseUrl,
    '/api/admin/question-sets',
    { method: 'POST', body: JSON.stringify(body) },
    token,
  );

export const updateQuestionSet = (
  baseUrl: string,
  token: string,
  questionSetId: string,
  body: QuestionSetInput,
) =>
  requestJson<QuestionSetResponse>(
    baseUrl,
    questionSetPath(questionSetId),
    { method: 'PUT', body: JSON.stringify(body) },
    token,
  );

/** Rejected with 409 `QUESTION_SET_NOT_EMPTY` while the set still holds questions. */
export const deleteQuestionSet = (baseUrl: string, token: string, questionSetId: string) =>
  requestJson<void>(baseUrl, questionSetPath(questionSetId), { method: 'DELETE' }, token);

/** The pool, scoped to one set when `questionSetId` is given. */
export const listQuestions = (
  baseUrl: string,
  token: string,
  questionSetId?: string,
  signal?: AbortSignal,
) =>
  requestJson<QuestionsResponse>(
    baseUrl,
    questionSetId
      ? `/api/admin/questions?questionSetId=${encodeURIComponent(questionSetId)}`
      : '/api/admin/questions',
    { signal },
    token,
  );

export const createQuestion = (baseUrl: string, token: string, body: QuestionInput) =>
  requestJson<CreateQuestionResponse>(
    baseUrl,
    '/api/admin/questions',
    { method: 'POST', body: JSON.stringify(body) },
    token,
  );

export const updateQuestion = (
  baseUrl: string,
  token: string,
  questionId: string,
  body: QuestionInput,
) =>
  requestJson<QuestionResponse>(
    baseUrl,
    `/api/admin/questions/${encodeURIComponent(questionId)}`,
    { method: 'PUT', body: JSON.stringify(body) },
    token,
  );

export const deleteQuestion = (baseUrl: string, token: string, questionId: string) =>
  requestJson<void>(
    baseUrl,
    `/api/admin/questions/${encodeURIComponent(questionId)}`,
    { method: 'DELETE' },
    token,
  );

export const listGames = (baseUrl: string, token: string, signal?: AbortSignal) =>
  requestJson<GamesResponse>(baseUrl, '/api/admin/games', { signal }, token);

export const createGame = (baseUrl: string, token: string, body: CreateGameRequest) =>
  requestJson<CreateGameResponse>(
    baseUrl,
    '/api/admin/games',
    { method: 'POST', body: JSON.stringify(body) },
    token,
  );

/**
 * `activate` is additive — it lists the game on the public directory without
 * deactivating any other, so parallel sessions coexist. `deactivate` removes it
 * from the directory but keeps all its data.
 */
export const runGameAction = (
  baseUrl: string,
  token: string,
  gameId: string,
  action: 'start' | 'next' | 'activate' | 'deactivate',
) =>
  requestJson<GameTransitionResponse>(
    baseUrl,
    `${adminGamePath(gameId)}/${action}`,
    { method: 'POST' },
    token,
  );

export const clearGame = (baseUrl: string, token: string, gameId: string) =>
  requestJson<OkResponse>(baseUrl, `${adminGamePath(gameId)}/clear`, { method: 'POST' }, token);

export const listPlayers = (baseUrl: string, token: string, gameId: string, signal?: AbortSignal) =>
  requestJson<PlayersResponse>(baseUrl, `${adminGamePath(gameId)}/players`, { signal }, token);

export const kickPlayer = (baseUrl: string, token: string, gameId: string, playerId: string) =>
  requestJson<void>(
    baseUrl,
    `${adminGamePath(gameId)}/players/${encodeURIComponent(playerId)}`,
    { method: 'DELETE' },
    token,
  );
