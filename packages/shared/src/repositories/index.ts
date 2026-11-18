// DynamoDB repositories, namespaced per table (design §3.3 / §4).
export { ddb } from './ddb.js';
export * as questionSetsRepo from './questionSets.js';
export * as questionsRepo from './questions.js';
export * as gamesRepo from './games.js';
export * as participantsRepo from './participants.js';
export * as answersRepo from './answers.js';
export * as scoresRepo from './scores.js';

export type { CreateQuestionSetInput } from './questionSets.js';
export type { CreateQuestionInput, ListQuestionsFilter } from './questions.js';
export type { CreateGameInput } from './games.js';
export type { SubmitAnswerInput } from './answers.js';
export type { ApplyRoundResultInput } from './scores.js';
export { roundSkPrefix, answerSk } from './answers.js';
