import { randomUUID } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { tables, indexes } from '../config.js';
import type { Question } from '../types.js';

export interface CreateQuestionInput {
  /** Owning set — required, so no question can be stranded outside a container. */
  questionSetId: string;
  text: string;
  choices: string[];
  correctChoice: string;
  category?: string;
  tags?: string[];
}

/** Filters for `listQuestions`. Both are optional and compose. */
export interface ListQuestionsFilter {
  questionSetId?: string;
  category?: string;
}

/** Create a pool question. Caller must validate ≥2 choices / exactly one correct (FR-19). */
export async function createQuestion(input: CreateQuestionInput): Promise<Question> {
  const question: Question = {
    questionId: randomUUID(),
    questionSetId: input.questionSetId,
    text: input.text,
    choices: input.choices,
    correctChoice: input.correctChoice,
    category: input.category,
    tags: input.tags,
    createdAt: Date.now(),
  };
  await ddb.send(new PutCommand({ TableName: tables.questions, Item: question }));
  return question;
}

export async function getQuestion(questionId: string): Promise<Question | null> {
  const res = await ddb.send(new GetCommand({ TableName: tables.questions, Key: { questionId } }));
  return (res.Item as Question | undefined) ?? null;
}

/**
 * List the pool, narrowed by set and/or category.
 *
 * A set is the more selective filter and the one every caller that matters
 * supplies, so it drives the query (question-set-index) and category is applied
 * as a filter on top. With only a category, the category-index still serves the
 * old cross-set lookup. With neither, the full pool is scanned — admin-only,
 * prep-time, and small.
 */
export async function listQuestions(filter: ListQuestionsFilter = {}): Promise<Question[]> {
  const { questionSetId, category } = filter;

  if (questionSetId) {
    const items: Question[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(
        new QueryCommand({
          TableName: tables.questions,
          IndexName: indexes.questionSetIndex,
          KeyConditionExpression: 'questionSetId = :s',
          ...(category
            ? {
                FilterExpression: 'category = :c',
                ExpressionAttributeValues: { ':s': questionSetId, ':c': category },
              }
            : { ExpressionAttributeValues: { ':s': questionSetId } }),
          ExclusiveStartKey: lastKey,
        }),
      );
      items.push(...((res.Items as Question[] | undefined) ?? []));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return items;
  }

  if (category) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: tables.questions,
        IndexName: indexes.categoryIndex,
        KeyConditionExpression: 'category = :c',
        ExpressionAttributeValues: { ':c': category },
      }),
    );
    return (res.Items as Question[] | undefined) ?? [];
  }

  // Full pool is small; a scan is acceptable here (admin-only, prep-time).
  const res = await ddb.send(new ScanCommand({ TableName: tables.questions }));
  return (res.Items as Question[] | undefined) ?? [];
}

/** Full replace (PUT semantics), preserving the id and original createdAt. */
export async function replaceQuestion(
  questionId: string,
  input: CreateQuestionInput,
): Promise<Question | null> {
  const existing = await getQuestion(questionId);
  if (!existing) return null;
  const updated: Question = {
    ...existing,
    questionSetId: input.questionSetId,
    text: input.text,
    choices: input.choices,
    correctChoice: input.correctChoice,
    category: input.category,
    tags: input.tags,
  };
  await ddb.send(new PutCommand({ TableName: tables.questions, Item: updated }));
  return updated;
}

export async function deleteQuestion(questionId: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: tables.questions, Key: { questionId } }));
}

/**
 * Pick `count` question ids for a new game snapshot (DD-5a), drawn from one
 * question set. When `categories` is given, samples across those categories
 * within the set; otherwise samples the whole set. Shuffled without repeats
 * (Fisher–Yates).
 */
export async function selectQuestionIds(opts: {
  questionSetId: string;
  count: number;
  categories?: string[];
  shuffle?: boolean;
}): Promise<string[]> {
  let pool: Question[];
  if (opts.categories && opts.categories.length > 0) {
    const perCategory = await Promise.all(
      opts.categories.map((category) =>
        listQuestions({ questionSetId: opts.questionSetId, category }),
      ),
    );
    pool = perCategory.flat();
  } else {
    pool = await listQuestions({ questionSetId: opts.questionSetId });
  }

  const ids = pool.map((q) => q.questionId);
  if (opts.shuffle !== false) {
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
  }
  return ids.slice(0, opts.count);
}
