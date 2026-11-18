import { describe, it, expect } from 'vitest';
import { computeRoundUpdates, isRoundExpired, isRoundFullyAnswered, roundEndsAt } from './round.ts';
import type { Answer, Game } from '@serverlessq/shared';

function ans(playerId: string, correct: boolean, submittedAt: number): Answer {
  return {
    gameId: 'g1',
    sk: `Q#0#P#${playerId}`,
    questionId: 'q1',
    playerId,
    choice: correct ? 'A' : 'B',
    correct,
    submittedAt,
  };
}

describe('computeRoundUpdates', () => {
  it('scores answerers by speed, resets streaks for wrong AND non-answerers', () => {
    const participants = [
      { playerId: 'A', name: 'Alice' },
      { playerId: 'B', name: 'Bob' },
      { playerId: 'C', name: 'Cara' },
      { playerId: 'D', name: 'Dan' }, // did not answer
    ];
    const roundAnswers = [
      ans('A', true, 100), // fastest correct
      ans('B', true, 200), // slower correct
      ans('C', false, 150), // wrong
      // D absent
    ];
    const scores = new Map([
      ['A', { currentStreak: 2, longestStreak: 5 }],
      ['B', { currentStreak: 0, longestStreak: 0 }],
      ['C', { currentStreak: 1, longestStreak: 1 }],
      ['D', { currentStreak: 2, longestStreak: 2 }],
    ]);

    const byId = Object.fromEntries(
      computeRoundUpdates('g1', participants, roundAnswers, scores, 1000).map((u) => [
        u.playerId,
        u,
      ]),
    );

    // A: rank1 of 2 → round(100+50*1/2)=125; streak 2→3 ⇒ ×1.5 ⇒ 188
    expect(byId.A).toMatchObject({
      pointsDelta: 188,
      correct: true,
      newStreak: 3,
      longestStreak: 5, // max(5, 3)
      lastCorrectAt: 100, // A's own submit time, NOT the round-close `now` (1000)
    });
    // B: rank2 of 2 → 100; streak 0→1
    expect(byId.B).toMatchObject({
      pointsDelta: 100,
      correct: true,
      newStreak: 1,
      longestStreak: 1,
      lastCorrectAt: 200, // B's own submit time
    });

    // The whole point of the field: two players scored in the SAME round must not
    // share a timestamp, or the leaderboard's speed tie-break has nothing to
    // compare and silently degrades to alphabetical order.
    expect(byId.A?.lastCorrectAt).not.toBe(byId.B?.lastCorrectAt);
    expect(byId.A?.lastCorrectAt).toBeLessThan(byId.B!.lastCorrectAt!);
    // C: wrong → 0, streak reset
    expect(byId.C).toMatchObject({
      pointsDelta: 0,
      correct: false,
      newStreak: 0,
      longestStreak: 1,
    });
    expect(byId.C?.lastCorrectAt).toBeUndefined();
    // D: non-answerer → treated as wrong, streak reset to 0 (the reconciliation gap)
    expect(byId.D).toMatchObject({
      pointsDelta: 0,
      correct: false,
      newStreak: 0,
      longestStreak: 2,
    });
    expect(byId.D?.lastCorrectAt).toBeUndefined();
  });

  it('produces one update per active participant', () => {
    const participants = [
      { playerId: 'A', name: 'A' },
      { playerId: 'B', name: 'B' },
    ];
    const updates = computeRoundUpdates('g1', participants, [], new Map(), 1);
    expect(updates).toHaveLength(2);
    expect(updates.every((u) => u.pointsDelta === 0 && u.newStreak === 0)).toBe(true);
  });
});

