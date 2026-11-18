/**
 * Speed- and streak-based scoring (D8, design §4). Pure and deterministic so it
 * can be unit- and property-tested without any AWS dependency (DD-13/14).
 *
 * Formula, per round with `k` correct answers ranked 1..k by server-received
 * timestamp (fastest = rank 1):
 *
 *   basePoints(rank) = round(BASE + BONUS * (k - rank) / k)     // BASE=100, BONUS=50
 *   streak'          = correct ? prevStreak + 1 : 0
 *   multiplier       = streak' >= STREAK_THRESHOLD ? STREAK_MULTIPLIER : 1
 *   awarded          = round(basePoints * multiplier)           // 0 if incorrect / no answer
 */

export interface ScoringConfig {
  /** Floor points for any correct answer. */
  base: number;
  /** Extra points distributed by speed rank. */
  bonus: number;
  /** Consecutive-correct count at which the multiplier kicks in. */
  streakThreshold: number;
  /** Multiplier applied once the streak threshold is met. */
  streakMultiplier: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  base: 100,
  bonus: 50,
  streakThreshold: 3,
  streakMultiplier: 1.5,
};

/** One player's answer for a single round (input to `scoreRound`). */
export interface RoundAnswerInput {
  playerId: string;
  correct: boolean;
  /** Server-received epoch ms; the fairness anchor for speed ranking. */
  submittedAt: number;
  /** The player's streak BEFORE this round. */
  prevStreak: number;
}

/** Per-player scoring outcome for a round. */
export interface RoundScoreResult {
  playerId: string;
  awardedPoints: number;
  newStreak: number;
  /** 1-based rank among correct answers; undefined when the answer was wrong. */
  rank?: number;
}

/** Advance (or reset) a streak for a single answer. */
export function applyStreak(prevStreak: number, correct: boolean): number {
  return correct ? prevStreak + 1 : 0;
}

/** Streak multiplier for a given (post-answer) streak length. */
export function streakMultiplier(streak: number, cfg: ScoringConfig = DEFAULT_SCORING): number {
  return streak >= cfg.streakThreshold ? cfg.streakMultiplier : 1;
}

/**
 * Base (pre-streak) points for a 1-based `rank` among `correctCount` correct
 * answers. Monotonic non-increasing in `rank`: a faster answer never scores
 * fewer base points than a slower one.
 */
export function rankPoints(
  rank: number,
  correctCount: number,
  cfg: ScoringConfig = DEFAULT_SCORING,
): number {
  if (correctCount <= 0 || rank < 1 || rank > correctCount) return 0;
  return Math.round(cfg.base + (cfg.bonus * (correctCount - rank)) / correctCount);
}

/**
 * Score one round. Correct answers are ranked by (submittedAt asc, playerId asc)
 * — the playerId tiebreak makes ranking deterministic when timestamps collide.
 * Returns a result for every input player (incorrect answers reset the streak
 * to 0 and award 0). Players who did not answer at all are the caller's concern
 * (round-close reconciliation, task 6.2) and are not represented here.
 */
export function scoreRound(
  answers: readonly RoundAnswerInput[],
  cfg: ScoringConfig = DEFAULT_SCORING,
): RoundScoreResult[] {
  const correct = answers
    .filter((a) => a.correct)
    .sort((a, b) => a.submittedAt - b.submittedAt || a.playerId.localeCompare(b.playerId));

  const rankByPlayer = new Map<string, number>();
  correct.forEach((a, i) => rankByPlayer.set(a.playerId, i + 1));

  const k = correct.length;

  return answers.map((a) => {
    const newStreak = applyStreak(a.prevStreak, a.correct);
    if (!a.correct) {
      return { playerId: a.playerId, awardedPoints: 0, newStreak };
    }
    const rank = rankByPlayer.get(a.playerId)!;
    const base = rankPoints(rank, k, cfg);
    const awardedPoints = Math.round(base * streakMultiplier(newStreak, cfg));
    return { playerId: a.playerId, awardedPoints, newStreak, rank };
  });
}
