import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { tables, indexes } from '../config.js';
import { generateGameName } from '../gameNames.js';
import type { Game, GamePhase } from '../types.js';
import * as participants from './participants.js';
import * as answers from './answers.js';
import * as scores from './scores.js';

export interface CreateGameInput {
  name?: string;
  questionIds: string[];
  /** Set the snapshot was drawn from; recorded for display, not re-read at play time. */
  questionSetId?: string;
  questionDurationSec: number;
  activate?: boolean;
}

/** Create a game with a frozen question snapshot (DD-5a); optionally activate it. */
export async function createGame(input: CreateGameInput): Promise<Game> {
  const game: Game = {
    gameId: randomUUID(),
    name: input.name?.trim() || generateGameName(),
    status: 'LOBBY',
    ...(input.questionSetId ? { questionSetId: input.questionSetId } : {}),
    questionIds: input.questionIds,
    currentIndex: 0,
    questionDurationSec: input.questionDurationSec,
    createdAt: Date.now(),
  };
  await ddb.send(new PutCommand({ TableName: tables.games, Item: game }));
  if (input.activate !== false) {
    await setActive(game.gameId);
    game.active = 'Y';
  }
  return game;
}

export async function getGame(gameId: string): Promise<Game | null> {
  const res = await ddb.send(new GetCommand({ TableName: tables.games, Key: { gameId } }));
  return (res.Item as Game | undefined) ?? null;
}

/**
 * Every active game, via the sparse active-index GSI (§4).
 *
 * Multiple games run in parallel — several rooms, several hosts, one deployment —
 * so activation is NOT exclusive and there is deliberately no "the active game"
 * accessor. Every player, host, and leaderboard surface is scoped to an explicit
 * gameId from the URL instead of resolving whichever game happens to be flagged.
 */
export async function listActiveGames(): Promise<Game[]> {
  const items: Game[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tables.games,
        IndexName: indexes.activeIndex,
        KeyConditionExpression: 'active = :y',
        ExpressionAttributeValues: { ':y': 'Y' },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...((res.Items as Game[] | undefined) ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export async function listGames(): Promise<Game[]> {
  const res = await ddb.send(new ScanCommand({ TableName: tables.games }));
  return (res.Items as Game[] | undefined) ?? [];
}

/**
 * Flag `gameId` as active (listed on the public game directory).
 *
 * Additive on purpose: activating a game does NOT deactivate any other, because
 * parallel sessions must coexist. Use `setInactive` to take one off the list.
 */
export async function setActive(gameId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tables.games,
      Key: { gameId },
      UpdateExpression: 'SET active = :y',
      ExpressionAttributeValues: { ':y': 'Y' },
    }),
  );
  // Activation is the natural sync point for the join counter: it runs once per
  // game, so it costs one COUNT query and repairs any game whose counter is
  // absent (created before the counter) or drifted from a partial cascade.
  await setParticipantCount(gameId, await participants.countParticipants(gameId));
}

/** Drop `gameId` off the public game directory, leaving its data intact. */
export async function setInactive(gameId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tables.games,
      Key: { gameId },
      UpdateExpression: 'REMOVE active',
    }),
  );
}

/**
 * Atomically move the join counter (DynamoDB ADD treats an absent attribute as
 * 0). Decrements are guarded so a drifted counter can never go negative and
 * show a nonsense lobby count on the projected host screen.
 */
export async function bumpParticipantCount(gameId: string, delta: number): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.games,
        Key: { gameId },
        UpdateExpression: 'ADD participantCount :d',
        ExpressionAttributeValues: { ':d': delta, ...(delta < 0 ? { ':floor': -delta } : {}) },
        ...(delta < 0
          ? {
              ConditionExpression:
                'attribute_exists(participantCount) AND participantCount >= :floor',
            }
          : {}),
      }),
    );
  } catch (err) {
    // Only reachable on a decrement against an already-zero/absent counter —
    // the count is already correct, so there is nothing to repair.
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
}

/** Overwrite the join counter with an authoritative value. */
export async function setParticipantCount(gameId: string, count: number): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tables.games,
      Key: { gameId },
      UpdateExpression: 'SET participantCount = :c',
      ExpressionAttributeValues: { ':c': count },
    }),
  );
}

/** LOBBY → IN_ROUND on the first question (FR-5). */
export async function startGame(gameId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tables.games,
      Key: { gameId },
      UpdateExpression:
        'SET #s = :s, currentIndex = :i, currentStartedAt = :t, roundAnswerCount = :zero',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': 'IN_ROUND' satisfies GamePhase,
        ':i': 0,
        ':t': Date.now(),
        ':zero': 0,
      },
    }),
  );
}

