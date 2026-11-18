import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  scoreRound,
  DEFAULT_SCORING,
  gamesRepo,
  participantsRepo,
  answersRepo,
  scoresRepo,
  earlyRevealWhenAllAnswered,
  type Answer,
  type Game,
  type Participant,
  type Score,
  type RoundAnswerInput,
  type ApplyRoundResultInput,
} from '@serverlessq/shared';
import { emitMetric } from '../metrics.ts';

/**
 * Pure reconciliation of a round into per-player score updates. Crucially it
 * includes ACTIVE participants who did NOT answer — they are treated as an
 * incorrect answer so their streak resets to 0 (scoreRound only sees who
 * answered; non-answerers are our responsibility, design §4 note / task 6.2).
 *
 * `now` is injected for deterministic testing.
 */
export function computeRoundUpdates(
  gameId: string,
  participants: Pick<Participant, 'playerId' | 'name'>[],
  roundAnswers: Answer[],
  scoresByPlayer: Map<string, Pick<Score, 'currentStreak' | 'longestStreak'>>,
  now: number,
): ApplyRoundResultInput[] {
  const answerByPlayer = new Map(roundAnswers.map((a) => [a.playerId, a]));

  const inputs: RoundAnswerInput[] = participants.map((p) => {
    const ans = answerByPlayer.get(p.playerId);
    return {
      playerId: p.playerId,
      correct: ans?.correct ?? false,
      submittedAt: ans?.submittedAt ?? Number.MAX_SAFE_INTEGER, // no answer ⇒ ranked last (irrelevant, it's wrong)
      prevStreak: scoresByPlayer.get(p.playerId)?.currentStreak ?? 0,
    };
  });

  const nameByPlayer = new Map(participants.map((p) => [p.playerId, p.name]));

  return scoreRound(inputs, DEFAULT_SCORING).map((r) => {
    const prevLongest = scoresByPlayer.get(r.playerId)?.longestStreak ?? 0;
    const correct = r.rank !== undefined;
    return {
      gameId,
      playerId: r.playerId,
      name: nameByPlayer.get(r.playerId) ?? 'Player',
      pointsDelta: r.awardedPoints,
      correct,
      newStreak: r.newStreak,
      longestStreak: Math.max(prevLongest, r.newStreak),
      // The player's OWN submit time, not the round-close time.
      //
      // This used to be `now`, which is identical for everyone scored in the same
      // round — so the leaderboard's "earliest lastCorrectAt" tie-break compared
      // equal values and fell through to playerId, ranking tied players
      // alphabetically instead of fastest-first. `submittedAt` is the server's
      // receive timestamp (the same fairness anchor `scoreRound` ranks on), so a
      // tie on points now resolves the way the round itself did.
      //
      // `now` remains the fallback purely for safety: `correct` implies an answer
      // exists, so it is not reachable in practice.
      lastCorrectAt: correct ? (answerByPlayer.get(r.playerId)?.submittedAt ?? now) : undefined,
    };
  });
}

/**
 * Close and score a round: read participants + this round's answers + current
 * scores, compute updates, and persist them with atomic `ADD` (design §6.2).
 * Called exactly once per round by the admin `next` transition (the phase guard
 * in the admin router ensures single execution — idempotent scoring).
 */
export async function closeRound(gameId: string, questionIndex: number): Promise<number> {
  const [participants, roundAnswers, scores] = await Promise.all([
    participantsRepo.listParticipants(gameId),
    answersRepo.listRoundAnswers(gameId, questionIndex),
    scoresRepo.listScores(gameId),
  ]);

  const active = participants.filter((p) => p.state === 'ACTIVE');
  const scoresByPlayer = new Map(scores.map((s) => [s.playerId, s]));

  const updates = computeRoundUpdates(gameId, active, roundAnswers, scoresByPlayer, Date.now());

  // Persist per-player: ADD cumulativePoints/correctCount + SET streak fields.
  await Promise.all(updates.map((u) => scoresRepo.applyRoundResult(u)));
  return updates.length;
}

// ── FR-8: a round that is done closes itself, without the host advancing ──────
//
// A round is due to close on either of two things: its timer expires, or every
// joined player has locked in an answer — waiting out a countdown nobody is still
// answering into is dead air. There is no scheduler in front of a Web Function,
// so "due" is settled lazily by whatever next touches the game: a state read, an
// SSE poll tick, the answer that completes the round, or the host's `next`. The
// IN_ROUND→REVEAL step is a conditional write, so concurrent sandboxes race
// safely and `closeRound` still runs exactly once.

/** Epoch ms the open round closes, or undefined when no round is open. */
export function roundEndsAt(game: Game): number | undefined {
  if (game.status !== 'IN_ROUND' || game.currentStartedAt === undefined) return undefined;
  return game.currentStartedAt + game.questionDurationSec * 1000;
}

