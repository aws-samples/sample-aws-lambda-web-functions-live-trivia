import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_SCORING,
  applyStreak,
  rankPoints,
  scoreRound,
  streakMultiplier,
  type RoundAnswerInput,
} from './scoring.js';

describe('rankPoints', () => {
  it('awards BASE to the slowest correct answer and BASE+~BONUS to the fastest', () => {
    // k = 4: rank1 = round(100 + 50*3/4)=138, rank4 = 100
    expect(rankPoints(1, 4)).toBe(138);
    expect(rankPoints(2, 4)).toBe(125);
    expect(rankPoints(3, 4)).toBe(113);
    expect(rankPoints(4, 4)).toBe(100);
  });

  it('single correct answer gets exactly BASE', () => {
    expect(rankPoints(1, 1)).toBe(100);
  });

  it('returns 0 for out-of-range ranks', () => {
    expect(rankPoints(0, 3)).toBe(0);
    expect(rankPoints(4, 3)).toBe(0);
    expect(rankPoints(1, 0)).toBe(0);
  });
});

describe('applyStreak', () => {
  it('increments on correct and resets to 0 on wrong', () => {
    expect(applyStreak(0, true)).toBe(1);
    expect(applyStreak(2, true)).toBe(3);
    expect(applyStreak(5, false)).toBe(0);
  });
});

describe('streakMultiplier — triggers at exactly the threshold', () => {
  it('is 1x below 3 and 1.5x at/above 3', () => {
    expect(streakMultiplier(0)).toBe(1);
    expect(streakMultiplier(2)).toBe(1); // 2 → not yet
    expect(streakMultiplier(3)).toBe(1.5); // exactly 3 → triggers
    expect(streakMultiplier(9)).toBe(1.5);
  });

  it('property: multiplier is 1 iff streak < threshold, else streakMultiplier', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), (streak) => {
        const m = streakMultiplier(streak);
        return streak < DEFAULT_SCORING.streakThreshold
          ? m === 1
          : m === DEFAULT_SCORING.streakMultiplier;
      }),
    );
  });
});

describe('scoreRound', () => {
  it('ranks by submittedAt (fastest first) and applies the streak multiplier', () => {
    const answers: RoundAnswerInput[] = [
      { playerId: 'slow', correct: true, submittedAt: 300, prevStreak: 0 },
      { playerId: 'fast', correct: true, submittedAt: 100, prevStreak: 2 }, // → streak 3 → 1.5x
      { playerId: 'mid', correct: true, submittedAt: 200, prevStreak: 0 },
      { playerId: 'wrong', correct: false, submittedAt: 150, prevStreak: 4 },
    ];
    const results = Object.fromEntries(scoreRound(answers).map((r) => [r.playerId, r]));

    // 3 correct: fast=rank1 round(100+50*2/3)=133, *1.5=200; mid=rank2 117; slow=rank3 100
    expect(results.fast).toMatchObject({ rank: 1, newStreak: 3, awardedPoints: 200 });
    expect(results.mid).toMatchObject({ rank: 2, newStreak: 1, awardedPoints: 117 });
    expect(results.slow).toMatchObject({ rank: 3, newStreak: 1, awardedPoints: 100 });
    // wrong answer: 0 points, streak reset, no rank
    expect(results.wrong).toMatchObject({ awardedPoints: 0, newStreak: 0 });
    expect(results.wrong.rank).toBeUndefined();
  });

  it('breaks timestamp ties deterministically by playerId', () => {
    const answers: RoundAnswerInput[] = [
      { playerId: 'b', correct: true, submittedAt: 100, prevStreak: 0 },
      { playerId: 'a', correct: true, submittedAt: 100, prevStreak: 0 },
    ];
    const byId = Object.fromEntries(scoreRound(answers).map((r) => [r.playerId, r]));
    expect(byId.a.rank).toBe(1); // 'a' < 'b' on tie
    expect(byId.b.rank).toBe(2);
  });

  it('returns exactly one result per input player (idempotent shape)', () => {
    const answers: RoundAnswerInput[] = [
      { playerId: 'p1', correct: true, submittedAt: 10, prevStreak: 0 },
      { playerId: 'p2', correct: false, submittedAt: 20, prevStreak: 0 },
    ];
    const results = scoreRound(answers);
    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.playerId)).size).toBe(2);
  });

  // ── Essential property tests (DD-14) ─────────────────────────────────────

  it('property: speed monotonicity — earlier correct answers score >= later ones', () => {
    fc.assert(
      fc.property(
        // distinct timestamps so ranking is unambiguous; one shared prevStreak
        // so the multiplier is constant and we isolate the speed dimension.
        fc.uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 0, max: 10 }),
        (timestamps, prevStreak) => {
          const answers: RoundAnswerInput[] = timestamps.map((ts, i) => ({
            playerId: `p${i}`,
            correct: true,
            submittedAt: ts,
            prevStreak,
          }));
          const ranked = scoreRound(answers).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
          for (let i = 1; i < ranked.length; i++) {
            if (ranked[i]!.awardedPoints > ranked[i - 1]!.awardedPoints) return false;
          }
          return true;
        },
      ),
    );
  });

  it('property: deterministic — same input yields identical output', () => {
    const answer = fc.record({
      playerId: fc.string({ minLength: 1, maxLength: 8 }),
      correct: fc.boolean(),
      submittedAt: fc.integer({ min: 0, max: 1_000_000 }),
      prevStreak: fc.integer({ min: 0, max: 10 }),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(answer, { selector: (a) => a.playerId, maxLength: 30 }),
        (answers) => {
          expect(scoreRound(answers)).toEqual(scoreRound(answers));
        },
      ),
    );
  });

  it('property: awarded points are non-negative integers', () => {
    const answer = fc.record({
      playerId: fc.string({ minLength: 1, maxLength: 8 }),
      correct: fc.boolean(),
      submittedAt: fc.integer({ min: 0, max: 1_000_000 }),
      prevStreak: fc.integer({ min: 0, max: 10 }),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(answer, { selector: (a) => a.playerId, maxLength: 30 }),
        (answers) => {
          for (const r of scoreRound(answers)) {
            if (!Number.isInteger(r.awardedPoints) || r.awardedPoints < 0) return false;
          }
          return true;
        },
      ),
    );
  });
});
