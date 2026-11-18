import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { tables } from '../config.js';
import type { Answer } from '../types.js';

/** Sort-key prefix for a round; `begins_with` selects all answers of that round. */
export function roundSkPrefix(questionIndex: number): string {
  return `Q#${questionIndex}#`;
}

/** Composite sort key: one answer per (game, round, player). */
export function answerSk(questionIndex: number, playerId: string): string {
  return `Q#${questionIndex}#P#${playerId}`;
}

export interface SubmitAnswerInput {
  gameId: string;
  questionIndex: number;
  questionId: string;
  playerId: string;
  choice: string;
  correct: boolean;
  /** Server-received epoch ms (the scoring anchor). */
  submittedAt: number;
  latencyMs?: number;
}

/**
 * Idempotent answer write (FR-10, D10): conditional PutItem on
 * attribute_not_exists(sk). Returns `{ accepted:false }` when the player has
 * already answered this round — the second write never overwrites the first.
 */
export async function submitAnswer(input: SubmitAnswerInput): Promise<{ accepted: boolean }> {
  const item: Answer = {
    gameId: input.gameId,
    sk: answerSk(input.questionIndex, input.playerId),
    questionId: input.questionId,
    playerId: input.playerId,
    choice: input.choice,
    correct: input.correct,
    submittedAt: input.submittedAt,
    latencyMs: input.latencyMs,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: tables.answers,
        Item: item,
        ConditionExpression: 'attribute_not_exists(sk)',
      }),
    );
    return { accepted: true };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return { accepted: false };
    }
    throw err;
  }
}

/** All answers for one round (used at round close for scoring). */
export async function listRoundAnswers(
  gameId: string,
  questionIndex: number,
): Promise<Answer[]> {
  const items: Answer[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tables.answers,
        KeyConditionExpression: 'gameId = :g AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':g': gameId, ':p': roundSkPrefix(questionIndex) },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...((res.Items as Answer[] | undefined) ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/** Look up one player's answer for a round (idempotency / self-status checks). */
export async function listAllForGame(gameId: string): Promise<Answer[]> {
  const items: Answer[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tables.answers,
        KeyConditionExpression: 'gameId = :g',
        ExpressionAttributeValues: { ':g': gameId },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...((res.Items as Answer[] | undefined) ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/** Cascade helper: delete every answer of a game. */
export async function deleteAllForGame(gameId: string): Promise<void> {
  const answers = await listAllForGame(gameId);
  for (let i = 0; i < answers.length; i += 25) {
    const chunk = answers.slice(i, i + 25);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [tables.answers]: chunk.map((a) => ({
            DeleteRequest: { Key: { gameId: a.gameId, sk: a.sk } },
          })),
        },
      }),
    );
  }
}
