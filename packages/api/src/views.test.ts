import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as Shared from '@serverlessq/shared';
import type { Game } from '@serverlessq/shared';

// resolvePublicGameState reaches for the question pool at REVEAL/IN_ROUND; the
// lobby assertions below must not depend on DynamoDB.
const getQuestion = vi.hoisted(() => vi.fn());
vi.mock('@serverlessq/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof Shared>()),
  questionsRepo: { getQuestion },
}));

const { resolvePublicGameState } = await import('./views.ts');

function game(overrides: Partial<Game> = {}): Game {
  return {
    gameId: 'g1',
    status: 'LOBBY',
    questionIds: ['q1', 'q2', 'q3'],
    currentIndex: 0,
    questionDurationSec: 20,
    createdAt: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  getQuestion.mockReset();
});

describe('resolvePublicGameState — lobby join counter', () => {
  it('includes the game name in the state used by the join screens', async () => {
    const state = await resolvePublicGameState(game({ name: 'Sunny Otter 4821' }));

    expect(state.name).toBe('Sunny Otter 4821');
    expect(getQuestion).not.toHaveBeenCalled();
  });

  it('keeps legacy games without names readable', async () => {
    const state = await resolvePublicGameState(game());

    expect(state.gameId).toBe('g1');
    expect(state).not.toHaveProperty('name');
  });

  it('surfaces the game item counter as playerCount alongside the question total', async () => {
    const state = await resolvePublicGameState(game({ participantCount: 42 }));

    expect(state).toMatchObject({
      status: 'LOBBY',
      playerCount: 42,
      questionCount: 3,
      // Carried even in the lobby: the projector sizes its countdown ring before
      // the first round opens.
      questionDurationSec: 20,
    });
    // The lobby read path must stay a single game-item read — no per-tick COUNT query.
    expect(getQuestion).not.toHaveBeenCalled();
  });

  it('reports 0 for a game created before the counter existed', async () => {
    const state = await resolvePublicGameState(game());

    expect(state.playerCount).toBe(0);
  });

  it('keeps the count flowing once the game leaves the lobby', async () => {
    getQuestion.mockResolvedValue({
      questionId: 'q1',
      text: 'Which runtime?',
      choices: ['Node.js 22', 'Node.js 24'],
      correctChoice: 'Node.js 24',
      createdAt: 1,
    });

    const state = await resolvePublicGameState(
      game({ status: 'IN_ROUND', participantCount: 7, currentStartedAt: 5_000 }),
    );

    expect(state).toMatchObject({ playerCount: 7, questionCount: 3, endsAt: 25_000 });
    // Still withheld while the round is open (US-B3).
    expect(state.correctChoice).toBeUndefined();
  });

  it('does not leak the answer into the lobby payload at REVEAL, but keeps the count', async () => {
    getQuestion.mockResolvedValue({
      questionId: 'q1',
      text: 'Which runtime?',
      choices: ['Node.js 22', 'Node.js 24'],
      correctChoice: 'Node.js 24',
      createdAt: 1,
    });

    const state = await resolvePublicGameState(
      game({ status: 'REVEAL', participantCount: 9, currentStartedAt: 5_000 }),
    );

    expect(state.playerCount).toBe(9);
    expect(state.correctChoice).toBe('Node.js 24');
    // endsAt is an IN_ROUND-only field — a revealed round has no live countdown.
    expect(state.endsAt).toBeUndefined();
  });
});
