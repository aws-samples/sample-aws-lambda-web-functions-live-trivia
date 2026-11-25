import type * as Shared from '@serverlessq/shared';
import type { Game } from '@serverlessq/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RoundClosed is emitted once per successful scoring claim, tagged with what
 * triggered the close. The claim (claimRoundScoring) is the mutex, so a lost
 * race must NOT emit. DynamoDB is fully mocked; the metric sink is mocked so the
 * Trigger dimension can be asserted directly.
 */
const claimRoundScoring = vi.hoisted(() => vi.fn());
const updatePhase = vi.hoisted(() => vi.fn());
const getGame = vi.hoisted(() => vi.fn());
const recordRoundAnswer = vi.hoisted(() => vi.fn());
const applyRoundResult = vi.hoisted(() => vi.fn());
const listParticipants = vi.hoisted(() => vi.fn());
const listRoundAnswers = vi.hoisted(() => vi.fn());
const listScores = vi.hoisted(() => vi.fn());
const emitMetric = vi.hoisted(() => vi.fn());

vi.mock('@serverlessq/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof Shared>()),
  gamesRepo: { claimRoundScoring, updatePhase, getGame, recordRoundAnswer },
  scoresRepo: { applyRoundResult, listScores },
  participantsRepo: { listParticipants },
  answersRepo: { listRoundAnswers },
}));
vi.mock('../metrics.ts', () => ({ emitMetric }));

const { revealAndScore, settleRound } = await import('./round.ts');

function game(overrides: Partial<Game> = {}): Game {
  return {
    gameId: 'g1',
    status: 'IN_ROUND',
    questionIds: ['q1', 'q2'],
    currentIndex: 0,
    questionDurationSec: 20,
    createdAt: 1_000,
    currentStartedAt: 5_000,
    ...overrides,
  };
}

beforeEach(() => {
  for (const m of [
    claimRoundScoring,
    updatePhase,
    getGame,
    recordRoundAnswer,
    applyRoundResult,
    listParticipants,
    listRoundAnswers,
    listScores,
    emitMetric,
  ]) {
    m.mockReset();
  }
  claimRoundScoring.mockResolvedValue(true);
  listParticipants.mockResolvedValue([]);
  listRoundAnswers.mockResolvedValue([]);
  listScores.mockResolvedValue([]);
  applyRoundResult.mockResolvedValue(undefined);
  updatePhase.mockResolvedValue(undefined);
  getGame.mockResolvedValue(game({ status: 'REVEAL', scoredIndex: 0 }));
});

function roundClosedCalls() {
  return emitMetric.mock.calls.filter((c) => c[0] === 'RoundClosed');
}

describe('RoundClosed metric', () => {
  it('emits once with Trigger=host when the host reveals', async () => {
    await revealAndScore(game(), 'host');

    expect(roundClosedCalls()).toEqual([['RoundClosed', 1, 'Count', { Trigger: 'host' }]]);
  });

  it("defaults the Trigger to 'timer' when no trigger is passed", async () => {
    await revealAndScore(game());

    expect(roundClosedCalls()).toEqual([['RoundClosed', 1, 'Count', { Trigger: 'timer' }]]);
  });

  it('does not emit when the scoring claim is lost', async () => {
    claimRoundScoring.mockResolvedValue(false);

    await revealAndScore(game(), 'host');

    expect(roundClosedCalls()).toHaveLength(0);
  });

  it("settleRound tags an expired round 'timer'", async () => {
    // currentStartedAt far in the past ⇒ the countdown has elapsed.
    await settleRound(game({ currentStartedAt: 1 }));

    expect(roundClosedCalls()).toEqual([['RoundClosed', 1, 'Count', { Trigger: 'timer' }]]);
  });

  it("settleRound tags an all-answered, non-expired round 'allAnswered'", async () => {
    // Live round (just started) that every joined player has answered.
    await settleRound(game({ currentStartedAt: Date.now(), participantCount: 2, roundAnswerCount: 2 }));

    expect(roundClosedCalls()).toEqual([['RoundClosed', 1, 'Count', { Trigger: 'allAnswered' }]]);
  });
});
