import { z } from 'zod';

/** Player join body (name refined further by validateName — FR-4). */
export const joinSchema = z.object({
  name: z.string().min(1).max(200),
});

/** Answer submission body (FR-10). */
export const answerSchema = z.object({
  playerId: z.string().min(1).max(128),
  choice: z.string().min(1).max(200),
});

/**
 * Admin create-game body: curated ids OR filtered-random selection (DD-5a).
 *
 * The random path names the question set it draws from — a random game always
 * comes out of exactly one set, never the union of every set in the table.
 */
export const createGameSchema = z
  .object({
    name: z.string().trim().max(100).optional(),
    questionDurationSec: z.number().int().positive().max(600).optional(),
    activate: z.boolean().optional(),
    questionIds: z.array(z.string().min(1)).min(1).optional(),
    selection: z
      .object({
        questionSetId: z.string().min(1),
        categories: z.array(z.string().min(1)).optional(),
        count: z.number().int().positive().max(100),
        shuffle: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((v) => Boolean(v.questionIds) !== Boolean(v.selection), {
    message: 'Provide exactly one of `questionIds` or `selection`.',
  });

/** Admin question-set create/update body (FR-19a). */
export const questionSetSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
});

/** Admin question create/update body: ≥2 choices, correct must be one of them (FR-19). */
export const questionSchema = z
  .object({
    questionSetId: z.string().min(1),
    text: z.string().min(1),
    choices: z.array(z.string().min(1).max(200)).min(2),
    correctChoice: z.string().min(1).max(200),
    category: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .refine((v) => v.choices.includes(v.correctChoice), {
    message: '`correctChoice` must be one of `choices`.',
  })
  .refine((v) => new Set(v.choices).size === v.choices.length, {
    message: '`choices` must be unique.',
  });

export type JoinBody = z.infer<typeof joinSchema>;
export type AnswerBody = z.infer<typeof answerSchema>;
export type CreateGameBody = z.infer<typeof createGameSchema>;
export type QuestionSetBody = z.infer<typeof questionSetSchema>;
export type QuestionBody = z.infer<typeof questionSchema>;