/** True once the open round's countdown has run out (server clock is authoritative). */
export function isRoundExpired(game: Game, now: number = Date.now()): boolean {
  const endsAt = roundEndsAt(game);
  return endsAt !== undefined && now >= endsAt;
}

/**
 * True when every joined player has answered the open round, so there is nothing
 * left to wait for.
 *
 * Both numbers live on the game item — `roundAnswerCount` is reset when the round
 * opens and ADDed to by the answer path, `participantCount` by join/kick — so this
 * costs nothing on the read and SSE tick paths that already hold the record.
 *
 * `>=` not `===`: a counter that has drifted high (a mid-round deploy, a repaired
 * participant count) must still be able to close the round rather than pinning it
 * open until the timer saves it.
 *
 * A game with no players never qualifies — an empty room would otherwise satisfy
 * "everyone answered" with zero answers and reveal every question instantly.
 */
export function isRoundFullyAnswered(game: Game): boolean {
  if (!earlyRevealWhenAllAnswered) return false;
  if (game.status !== 'IN_ROUND' || game.scoredIndex === game.currentIndex) return false;
  const joined = game.participantCount ?? 0;
  if (joined <= 0) return false;
  return (game.roundAnswerCount ?? 0) >= joined;
}

/**
 * Score the round exactly once, THEN publish REVEAL. Returns the game as it now
 * stands; a lost race returns the winner's state.
 *
 * The order matters and used to be the other way round. Flipping the phase first
 * made the flip itself the scoring mutex, which meant every client could observe
 * REVEAL — the correct answer highlighted, the whole room looking at the
 * screen — while `closeRound` was still writing points. An SSE tick landing in
 * that window published the reveal beside a pre-round leaderboard, so the
 * standings read as stale/broken for exactly the second that matters, then
 * corrected themselves on the next tick.
 *
 * `claimRoundScoring` now carries the mutex (and closes the round to late
 * answers), which frees the phase flip to come last. By the time any client sees
 * REVEAL, the points behind it are final.
 */
export async function revealAndScore(
  game: Game,
  trigger?: 'timer' | 'allAnswered' | 'host',
): Promise<Game> {
  const claimed = await gamesRepo.claimRoundScoring(game.gameId, game.currentIndex);
  if (!claimed) {
    // Another sandbox (or the host) already claimed this round — it will publish
    // REVEAL when its scoring finishes. Never double-score.
    return (await gamesRepo.getGame(game.gameId)) ?? game;
  }

  // Exactly one scorer reaches here per round — claimRoundScoring is the mutex —
  // so this counts each closed round once, attributed to what triggered the
  // close (host reveal, timer expiry, or everyone having answered).
  emitMetric('RoundClosed', 1, 'Count', { Trigger: trigger ?? 'timer' });

  await closeRound(game.gameId, game.currentIndex);

  try {
    await gamesRepo.updatePhase(game.gameId, { status: 'REVEAL' }, 'IN_ROUND');
  } catch (err) {
    // Only a deliberate out-of-band phase change can land here; the claim above
    // already guarantees we are the single scorer.
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
  return (await gamesRepo.getGame(game.gameId)) ?? { ...game, status: 'REVEAL' };
}

/**
 * Close the round if it is done — countdown expired, or everyone answered. Cheap:
 * both conditions are decided from the game record already in hand, with no extra
 * reads, so this is safe on every read path.
 *
 * Note what "everyone" can and cannot mean here. It is the players who have
 * ALREADY joined, which with a QR-driven lobby is a real trap: two people scan,
 * both answer in three seconds, and the round reveals while the rest of the room
 * is still pointing phones at the screen. The room, not the code, decides whether
 * that is a problem — so it is a kill switch (`EARLY_REVEAL=false`) rather than a
 * heuristic, and a host who wants to hold a round open can still pace it manually.
 */
export async function settleRound(game: Game): Promise<Game> {
  if (!isRoundExpired(game) && !isRoundFullyAnswered(game)) return game;
  return revealAndScore(game, isRoundExpired(game) ? 'timer' : 'allAnswered');
}

/**
 * Tally an accepted answer against the open round and reveal if that answer was
 * the last one outstanding.
 *
 * Lives on the answer path because that is the only moment the tally changes, and
 * the caller is the one request that can turn the reveal around immediately — the
 * SSE tick would otherwise add up to a poll interval of dead air to a round the
 * room has already finished.
 *
 * Returns nothing: the answer's own response does not depend on the outcome, and
 * the tally is a no-op write when early reveal is switched off.
 */
export async function tallyAnswerAndSettle(gameId: string, questionIndex: number): Promise<void> {
  if (!earlyRevealWhenAllAnswered) return;
  const tallied = await gamesRepo.recordRoundAnswer(gameId, questionIndex);
  // null ⇒ the round closed under us; the winner of that race owns the reveal.
  if (tallied) await settleRound(tallied);
}
