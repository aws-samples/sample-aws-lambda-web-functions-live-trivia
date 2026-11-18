import { Router } from 'express';
import {
  gamesRepo,
  participantsRepo,
  answersRepo,
  scoresRepo,
  questionsRepo,
  leaderboardTopN,
  type ActiveGamesResponse,
  type LeaderboardSnapshot,
} from '@serverlessq/shared';
import { validateBody } from '../middleware/validate.ts';
import { requestLog } from '../middleware/requestLog.ts';
import { joinSchema, answerSchema, type JoinBody, type AnswerBody } from '../schemas.ts';
import { validateName } from '../util/names.ts';
import { resolvePublicGameState } from '../views.ts';
import { settleRound, isRoundExpired, tallyAnswerAndSettle } from '../services/round.ts';
import { addConnection, removeConnection } from '../sse.ts';
import { emitMetric } from '../metrics.ts';
import { sendError } from '../http.ts';
import { reqParam } from '../params.ts';

export const publicRouter: Router = Router();

// Structured request logging + RequestLatencyMs for every public route.
publicRouter.use(requestLog);

// ── Join & identity (§5, FR-2/3/4) ───────────────────────────────────────────

publicRouter.post('/api/games/:gameId/players', validateBody(joinSchema), async (req, res) => {
  const gameId = reqParam(req, 'gameId');
  const check = validateName((req.body as JoinBody).name);
  if (!check.ok) {
    sendError(res, 400, check.code, check.message);
    return;
  }
  const game = await gamesRepo.getGame(gameId);
  if (!game) {
    sendError(res, 404, 'GAME_NOT_FOUND', 'Game not found');
    return;
  }
  if (game.status === 'FINISHED') {
    sendError(res, 409, 'GAME_NOT_JOINABLE', 'This game has ended');
    return;
  }
  const participant = await participantsRepo.createParticipant(gameId, check.name);
  await Promise.all([
    scoresRepo.ensureScore(gameId, participant.playerId, participant.name),
    // Keeps the lobby/host join counter live without a per-tick COUNT query.
    gamesRepo.bumpParticipantCount(gameId, 1),
  ]);
  emitMetric('PlayersJoined', 1);
  res.status(201).json({ gameId, playerId: participant.playerId, name: participant.name });
});

publicRouter.get('/api/games/:gameId/players/:playerId', async (req, res) => {
  const gameId = reqParam(req, 'gameId');
  const playerId = reqParam(req, 'playerId');
  const [participant, score] = await Promise.all([
    participantsRepo.getParticipant(gameId, playerId),
    scoresRepo.getScore(gameId, playerId),
  ]);
  if (!participant) {
    sendError(res, 404, 'PLAYER_NOT_FOUND', 'Player not found');
    return;
  }
  res.json({
    playerId: participant.playerId,
    name: participant.name,
    state: participant.state,
    points: score?.cumulativePoints ?? 0,
    streak: score?.currentStreak ?? 0,
  });
});

// ── Game discovery & state (§5) ───────────────────────────────────────────────

/**
 * Public game directory. Returns EVERY active game, because parallel sessions are
 * a supported mode — there is no "the" active game to resolve. Newest first, so
 * the session a host just created is at the top of the list.
 *
 * Counts come straight off each game item, so this is one GSI query total rather
 * than a fan-out of per-game reads.
 */
publicRouter.get('/api/games/active', async (_req, res) => {
  const games = await gamesRepo.listActiveGames();
  const body: ActiveGamesResponse = {
    games: games
      .map((game) => ({
        gameId: game.gameId,
        ...(game.name ? { name: game.name } : {}),
        status: game.status,
        playerCount: game.participantCount ?? 0,
        questionCount: game.questionIds.length,
        createdAt: game.createdAt,
        joinable: game.status !== 'FINISHED',
      }))
      .sort((a, b) => b.createdAt - a.createdAt),
  };
  res.json(body);
});

publicRouter.get('/api/games/:gameId', async (req, res) => {
  const game = await gamesRepo.getGame(reqParam(req, 'gameId'));
  if (!game) {
    sendError(res, 404, 'GAME_NOT_FOUND', 'Game not found');
    return;
  }
  // Settle a finished round before answering, so a reader never sees a round that
  // is open on paper but over by the clock or already fully answered (FR-8).
  res.json(await resolvePublicGameState(await settleRound(game)));
});

// ── Answers (§6, FR-10/11) ────────────────────────────────────────────────────

