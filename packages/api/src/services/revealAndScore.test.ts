import type * as Shared from '@serverlessq/shared';
import type { Game } from '@serverlessq/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ordering guarantee behind the reveal.
 *
 * REVEAL must not be published until the round's points are written. When the
 * phase flip came first it doubled as the scoring mutex, so every client could
 * observe REVEAL — correct answer highlighted, whole room watching — while the
 * score writes were still in flight. An SSE tick landing there published the
 * reveal beside a pre-round leaderboard.
 */
const calls: string[] = [];

const claimRoundScoring = vi.hoisted(() => vi.fn());
const updatePhase = vi.hoisted(() => vi.fn());
const getGame = vi.hoisted(() => vi.fn());
const recordRoundAnswer = vi.hoisted(() => vi.fn());
const applyRoundResult = vi.hoisted(() => vi.fn());
const listParticipants = vi.hoisted(() => vi.fn());
const listRoundAnswers = vi.hoisted(() => vi.fn());
const listScores = vi.hoisted(() => vi.fn());

vi.mock('@serverlessq/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof Shared>()),
  gamesRepo: { claimRoundScoring, updatePhase, getGame, recordRoundAnswer },
  scoresRepo: { applyRoundResult, listScores },
  participantsRepo: { listParticipants },
  answersRepo: { listRoundAnswers },
}));

const { revealAndScore, tallyAnswerAndSettle } = await import('./round.ts');

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
  calls.length = 0;
  for (const m of [
    claimRoundScoring,
    updatePhase,
    getGame,
    recordRoundAnswer,
    applyRoundResult,
    listParticipants,
    listRoundAnswers,
    listScores,
  ]) {
    m.mockReset();
  }

  claimRoundScoring.mockImplementation(() => {
    calls.push('claim');
    return Promise.resolve(true);
  });
  listParticipants.mockResolvedValue([
    { playerId: 'A', name: 'Alice', state: 'ACTIVE' },
    { playerId: 'B', name: 'Bob', state: 'ACTIVE' },
  ]);
  listRoundAnswers.mockResolvedValue([
    { gameId: 'g1', sk: 'Q#0#P#A', questionId: 'q1', playerId: 'A', choice: 'x', correct: true, submittedAt: 10 },
  ]);
  listScores.mockResolvedValue([]);
  applyRoundResult.mockImplementation((u: { playerId: string }) => {
    calls.push(`score:${u.playerId}`);
    return Promise.resolve();
  });
  updatePhase.mockImplementation(() => {
    calls.push('reveal');
    return Promise.resolve();
  });
  getGame.mockResolvedValue(game({ status: 'REVEAL', scoredIndex: 0 }));
});

describe('revealAndScore', () => {
  it('writes every score BEFORE publishing REVEAL', async () => {
    await revealAndScore(game());

    expect(calls[0]).toBe('claim');
    expect(calls.at(-1)).toBe('reveal');
    // The reveal is last, so no client can see REVEAL beside stale points.
    const revealAt = calls.indexOf('reveal');
    const scoreIndexes = calls.flatMap((c, i) => (c.startsWith('score:') ? [i] : []));
    expect(scoreIndexes.length).toBe(2); // one per active participant
    for (const i of scoreIndexes) expect(i).toBeLessThan(revealAt);
  });

  it('flips the phase exactly once, guarded on IN_ROUND', async () => {
    await revealAndScore(game());

    expect(updatePhase).toHaveBeenCalledTimes(1);
    expect(updatePhase).toHaveBeenCalledWith('g1', { status: 'REVEAL' }, 'IN_ROUND');
  });

  it('does not score or reveal when it loses the claim', async () => {
    claimRoundScoring.mockImplementation(() => {
      calls.push('claim');
      return Promise.resolve(false);
    });

    const result = await revealAndScore(game());

    // A double-click, or a second sandbox's poll tick, must be a no-op here —
    // the winner is already scoring and will publish the reveal itself.
    expect(applyRoundResult).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
    expect(result.status).toBe('REVEAL');
  });

  it('claims the round it was handed, not whatever the record says later', async () => {
    await revealAndScore(game({ currentIndex: 1 }));

    expect(claimRoundScoring).toHaveBeenCalledWith('g1', 1);
    expect(listRoundAnswers).toHaveBeenCalledWith('g1', 1);
  });
});

/**
 * FR-8: the last answer in, not the last second on the clock, is what ends a round
 * whose room has finished answering.
 */
describe('tallyAnswerAndSettle', () => {
  /**
   * A round with time genuinely left on it — the default fixture's start time is in
   * the distant past, which would close the round by expiry and prove nothing about
   * the "everyone answered" trigger.
   */
  function liveRound(overrides: Partial<Game> = {}): Game {
    return game({ currentStartedAt: Date.now(), ...overrides });
  }

  it('reveals when the tally shows every joined player has answered', async () => {
    recordRoundAnswer.mockResolvedValue(liveRound({ participantCount: 2, roundAnswerCount: 2 }));

    await tallyAnswerAndSettle('g1', 0);

    expect(recordRoundAnswer).toHaveBeenCalledWith('g1', 0);
    expect(claimRoundScoring).toHaveBeenCalledWith('g1', 0);
    expect(updatePhase).toHaveBeenCalledWith('g1', { status: 'REVEAL' }, 'IN_ROUND');
  });

  it('leaves the round open while anyone is still outstanding', async () => {
    recordRoundAnswer.mockResolvedValue(liveRound({ participantCount: 3, roundAnswerCount: 2 }));

    await tallyAnswerAndSettle('g1', 0);

    expect(claimRoundScoring).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('does nothing when the round closed under the tally', async () => {
    // The conditional tally write failed — the timer or the host already closed the
    // round, and whoever won that race owns the reveal.
    recordRoundAnswer.mockResolvedValue(null);

    await tallyAnswerAndSettle('g1', 0);

    expect(claimRoundScoring).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('scores before revealing on the early close too', async () => {
    recordRoundAnswer.mockResolvedValue(liveRound({ participantCount: 2, roundAnswerCount: 2 }));

    await tallyAnswerAndSettle('g1', 0);

    // Same ordering guarantee as the host-driven reveal: points land first.
    expect(calls.at(-1)).toBe('reveal');
    expect(calls.filter((c) => c.startsWith('score:'))).toHaveLength(2);
  });
});