// FR-8: the round's own clock. These cover the two cases that previously did not
// close a round at all — the timer running out, and every player having answered.
describe('roundEndsAt / isRoundExpired', () => {
  const openRound: Game = {
    gameId: 'g1',
    status: 'IN_ROUND',
    questionIds: ['q1', 'q2'],
    currentIndex: 0,
    currentStartedAt: 10_000,
    questionDurationSec: 20,
    createdAt: 0,
  };

  it('derives the close time from start + duration', () => {
    expect(roundEndsAt(openRound)).toBe(30_000);
  });

  it('is not expired before the deadline, and is expired at or after it', () => {
    expect(isRoundExpired(openRound, 29_999)).toBe(false);
    expect(isRoundExpired(openRound, 30_000)).toBe(true);
    expect(isRoundExpired(openRound, 30_001)).toBe(true);
  });

  it('honours a per-game duration rather than assuming 20s', () => {
    const long = { ...openRound, questionDurationSec: 45 };
    expect(roundEndsAt(long)).toBe(55_000);
    expect(isRoundExpired(long, 30_001)).toBe(false);
    expect(isRoundExpired(long, 55_000)).toBe(true);
  });

  it('has no deadline outside an open round', () => {
    expect(roundEndsAt({ ...openRound, status: 'REVEAL' })).toBeUndefined();
    expect(
      roundEndsAt({ ...openRound, status: 'LOBBY', currentStartedAt: undefined }),
    ).toBeUndefined();
    // A phase with no start time must never read as expired.
    expect(isRoundExpired({ ...openRound, currentStartedAt: undefined }, 1e12)).toBe(false);
    expect(isRoundExpired({ ...openRound, status: 'FINISHED' }, 1e12)).toBe(false);
  });
});

// FR-8, second close trigger: the round is over once nobody is still answering,
// even with time left on the clock.
describe('isRoundFullyAnswered', () => {
  const openRound: Game = {
    gameId: 'g1',
    status: 'IN_ROUND',
    questionIds: ['q1', 'q2'],
    currentIndex: 0,
    currentStartedAt: 10_000,
    questionDurationSec: 20,
    createdAt: 0,
    participantCount: 3,
  };

  it('is false while any joined player is still outstanding', () => {
    expect(isRoundFullyAnswered({ ...openRound, roundAnswerCount: 0 })).toBe(false);
    expect(isRoundFullyAnswered({ ...openRound, roundAnswerCount: 2 })).toBe(false);
    // An absent tally reads as zero answered, not as complete.
    expect(isRoundFullyAnswered(openRound)).toBe(false);
  });

  it('is true once every joined player has locked in', () => {
    expect(isRoundFullyAnswered({ ...openRound, roundAnswerCount: 3 })).toBe(true);
  });

  it('still closes on a tally that has drifted above the player count', () => {
    // A counter left high (mid-round deploy, repaired participant count) must not
    // pin the round open until the timer rescues it.
    expect(isRoundFullyAnswered({ ...openRound, roundAnswerCount: 4 })).toBe(true);
  });

  it('never fires for an empty room', () => {
    // 0 answers of 0 players is not "everyone answered" — it would reveal instantly.
    expect(isRoundFullyAnswered({ ...openRound, participantCount: 0, roundAnswerCount: 0 })).toBe(
      false,
    );
    expect(
      isRoundFullyAnswered({ ...openRound, participantCount: undefined, roundAnswerCount: 0 }),
    ).toBe(false);
  });

  it('only applies to a round that is open and unscored', () => {
    const complete = { ...openRound, roundAnswerCount: 3 };
    expect(isRoundFullyAnswered({ ...complete, status: 'REVEAL' })).toBe(false);
    expect(isRoundFullyAnswered({ ...complete, status: 'LOBBY' })).toBe(false);
    expect(isRoundFullyAnswered({ ...complete, status: 'FINISHED' })).toBe(false);
    // Already claimed for scoring ⇒ someone else owns this reveal.
    expect(isRoundFullyAnswered({ ...complete, scoredIndex: 0 })).toBe(false);
    // ...but a claim on the PREVIOUS round says nothing about this one.
    expect(isRoundFullyAnswered({ ...complete, currentIndex: 1, scoredIndex: 0 })).toBe(true);
  });
});
