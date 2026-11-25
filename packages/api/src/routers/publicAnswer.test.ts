import express from 'express';
import type { RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Shared from '@serverlessq/shared';
import type * as Round from '../services/round.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const getGame = vi.hoisted(() => vi.fn());
const getParticipant = vi.hoisted(() => vi.fn());
const getQuestion = vi.hoisted(() => vi.fn());
const submitAnswer = vi.hoisted(() => vi.fn());
const tallyAnswerAndSettle = vi.hoisted(() => vi.fn());

vi.mock('@serverlessq/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
  return {
    ...actual,
    gamesRepo: { ...actual.gamesRepo, getGame },
    participantsRepo: { ...actual.participantsRepo, getParticipant },
    questionsRepo: { ...actual.questionsRepo, getQuestion },
    answersRepo: { ...actual.answersRepo, submitAnswer },
  };
});
vi.mock('../middleware/requestLog.ts', () => ({
  requestLog: ((_req, _res, next) => next()) satisfies RequestHandler,
}));
vi.mock('../services/round.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Round>();
  return {
    ...actual,
    isRoundExpired: () => false,
    tallyAnswerAndSettle,
  };
});

const { publicRouter } = await import('./public.ts');
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(publicRouter);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1');
    server.once('listening', resolve);
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  getGame.mockReset().mockResolvedValue({
    gameId: 'g1',
    status: 'IN_ROUND',
    questionIds: ['q1'],
    currentIndex: 0,
    questionDurationSec: 20,
    currentStartedAt: Date.now(),
    createdAt: 1,
  });
  getParticipant.mockReset().mockResolvedValue({
    gameId: 'g1',
    playerId: 'p1',
    name: 'Ada',
    state: 'ACTIVE',
    joinedAt: 1,
  });
  getQuestion.mockReset().mockResolvedValue({
    questionId: 'q1',
    questionSetId: 'set1',
    text: 'Pick one',
    choices: ['A', 'B'],
    correctChoice: 'A',
    createdAt: 1,
  });
  submitAnswer.mockReset().mockResolvedValue({ accepted: true });
  tallyAnswerAndSettle.mockReset().mockResolvedValue(undefined);
});

describe('public answer integrity', () => {
  it('rejects a choice that is not one of the current question choices', async () => {
    const response = await fetch(`${baseUrl}/api/games/g1/questions/q1/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'p1', choice: 'injected-choice' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'INVALID_CHOICE', message: 'Choice is not valid for this question' },
    });
    expect(submitAnswer).not.toHaveBeenCalled();
    expect(tallyAnswerAndSettle).not.toHaveBeenCalled();
  });
});
