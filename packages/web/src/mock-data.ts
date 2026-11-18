import type { LeaderboardEntry, PublicGameState, Question, QuestionSet } from '@serverlessq/shared';

const demoQuestionSetId = 'qs-aws-trivia-sample';

export const demoQuestionSets: QuestionSet[] = [
  {
    questionSetId: demoQuestionSetId,
    name: 'AWS Trivia Sample',
    description: 'Sample questions for AWS trivia.',
    createdAt: Date.now(),
  },
];

export const demoLeaderboard: LeaderboardEntry[] = [
  { name: 'Lambda Legend', points: 780, streak: 4 },
  { name: 'Event Source', points: 735, streak: 2 },
  { name: 'Cold Starter', points: 690, streak: 3 },
  { name: 'Global Tabler', points: 625, streak: 1 },
  { name: 'Route Fifty-3', points: 590, streak: 0 },
];

export const demoGame: PublicGameState = {
  gameId: 'aws-trivia-sample',
  status: 'IN_ROUND',
  questionIndex: 2,
  playerCount: 247,
  questionCount: 8,
  questionDurationSec: 45,
  endsAt: Date.now() + 38_000,
  question: {
    questionId: 'q-concurrency',
    text: 'How many concurrent requests can one Lambda Web Functions sandbox serve?',
    choices: ['1', '16', '64', 'Up to 128'],
  },
};

export const demoQuestions: Question[] = [
  {
    questionId: 'q-runtime',
    questionSetId: demoQuestionSetId,
    text: 'Which runtime powers Lambda Web Functions?',
    choices: ['Node.js 20', 'Node.js 22', 'Node.js 24', 'Any container runtime'],
    correctChoice: 'Node.js 24',
    category: 'Lambda Web Functions',
    tags: ['runtime'],
    createdAt: Date.now(),
  },
  {
    questionId: 'q-streaming',
    questionSetId: demoQuestionSetId,
    text: 'Which protocol streams the live leaderboard?',
    choices: ['WebSocket', 'SSE', 'MQTT', 'Long polling only'],
    correctChoice: 'SSE',
    category: 'Real-time',
    tags: ['streaming'],
    createdAt: Date.now(),
  },
];
