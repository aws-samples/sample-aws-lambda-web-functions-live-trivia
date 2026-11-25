import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { tables, indexes, leaderboardTopN } from '../config.js';
import type { Score, LeaderboardEntry } from '../types.js';

export async function getScore(gameId: string, playerId: string): Promise<Score | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: tables.scores, Key: { gameId, playerId } }),
  );
  return (res.Item as Score | undefined) ?? null;
}

/**
 * Create a zeroed score row on join so the player appears on the leaderboard
 * immediately. No-op if the row already exists (idempotent via condition).
 */
export async function ensureScore(
  gameId: string,
  playerId: string,
  name: string,
): Promise<void> {
  const row: Score = {
    gameId,
    playerId,
    name,
    cumulativePoints: 0,
    correctCount: 0,
    currentStreak: 0,
    longestStreak: 0,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: tables.scores,
        Item: row,
        ConditionExpression: 'attribute_not_exists(playerId)',
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
}

export interface ApplyRoundResultInput {
  gameId: string;
  playerId: string;
  name: string;
  /** Points to add this round (0 for wrong/no answer). */
  pointsDelta: number;
  correct: boolean;
  /** Post-round streak (already computed by scoreRound). */
  newStreak: number;
  /** Post-round longest streak (max of previous longest and newStreak). */
  longestStreak: number;
  /** Set only when the answer was correct. */
  lastCorrectAt?: number;
}

/**
 * Apply one player's round outcome with an atomic `ADD` to cumulative fields
 * (design §4 / DD-7) so concurrent updates never clobber each other. Streak
 * fields are absolute SETs (already reconciled by the scoring service).
 */
export async function applyRoundResult(input: ApplyRoundResultInput): Promise<void> {
  const sets = ['#n = :name', 'currentStreak = :s', 'longestStreak = :l'];
  const values: Record<string, unknown> = {
    ':p': input.pointsDelta,
    ':c': input.correct ? 1 : 0,
    ':name': input.name,
    ':s': input.newStreak,
    ':l': input.longestStreak,
  };
  if (input.correct && input.lastCorrectAt !== undefined) {
    sets.push('lastCorrectAt = :t');
    values[':t'] = input.lastCorrectAt;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: tables.scores,
      Key: { gameId: input.gameId, playerId: input.playerId },
      UpdateExpression: `ADD cumulativePoints :p, correctCount :c SET ${sets.join(', ')}`,
      ExpressionAttributeNames: { '#n': 'name' },
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * Leaderboard ordering (design §4): points desc, then the EARLIEST
 * `lastCorrectAt`, then playerId so the result is totally ordered.
 *
 * Pure and exported so the rule is unit-testable. The previous version was an
 * inline comparator only reachable through a live DynamoDB query, which is how it
 * shipped with a silently dead middle clause:
 *
 *   (a.lastCorrectAt ?? Infinity) - (b.lastCorrectAt ?? Infinity)
 *
 * When BOTH sides were absent that evaluates to `Infinity - Infinity` → `NaN`,
 * and `NaN` is falsy, so `||` skipped straight to playerId — the speed tie-break
 * degraded to alphabetical without ever failing. Absent values are now branched
 * on explicitly, and a player who has never answered correctly sorts last within
 * their points group rather than first.
 */
export function compareScoreRows(a: Score, b: Score): number {
  if (a.cumulativePoints !== b.cumulativePoints) {
    return b.cumulativePoints - a.cumulativePoints;
  }
  if (a.lastCorrectAt !== b.lastCorrectAt) {
    if (a.lastCorrectAt === undefined) return 1;
    if (b.lastCorrectAt === undefined) return -1;
    return a.lastCorrectAt - b.lastCorrectAt;
  }
  return a.playerId.localeCompare(b.playerId);
}

/** Map an internal score row to the public leaderboard contract. */
export function toLeaderboardEntry(row: Score): LeaderboardEntry {
  return {
    name: row.name,
    points: row.cumulativePoints,
    streak: row.currentStreak,
  };
}

/**
 * Top-N leaderboard (task 2.2, §4). Queries the leaderboard-index GSI
 * (PK gameId, SK cumulativePoints desc), over-fetches a buffer, then applies
 * `compareScoreRows` for a deterministic tie-break.
 *
 * The GSI must project `lastCorrectAt` (see infra/terraform/dynamodb.tf) or the
 * tie-break silently loses its speed component — the rows come back from the
 * index, not the table, so an unprojected attribute simply arrives `undefined`.
 */
export async function getLeaderboard(
  gameId: string,
  topN: number = leaderboardTopN,
): Promise<LeaderboardEntry[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: tables.scores,
      IndexName: indexes.leaderboardIndex,
      KeyConditionExpression: 'gameId = :g',
      ExpressionAttributeValues: { ':g': gameId },
      ScanIndexForward: false, // highest cumulativePoints first
      Limit: topN + 10, // buffer for deterministic tie-break
    }),
  );
  const rows = (res.Items as Score[] | undefined) ?? [];
  rows.sort(compareScoreRows);
  return rows.slice(0, topN).map(toLeaderboardEntry);
}

/** All score rows for a game (admin/debug). */
export async function listScores(gameId: string): Promise<Score[]> {
  const items: Score[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tables.scores,
        KeyConditionExpression: 'gameId = :g',
        ExpressionAttributeValues: { ':g': gameId },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...((res.Items as Score[] | undefined) ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/** Cascade helper: delete every score row of a game. */
export async function deleteAllForGame(gameId: string): Promise<void> {
  const scores = await listScores(gameId);
  for (let i = 0; i < scores.length; i += 25) {
    const chunk = scores.slice(i, i + 25);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [tables.scores]: chunk.map((s) => ({
            DeleteRequest: { Key: { gameId: s.gameId, playerId: s.playerId } },
          })),
        },
      }),
    );
  }
}