publicRouter.post(
  '/api/games/:gameId/questions/:questionId/answers',
  validateBody(answerSchema),
  async (req, res) => {
    const gameId = reqParam(req, 'gameId');
    const questionId = reqParam(req, 'questionId');
    const { playerId, choice } = req.body as AnswerBody;

    const game = await gamesRepo.getGame(gameId);
    if (!game) {
      sendError(res, 404, 'GAME_NOT_FOUND', 'Game not found');
      return;
    }
    // Only the currently open round accepts answers. The countdown is enforced
    // here, on the server clock — the SPA also hides the button once the timer
    // hits zero, but that is presentation, not a guarantee (FR-8/FR-11).
    // `scoredIndex` closes the round the instant scoring is claimed, which the
    // phase alone no longer does: the flip to REVEAL now happens AFTER scoring,
    // so on an early host reveal the game is still IN_ROUND and not yet expired
    // while points are being written. Without this check an answer could land
    // after the round's answers were read and never be counted.
    if (
      game.status !== 'IN_ROUND' ||
      game.questionIds[game.currentIndex] !== questionId ||
      game.scoredIndex === game.currentIndex ||
      isRoundExpired(game)
    ) {
      sendError(res, 409, 'ROUND_CLOSED', 'This question is not open for answers');
      return;
    }
    const participant = await participantsRepo.getParticipant(gameId, playerId);
    if (!participant || participant.state !== 'ACTIVE') {
      sendError(res, 404, 'PLAYER_NOT_FOUND', 'Player not found');
      return;
    }
    const question = await questionsRepo.getQuestion(questionId);
    if (!question) {
      sendError(res, 404, 'QUESTION_NOT_FOUND', 'Question not found');
      return;
    }
    if (!question.choices.includes(choice)) {
      sendError(res, 400, 'INVALID_CHOICE', 'Choice is not valid for this question');
      return;
    }

    const submittedAt = Date.now();
    const correct = choice === question.correctChoice;
    const latencyMs = game.currentStartedAt ? submittedAt - game.currentStartedAt : undefined;

    const { accepted } = await answersRepo.submitAnswer({
      gameId,
      questionIndex: game.currentIndex,
      questionId,
      playerId,
      choice,
      correct,
      submittedAt,
      latencyMs,
    });
    if (!accepted) {
      sendError(res, 409, 'ALREADY_ANSWERED', 'You have already answered this question');
      return;
    }

    emitMetric('AnswersSubmitted', 1);
    if (latencyMs !== undefined) emitMetric('AnswerLatencyMs', latencyMs, 'Milliseconds');

    // An answer can be the thing that ends the round: once everyone who has joined
    // is locked in, the remaining countdown is dead air (FR-8). Costs one atomic
    // tally write on this path and no reads.
    //
    // Awaited rather than backgrounded, because a Web Function execution environment
    // can be frozen the moment the response is flushed — work left dangling after
    // `res` may simply never run. Only the LAST answerer of a round pays for the
    // reveal, and if this request dies mid-reveal the SSE tick settles the round
    // instead.
    await tallyAnswerAndSettle(gameId, game.currentIndex);

    res.status(202).json({ accepted: true });
  },
);

// ── Leaderboard: long-poll fallback (§7, D4/FR-16) ────────────────────────────

publicRouter.get('/api/games/:gameId/leaderboard', async (req, res) => {
  const topN = await scoresRepo.getLeaderboard(reqParam(req, 'gameId'), leaderboardTopN);
  const body: LeaderboardSnapshot = { topN, updatedAt: Date.now() };
  res.json(body);
});

// ── Leaderboard: SSE stream (§7, DD-3) ────────────────────────────────────────

publicRouter.get('/api/games/:gameId/leaderboard/stream', async (req, res) => {
  const gameId = reqParam(req, 'gameId');

  const game = await gamesRepo.getGame(gameId);
  if (!game) {
    sendError(res, 404, 'GAME_NOT_FOUND', 'Game not found');
    return;
  }

  // Reserve capacity before committing SSE headers so an overloaded environment
  // can return a normal bounded error response.
  if (!addConnection(gameId, res)) {
    sendError(res, 429, 'STREAM_LIMIT', 'Too many live streams for this game');
    return;
  }

  // Server-Sent Events is a long-lived HTTP response we keep writing frames to.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  // When the browser goes away, leave the poller.
  req.on('close', () => removeConnection(gameId, res));
});
