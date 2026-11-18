import { describe, expect, it } from 'vitest';
import { compareScoreRows, toLeaderboardEntry } from './scores.js';
import type { Score } from '../types.js';

/**
 * The leaderboard ordering rule (design §4): points desc, then earliest
 * `lastCorrectAt`, then playerId.
 *
 * These cover the comparator directly. It previously lived inline inside
 * `getLeaderboard`, reachable only through a live DynamoDB query, and shipped with
 * a tie-break clause that evaluated to NaN and was silently skipped.
 */
function row(playerId: string, cumulativePoints: number, lastCorrectAt?: number): Score {
  return {
    gameId: 'g1',
    playerId,
    name: playerId,
    cumulativePoints,
    correctCount: 0,
    currentStreak: 0,
    longestStreak: 0,
    ...(lastCorrectAt !== undefined ? { lastCorrectAt } : {}),
  };
}

const order = (rows: Score[]) => [...rows].sort(compareScoreRows).map((r) => r.playerId);

describe('compareScoreRows', () => {
  it('ranks higher points first, regardless of timing', () => {
    expect(order([row('a', 100, 5), row('b', 300, 9), row('c', 200, 1)])).toEqual(['b', 'c', 'a']);
  });

  it('breaks a points tie on the EARLIEST lastCorrectAt, not alphabetically', () => {
    // 'zoe' was faster than 'adam'. Alphabetical order would be the bug.
    expect(order([row('adam', 200, 900), row('zoe', 200, 100)])).toEqual(['zoe', 'adam']);
  });

  it('is not fooled when both rows lack lastCorrectAt', () => {
    // The regression: `Infinity - Infinity` is NaN, NaN is falsy, so `||` fell
    // through. Falling through to playerId is right here — but only because the
    // timestamps are genuinely equal, not because the comparison broke.
    expect(order([row('b', 0), row('a', 0)])).toEqual(['a', 'b']);
  });

  it('sorts a player who never answered correctly last within their points group', () => {
    expect(order([row('never', 100), row('fast', 100, 50)])).toEqual(['fast', 'never']);
  });

  it('falls back to playerId only when points and timing are identical', () => {
    expect(order([row('b', 100, 42), row('a', 100, 42)])).toEqual(['a', 'b']);
  });

  it('is a total order: sorting is stable under input permutation', () => {
    const rows = [row('a', 100, 300), row('b', 100, 100), row('c', 250), row('d', 100, 200)];
    const expected = order(rows);
    expect(order([...rows].reverse())).toEqual(expected);
    expect(order([rows[2]!, rows[0]!, rows[3]!, rows[1]!])).toEqual(expected);
  });
});

describe('toLeaderboardEntry', () => {
  it('does not expose the player identifier used to submit answers', () => {
    const entry = toLeaderboardEntry(row('private-player-id', 250, 42));

    expect(entry).toEqual({ name: 'private-player-id', points: 250, streak: 0 });
    expect(entry).not.toHaveProperty('playerId');
  });
});
