/**
 * Repository integration tests. Runs only against explicitly prefixed regional
 * tables to isolate integration-test data:
 *
 *   SERVERLESSQ_TABLE_PREFIX=dev- npm run test:integration
 *
 * Skips entirely if SERVERLESSQ_TABLE_PREFIX is unset — this guard means the
 * suite never touches unprefixed tables. AWS credentials are also required.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as questionSets from './questionSets.js';
import * as questions from './questions.js';
import * as games from './games.js';
import * as participants from './participants.js';
import * as answers from './answers.js';
import * as scores from './scores.js';
import { scoreRound, type RoundAnswerInput } from '../scoring.js';

const RUN = Boolean(process.env.SERVERLESSQ_TABLE_PREFIX);

describe.skipIf(!RUN)('repositories (integration, dev table)', () => {
  const createdGameIds: string[] = [];
  const createdQuestionIds: string[] = [];
  const createdQuestionSetIds: string[] = [];

  afterAll(async () => {
    for (const id of createdGameIds) await games.deleteGame(id);
    for (const id of createdQuestionIds) await questions.deleteQuestion(id);
    for (const id of createdQuestionSetIds) await questionSets.deleteQuestionSet(id);
  });

  it('scopes the pool and a random draw to one question set', async () => {
    const [setA, setB] = await Promise.all([
      questionSets.createQuestionSet({ name: `integration set A ${Date.now()}` }),
      questionSets.createQuestionSet({ name: `integration set B ${Date.now()}` }),
    ]);
    createdQuestionSetIds.push(setA.questionSetId, setB.questionSetId);

    const [inA, inB] = await Promise.all([
      questions.createQuestion({
        questionSetId: setA.questionSetId,
        text: `set A q ${Date.now()}`,
        choices: ['A', 'B'],
        correctChoice: 'A',
      }),
      questions.createQuestion({
        questionSetId: setB.questionSetId,
        text: `set B q ${Date.now()}`,
        choices: ['A', 'B'],
        correctChoice: 'B',
      }),
    ]);
    createdQuestionIds.push(inA.questionId, inB.questionId);

    // The pool read is per set — B's question must not surface under A.
    const poolA = await questions.listQuestions({ questionSetId: setA.questionSetId });
    expect(poolA.map((q) => q.questionId)).toEqual([inA.questionId]);

    // A random draw for a game is likewise confined to the set it names, even
    // when it asks for more questions than the set holds.
    const drawn = await questions.selectQuestionIds({
      questionSetId: setA.questionSetId,
      count: 10,
    });
    expect(drawn).toEqual([inA.questionId]);

    // The set exists, so a name lookup finds it (the seed script's idempotency).
    const found = await questionSets.findQuestionSetByName(setA.name);
    expect(found?.questionSetId).toBe(setA.questionSetId);
  });

  it('runs the full join → answer → score → leaderboard path', async () => {
    // Question set + question + game snapshot
    const set = await questionSets.createQuestionSet({
      name: `integration set ${Date.now()}`,
      description: 'Created by the repository integration suite.',
    });
    createdQuestionSetIds.push(set.questionSetId);

    const q = await questions.createQuestion({
      questionSetId: set.questionSetId,
      text: `integration q ${Date.now()}`,
      choices: ['A', 'B', 'C'],
      correctChoice: 'A',
      category: 'Test',
    });
    createdQuestionIds.push(q.questionId);

    const game = await games.createGame({
      questionIds: [q.questionId],
      questionSetId: set.questionSetId,
      questionDurationSec: 20,
      activate: true,
    });
    // The game records where its snapshot came from, for display/traceability.
    expect(game.questionSetId).toBe(set.questionSetId);
    createdGameIds.push(game.gameId);

    // The public directory lists it. Activation is additive, so this asserts
    // membership rather than exclusivity — other concurrent games may be listed too.
    const active = await games.listActiveGames();
    expect(active.map((g) => g.gameId)).toContain(game.gameId);

    await games.startGame(game.gameId);

    // Three players join
    const [p1, p2, p3] = await Promise.all([
      participants.createParticipant(game.gameId, 'Alice'),
      participants.createParticipant(game.gameId, 'Bob'),
      participants.createParticipant(game.gameId, 'Cara'),
    ]);
    await Promise.all([
      scores.ensureScore(game.gameId, p1.playerId, p1.name),
      scores.ensureScore(game.gameId, p2.playerId, p2.name),
      scores.ensureScore(game.gameId, p3.playerId, p3.name),
    ]);
    expect((await participants.listParticipants(game.gameId)).length).toBe(3);

    // Answers: p1 fastest correct, p2 slower correct, p3 wrong
    const t0 = Date.now();
    const first = await answers.submitAnswer({
      gameId: game.gameId,
      questionIndex: 0,
      questionId: q.questionId,
      playerId: p1.playerId,
      choice: 'A',
      correct: true,
      submittedAt: t0,
    });
    expect(first.accepted).toBe(true);

    // Idempotency: second submission for same round is rejected
    const dup = await answers.submitAnswer({
      gameId: game.gameId,
      questionIndex: 0,
      questionId: q.questionId,
      playerId: p1.playerId,
      choice: 'B',
      correct: false,
      submittedAt: t0 + 5,
    });
    expect(dup.accepted).toBe(false);

    await answers.submitAnswer({
      gameId: game.gameId,
      questionIndex: 0,
      questionId: q.questionId,
      playerId: p2.playerId,
      choice: 'A',
      correct: true,
      submittedAt: t0 + 100,
    });
    await answers.submitAnswer({
      gameId: game.gameId,
      questionIndex: 0,
      questionId: q.questionId,
      playerId: p3.playerId,
      choice: 'C',
      correct: false,
      submittedAt: t0 + 50,
    });

    // Round close: score from persisted answers
    const roundAnswers = await answers.listRoundAnswers(game.gameId, 0);
    expect(roundAnswers.length).toBe(3);

    const inputs: RoundAnswerInput[] = roundAnswers.map((a) => ({
      playerId: a.playerId,
      correct: a.correct,
      submittedAt: a.submittedAt,
      prevStreak: 0,
    }));
    const nameById = new Map([
      [p1.playerId, p1.name],
      [p2.playerId, p2.name],
      [p3.playerId, p3.name],
    ]);
    for (const r of scoreRound(inputs)) {
      await scores.applyRoundResult({
        gameId: game.gameId,
        playerId: r.playerId,
        name: nameById.get(r.playerId)!,
        pointsDelta: r.awardedPoints,
        correct: r.rank !== undefined,
        newStreak: r.newStreak,
        longestStreak: r.newStreak,
        lastCorrectAt: r.rank !== undefined ? Date.now() : undefined,
      });
    }

    // Leaderboard: p1 (fastest correct) leads, p3 (wrong) last with 0
    const board = await scores.getLeaderboard(game.gameId, 10);
    expect(board[0]?.name).toBe(p1.name);
    expect(board[0]!.points).toBeGreaterThan(board[1]!.points);
    const cara = board.find((e) => e.name === p3.name);
    expect(cara?.points).toBe(0);
  });
});
