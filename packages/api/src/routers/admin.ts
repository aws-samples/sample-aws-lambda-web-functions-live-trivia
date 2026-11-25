import { Router } from 'express';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  gamesRepo,
  questionSetsRepo,
  questionsRepo,
  participantsRepo,
  defaultQuestionDurationSec,
} from '@serverlessq/shared';
import { adminAuth } from '../middleware/adminAuth.ts';
import { requestLog } from '../middleware/requestLog.ts';
import { validateBody } from '../middleware/validate.ts';
import {
  createGameSchema,
  questionSetSchema,
  questionSchema,
  type CreateGameBody,
  type QuestionSetBody,
  type QuestionBody,
} from '../schemas.ts';
import { revealAndScore } from '../services/round.ts';
import { sendError } from '../http.ts';
import { reqParam } from '../params.ts';

export const adminRouter: Router = Router();

// Log admin requests before auth, so rejected (401/403) calls are logged too.
adminRouter.use(requestLog);

// Every admin route requires a valid bearer token (DD-8, FR-22).
adminRouter.use(adminAuth);

// ── Games (§5.3, DD-5/5a) ─────────────────────────────────────────────────────

adminRouter.post('/games', validateBody(createGameSchema), async (req, res) => {
  const body = req.body as CreateGameBody;
  const selection = body.selection;

  // A random draw is scoped to one question set, so the set has to exist before
  // "no questions matched" could mean anything — otherwise a typo'd id reads as
  // an empty set and the host is told their questions are missing.
  if (selection && !(await questionSetsRepo.getQuestionSet(selection.questionSetId))) {
    sendError(res, 404, 'QUESTION_SET_NOT_FOUND', 'Question set not found');
    return;
  }

  // Resolve curated ids OR a filtered-random selection → frozen snapshot (DD-5a).
  const questionIds = body.questionIds
    ? body.questionIds
    : await questionsRepo.selectQuestionIds({
        questionSetId: selection!.questionSetId,
        count: selection!.count,
        categories: selection!.categories,
        shuffle: selection!.shuffle,
      });

  if (questionIds.length === 0) {
    sendError(res, 400, 'NO_QUESTIONS', 'No questions matched the selection');
    return;
  }

  const game = await gamesRepo.createGame({
    name: body.name,
    questionIds,
    questionSetId: selection?.questionSetId,
    questionDurationSec: body.questionDurationSec ?? defaultQuestionDurationSec,
    activate: body.activate ?? true,
  });
  res.status(201).json({ gameId: game.gameId, name: game.name });
});

adminRouter.get('/games', async (_req, res) => {
  res.json({ games: await gamesRepo.listGames() });
});

adminRouter.get('/games/:gameId', async (req, res) => {
  const game = await gamesRepo.getGame(reqParam(req, 'gameId'));
  if (!game) {
    sendError(res, 404, 'GAME_NOT_FOUND', 'Game not found');
    return;
  }
  res.json({ game });
});

adminRouter.delete('/games/:gameId', async (req, res) => {
  await gamesRepo.deleteGame(reqParam(req, 'gameId'));
  res.status(204).end();
});

// Activation is additive — it does NOT deactivate any other game, so parallel
// sessions coexist. Use /deactivate to take a game off the public directory.
adminRouter.post('/games/:gameId/activate', async (req, res) => {
  await gamesRepo.setActive(reqParam(req, 'gameId'));
  res.json({ ok: true });
});

adminRouter.post('/games/:gameId/deactivate', async (req, res) => {
  await gamesRepo.setInactive(reqParam(req, 'gameId'));
  res.json({ ok: true });
});

adminRouter.post('/games/:gameId/start', async (req, res) => {
  const gameId = reqParam(req, 'gameId');
  const game = await gamesRepo.getGame(gameId);
  if (!game) {
    sendError(res, 404, 'GAME_NOT_FOUND', 'Game not found');
    return;
  }
  if (game.status !== 'LOBBY') {
    sendError(res, 409, 'BAD_PHASE', `Cannot start from ${game.status}`);
    return;
  }
  await gamesRepo.startGame(gameId);
  res.json({ status: 'IN_ROUND', questionIndex: 0 });
});

/**
 * Advance the game. Two-step per question: IN_ROUND → REVEAL (scores the round
 * exactly once) → next IN_ROUND or FINISHED. Each transition is guarded by the
 * expected phase (games.updatePhase ConditionExpression), so a double-clicked
 * "next" is idempotent and never double-scores.
 */
adminRouter.post('/games/:gameId/next', async (req, res) => {
  const gameId = reqParam(req, 'gameId');
  const game = await gamesRepo.getGame(gameId);
  if (!game) {
    sendError(res, 404, 'GAME_NOT_FOUND', 'Game not found');
    return;
  }

  try {
    if (game.status === 'IN_ROUND') {
      // Score first, publish REVEAL second — so the reveal the room sees already
      // carries final points. revealAndScore owns the exactly-once guard, which
      // keeps a double-click idempotent.
      const revealed = await revealAndScore(game, 'host');
      res.json({ status: revealed.status, questionIndex: revealed.currentIndex });
      return;
    }

    if (game.status === 'REVEAL') {
      const nextIndex = game.currentIndex + 1;
      if (nextIndex < game.questionIds.length) {
        await gamesRepo.updatePhase(
          gameId,
          { status: 'IN_ROUND', currentIndex: nextIndex, currentStartedAt: Date.now() },
          'REVEAL',
        );
        res.json({ status: 'IN_ROUND', questionIndex: nextIndex });
      } else {
        await gamesRepo.updatePhase(gameId, { status: 'FINISHED' }, 'REVEAL');
        res.json({ status: 'FINISHED', questionIndex: game.currentIndex });
      }
      return;
    }

    sendError(res, 409, 'BAD_PHASE', `Cannot advance from ${game.status}`);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Lost a concurrent transition (double-click) — return current state, no double action.
      const current = await gamesRepo.getGame(gameId);
      res.json({
        status: current?.status ?? game.status,
        questionIndex: current?.currentIndex ?? game.currentIndex,
      });
      return;
    }
    throw err;
  }
});

