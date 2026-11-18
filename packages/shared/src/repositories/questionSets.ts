import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { tables } from '../config.js';
import type { QuestionSet } from '../types.js';

export interface CreateQuestionSetInput {
  name: string;
  description?: string;
}

/** Create a named container for questions. Names are not enforced unique. */
export async function createQuestionSet(input: CreateQuestionSetInput): Promise<QuestionSet> {
  const questionSet: QuestionSet = {
    questionSetId: randomUUID(),
    name: input.name,
    description: input.description,
    createdAt: Date.now(),
  };
  await ddb.send(new PutCommand({ TableName: tables.questionSets, Item: questionSet }));
  return questionSet;
}

export async function getQuestionSet(questionSetId: string): Promise<QuestionSet | null> {
  const res = await ddb.send(
    new GetCommand({ TableName: tables.questionSets, Key: { questionSetId } }),
  );
  return (res.Item as QuestionSet | undefined) ?? null;
}

/** Every set, oldest first — a handful of admin-owned rows, so a scan is fine. */
export async function listQuestionSets(): Promise<QuestionSet[]> {
  const res = await ddb.send(new ScanCommand({ TableName: tables.questionSets }));
  const items = (res.Items as QuestionSet[] | undefined) ?? [];
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Resolve a set by exact name. Used by the seed script so re-running it adopts
 * the existing set instead of creating a second one with the same name.
 */
export async function findQuestionSetByName(name: string): Promise<QuestionSet | null> {
  const sets = await listQuestionSets();
  return sets.find((set) => set.name === name) ?? null;
}

/** Full replace (PUT semantics), preserving the id and original createdAt. */
export async function replaceQuestionSet(
  questionSetId: string,
  input: CreateQuestionSetInput,
): Promise<QuestionSet | null> {
  const existing = await getQuestionSet(questionSetId);
  if (!existing) return null;
  const updated: QuestionSet = {
    ...existing,
    name: input.name,
    description: input.description,
  };
  await ddb.send(new PutCommand({ TableName: tables.questionSets, Item: updated }));
  return updated;
}

/**
 * Delete the container only — never its questions.
 *
 * The caller checks emptiness first (admin router returns 409 otherwise), so a
 * cascade here would be a second, silent deletion path for content the host may
 * still want. Games are unaffected either way: their `questionIds` snapshot is
 * frozen at create time.
 */
export async function deleteQuestionSet(questionSetId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: tables.questionSets, Key: { questionSetId } }));
}