/**
 * Tally one accepted answer against the open round and return the game as it now
 * stands, or null when the round is no longer open to answers.
 *
 * Returning the whole updated item (ALL_NEW) is the point: `roundAnswerCount` and
 * `participantCount` come back from the same atomic write, so "has everyone
 * locked in?" is decided on one consistent snapshot rather than a counter read
 * next to a player count that may have moved. Costs one write on the answer path
 * and no reads.
 *
 * The condition pins the tally to the round the caller validated — an answer
 * racing the host's "next" must not land in the following round's count, and a
 * round already claimed for scoring has had its answers read.
 */
export async function recordRoundAnswer(
  gameId: string,
  questionIndex: number,
): Promise<Game | null> {
  try {
    const res = await ddb.send(
      new UpdateCommand({
        TableName: tables.games,
        Key: { gameId },
        UpdateExpression: 'ADD roundAnswerCount :one',
        ConditionExpression:
          '#s = :inRound AND currentIndex = :i AND (attribute_not_exists(scoredIndex) OR scoredIndex <> :i)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':i': questionIndex,
          ':inRound': 'IN_ROUND' satisfies GamePhase,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return (res.Attributes as Game | undefined) ?? null;
  } catch (err) {
    // The round closed under us (timer settled, host revealed, game advanced).
    // The answer itself is already written; there is just nothing left to close.
    if (err instanceof ConditionalCheckFailedException) return null;
    throw err;
  }
}

/**
 * Set the phase and (optionally) the current round pointer. Guarded so a phase
 * transition only applies from the expected phase — makes double-clicking
 * "next" safe (idempotent admin transition).
 */
/**
 * Claim a round for scoring. Returns true for the single caller that wins.
 *
 * One conditional write does two jobs:
 *
 *  1. **Exactly-once scoring.** Whoever sets `scoredIndex` to this index is the
 *     only one who may score it. Previously the IN_ROUND→REVEAL phase flip was
 *     the mutex, which forced the flip to happen FIRST — so clients saw REVEAL,
 *     and the correct answer, while the points were still being written.
 *  2. **Closing the round to answers.** The submission path rejects once this is
 *     set, which matters because the host can reveal EARLY, before the countdown
 *     expires: without this, an answer could land between the claim and the last
 *     score write and never be counted.
 *
 * Guarded on IN_ROUND so a claim cannot resurrect an already-revealed round.
 */
export async function claimRoundScoring(gameId: string, questionIndex: number): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tables.games,
        Key: { gameId },
        UpdateExpression: 'SET scoredIndex = :i',
        ConditionExpression:
          '#s = :inRound AND (attribute_not_exists(scoredIndex) OR scoredIndex <> :i)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':i': questionIndex, ':inRound': 'IN_ROUND' },
      }),
    );
    return true;
  } catch (err) {
    // Someone else already claimed this round, or it is no longer open.
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

export async function updatePhase(
  gameId: string,
  next: { status: GamePhase; currentIndex?: number; currentStartedAt?: number },
  expectedStatus?: GamePhase,
): Promise<void> {
  const values: Record<string, unknown> = { ':s': next.status };
  const sets = ['#s = :s'];
  if (next.currentIndex !== undefined) {
    sets.push('currentIndex = :i');
    values[':i'] = next.currentIndex;
  }
  if (next.currentStartedAt !== undefined) {
    sets.push('currentStartedAt = :t');
    values[':t'] = next.currentStartedAt;
    // A start time is only ever stamped when a round OPENS, which is exactly when
    // the answer tally has to go back to zero — otherwise the previous round's
    // answers would make the new one look instantly complete.
    sets.push('roundAnswerCount = :zero');
    values[':zero'] = 0;
  }
  if (expectedStatus) {
    values[':expected'] = expectedStatus;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: tables.games,
      Key: { gameId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: values,
      ...(expectedStatus ? { ConditionExpression: '#s = :expected' } : {}),
    }),
  );
}

/** Reset play data but keep the game + question snapshot (FR: admin clear). */
export async function clearGame(gameId: string): Promise<void> {
  await Promise.all([
    participants.deleteAllForGame(gameId),
    answers.deleteAllForGame(gameId),
    scores.deleteAllForGame(gameId),
  ]);
  await ddb.send(
    new UpdateCommand({
      TableName: tables.games,
      Key: { gameId },
      UpdateExpression:
        'SET #s = :s, currentIndex = :i, participantCount = :zero, roundAnswerCount = :zero REMOVE currentStartedAt, scoredIndex',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'LOBBY' satisfies GamePhase, ':i': 0, ':zero': 0 },
    }),
  );
}

/** Cascade delete the game and all its play data (§4, DD-5). */
export async function deleteGame(gameId: string): Promise<void> {
  await Promise.all([
    participants.deleteAllForGame(gameId),
    answers.deleteAllForGame(gameId),
    scores.deleteAllForGame(gameId),
  ]);
  await ddb.send(new DeleteCommand({ TableName: tables.games, Key: { gameId } }));
}