adminRouter.post('/games/:gameId/clear', async (req, res) => {
  await gamesRepo.clearGame(reqParam(req, 'gameId'));
  res.json({ ok: true });
});

// ── Question set CRUD (§5.3, FR-19a) ──────────────────────────────────────────

adminRouter.get('/question-sets', async (_req, res) => {
  res.json({ questionSets: await questionSetsRepo.listQuestionSets() });
});

adminRouter.post('/question-sets', validateBody(questionSetSchema), async (req, res) => {
  const set = await questionSetsRepo.createQuestionSet(req.body as QuestionSetBody);
  res.status(201).json({ questionSetId: set.questionSetId });
});

adminRouter.get('/question-sets/:questionSetId', async (req, res) => {
  const set = await questionSetsRepo.getQuestionSet(reqParam(req, 'questionSetId'));
  if (!set) {
    sendError(res, 404, 'QUESTION_SET_NOT_FOUND', 'Question set not found');
    return;
  }
  res.json({ questionSet: set });
});

adminRouter.put(
  '/question-sets/:questionSetId',
  validateBody(questionSetSchema),
  async (req, res) => {
    const updated = await questionSetsRepo.replaceQuestionSet(
      reqParam(req, 'questionSetId'),
      req.body as QuestionSetBody,
    );
    if (!updated) {
      sendError(res, 404, 'QUESTION_SET_NOT_FOUND', 'Question set not found');
      return;
    }
    res.json({ questionSet: updated });
  },
);

/**
 * Delete an EMPTY set only. Deleting a populated set would either orphan its
 * questions outside any container or silently destroy content the host still
 * wants — so the refusal is the feature. Games already created from the set are
 * unaffected regardless: their snapshot is frozen.
 */
adminRouter.delete('/question-sets/:questionSetId', async (req, res) => {
  const questionSetId = reqParam(req, 'questionSetId');
  const contents = await questionsRepo.listQuestions({ questionSetId });
  if (contents.length > 0) {
    sendError(
      res,
      409,
      'QUESTION_SET_NOT_EMPTY',
      `Question set still holds ${contents.length} question(s); delete or move them first`,
    );
    return;
  }
  await questionSetsRepo.deleteQuestionSet(questionSetId);
  res.status(204).end();
});

// ── Question pool CRUD (§5.3, FR-19) ──────────────────────────────────────────

adminRouter.get('/questions', async (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const questionSetId =
    typeof req.query.questionSetId === 'string' ? req.query.questionSetId : undefined;
  res.json({ questions: await questionsRepo.listQuestions({ questionSetId, category }) });
});

adminRouter.post('/questions', validateBody(questionSchema), async (req, res) => {
  const body = req.body as QuestionBody;
  if (!(await questionSetsRepo.getQuestionSet(body.questionSetId))) {
    sendError(res, 404, 'QUESTION_SET_NOT_FOUND', 'Question set not found');
    return;
  }
  const q = await questionsRepo.createQuestion(body);
  res.status(201).json({ questionId: q.questionId });
});

adminRouter.get('/questions/:questionId', async (req, res) => {
  const q = await questionsRepo.getQuestion(reqParam(req, 'questionId'));
  if (!q) {
    sendError(res, 404, 'QUESTION_NOT_FOUND', 'Question not found');
    return;
  }
  res.json({ question: q });
});

adminRouter.put('/questions/:questionId', validateBody(questionSchema), async (req, res) => {
  const body = req.body as QuestionBody;
  // A PUT can move a question between sets, so the destination is checked too.
  if (!(await questionSetsRepo.getQuestionSet(body.questionSetId))) {
    sendError(res, 404, 'QUESTION_SET_NOT_FOUND', 'Question set not found');
    return;
  }
  const updated = await questionsRepo.replaceQuestion(reqParam(req, 'questionId'), body);
  if (!updated) {
    sendError(res, 404, 'QUESTION_NOT_FOUND', 'Question not found');
    return;
  }
  res.json({ question: updated });
});

adminRouter.delete('/questions/:questionId', async (req, res) => {
  await questionsRepo.deleteQuestion(reqParam(req, 'questionId'));
  res.status(204).end();
});

// ── Players (admin, per game) (§5.3, FR-20/21) ────────────────────────────────

adminRouter.get('/games/:gameId/players', async (req, res) => {
  res.json({ players: await participantsRepo.listParticipants(reqParam(req, 'gameId')) });
});

adminRouter.delete('/games/:gameId/players/:playerId', async (req, res) => {
  const gameId = reqParam(req, 'gameId');
  const removed = await participantsRepo.deleteParticipant(gameId, reqParam(req, 'playerId'));
  // Only a real deletion moves the counter, so a repeated kick stays idempotent.
  if (removed) await gamesRepo.bumpParticipantCount(gameId, -1);
  res.status(204).end();
});
