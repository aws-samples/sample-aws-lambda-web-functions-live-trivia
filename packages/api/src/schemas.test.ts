import { describe, it, expect } from 'vitest';
import { answerSchema, createGameSchema, questionSchema, questionSetSchema } from './schemas.ts';

describe('answerSchema', () => {
  it('bounds the player identifier and submitted choice', () => {
    expect(answerSchema.safeParse({ playerId: 'p'.repeat(128), choice: 'c'.repeat(200) }).success).toBe(
      true,
    );
    expect(answerSchema.safeParse({ playerId: 'p'.repeat(129), choice: 'A' }).success).toBe(false);
    expect(answerSchema.safeParse({ playerId: 'p1', choice: 'c'.repeat(201) }).success).toBe(false);
  });
});

describe('questionSetSchema', () => {
  it('accepts a named set with an optional description', () => {
    expect(questionSetSchema.safeParse({ name: 'AWS Trivia Sample' }).success).toBe(
      true,
    );
    expect(questionSetSchema.safeParse({ name: 'Warm-up', description: 'Easy ones' }).success).toBe(
      true,
    );
  });

  it('rejects a set with no name — the name is the whole handle on it', () => {
    expect(questionSetSchema.safeParse({}).success).toBe(false);
    expect(questionSetSchema.safeParse({ name: '' }).success).toBe(false);
  });
});

describe('questionSchema', () => {
  const question = {
    questionSetId: 'set-1',
    text: 'Which runtime do Lambda Web Functions use?',
    choices: ['nodejs20.x', 'nodejs24.x'],
    correctChoice: 'nodejs24.x',
  };

  it('accepts a question that names its owning set', () => {
    expect(questionSchema.safeParse(question).success).toBe(true);
  });

  it('rejects a question with no set, so none can be stranded outside a container', () => {
    const { questionSetId: _omitted, ...orphan } = question;
    expect(questionSchema.safeParse(orphan).success).toBe(false);
  });
});

describe('createGameSchema', () => {
  it('accepts and trims an optional game name', () => {
    const parsed = createGameSchema.parse({
      name: '  Team trivia  ',
      questionIds: ['q1'],
    });
    expect(parsed.name).toBe('Team trivia');
  });

  it.each(['', '   '])('accepts a blank name (%j) for automatic naming', (name) => {
    expect(createGameSchema.parse({ name, questionIds: ['q1'] }).name).toBe('');
  });

  it('rejects invalid or oversized names', () => {
    expect(createGameSchema.safeParse({ name: 123, questionIds: ['q1'] }).success).toBe(false);
    expect(createGameSchema.safeParse({ name: 'x'.repeat(101), questionIds: ['q1'] }).success).toBe(
      false,
    );
    expect(createGameSchema.safeParse({ name: 'x'.repeat(100), questionIds: ['q1'] }).success).toBe(
      true,
    );
  });

  it('accepts a random draw scoped to one question set', () => {
    const parsed = createGameSchema.safeParse({
      selection: { questionSetId: 'set-1', count: 6, shuffle: true },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a random draw with no set — a game never spans every set at once', () => {
    expect(createGameSchema.safeParse({ selection: { count: 6 } }).success).toBe(false);
  });

  it('still accepts a curated snapshot, which carries its own ids', () => {
    expect(createGameSchema.safeParse({ questionIds: ['q1', 'q2'] }).success).toBe(true);
  });

  it('rejects both paths at once and neither path at all', () => {
    expect(
      createGameSchema.safeParse({
        questionIds: ['q1'],
        selection: { questionSetId: 'set-1', count: 2 },
      }).success,
    ).toBe(false);
    expect(createGameSchema.safeParse({ questionDurationSec: 20 }).success).toBe(false);
  });
});
