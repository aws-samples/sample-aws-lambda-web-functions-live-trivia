import { randomUUID } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { tables } from '../config.js';
import type { Participant } from '../types.js';

/** Create a participant with a server-issued UUID (FR-2). */
export async function createParticipant(gameId: string, name: string): Promise<Participant> {
  const now = Date.now();
  const participant: Participant = {
    gameId,
    playerId: randomUUID(),
    name,
    state: 'ACTIVE',
    joinedAt: now,
    lastSeenAt: now,
  };
  await ddb.send(new PutCommand({ TableName: tables.participants, Item: participant }));
  return participant;
}

export async function getParticipant(
  gameId: string,
  playerId: string,
): Promise<Participant | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: tables.participants, Key: { gameId, playerId } }),
  );
  return (res.Item as Participant | undefined) ?? null;
}

/** All participants for a game — powers the admin live-players view (FR-20). */
export async function listParticipants(gameId: string): Promise<Participant[]> {
  const items: Participant[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tables.participants,
        KeyConditionExpression: 'gameId = :g',
        ExpressionAttributeValues: { ':g': gameId },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...((res.Items as Participant[] | undefined) ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/**
 * Count participants without transferring the items (`Select: COUNT`). Used to
 * reconcile the GAMES.participantCount counter at activation — the lobby read
 * path uses the counter, not this query.
 */
export async function countParticipants(gameId: string): Promise<number> {
  let count = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tables.participants,
        KeyConditionExpression: 'gameId = :g',
        ExpressionAttributeValues: { ':g': gameId },
        Select: 'COUNT',
        ExclusiveStartKey: lastKey,
      }),
    );
    count += res.Count ?? 0;
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return count;
}

/** Refresh a participant's lastSeenAt (liveness). */
export async function touchParticipant(gameId: string, playerId: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tables.participants,
      Key: { gameId, playerId },
      UpdateExpression: 'SET lastSeenAt = :t',
      ExpressionAttributeValues: { ':t': Date.now() },
    }),
  );
}

/**
 * Kick / moderation (FR-21). Returns whether a participant was actually removed,
 * so the caller only decrements the join counter for a real deletion — a
 * double-clicked kick must not drive the lobby count below the truth.
 */
export async function deleteParticipant(gameId: string, playerId: string): Promise<boolean> {
  const res = await ddb.send(
    new DeleteCommand({
      TableName: tables.participants,
      Key: { gameId, playerId },
      ReturnValues: 'ALL_OLD',
    }),
  );
  return res.Attributes !== undefined;
}

/** Cascade helper: remove every participant of a game (batched in 25s). */
export async function deleteAllForGame(gameId: string): Promise<void> {
  const participants = await listParticipants(gameId);
  await batchDelete(participants.map((p) => ({ gameId: p.gameId, playerId: p.playerId })));
}

async function batchDelete(keys: Array<{ gameId: string; playerId: string }>): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    const chunk = keys.slice(i, i + 25);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [tables.participants]: chunk.map((Key) => ({ DeleteRequest: { Key } })),
        },
      }),
    );
  }
}
