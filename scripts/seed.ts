/**
 * Seed the question pool. Run against a target region/table prefix:
 *
 *   SERVERLESSQ_TABLE_PREFIX=dev- DDB_REGION=us-west-2 node scripts/seed.ts
 *
 * DDB_REGION falls back to your own AWS region; set it explicitly when that is
 * not the region the tables live in.
 *
 * Requires AWS credentials and existing DynamoDB tables (terraform apply).
 * Idempotent by question text — re-running skips existing questions and moves
 * older unassigned questions into the sample set.
 */
import { questionSetsRepo, questionsRepo, type CreateQuestionInput } from '@serverlessq/shared';

/** The set every seeded question lands in. Matched by exact name on re-runs. */
const QUESTION_SET_NAME = 'AWS Trivia Sample';
const QUESTION_SET_DESCRIPTION = 'Sample questions for AWS trivia.';

/** Seed questions, minus the set id — resolved at run time and applied to all. */
type SeedQuestion = Omit<CreateQuestionInput, 'questionSetId'>;

const QUESTIONS: SeedQuestion[] = [
  // ── AWS Lambda Web Functions trivia ───────────────────────────────────────
  {
    category: 'Web Functions',
    text: 'Which runtime do AWS Lambda Web Functions use?',
    choices: ['nodejs18.x', 'nodejs20.x', 'nodejs24.x', 'Any container image'],
    correctChoice: 'nodejs24.x',
    tags: ['aws', 'trivia'],
  },
  {
    category: 'Web Functions',
    text: 'What is the maximum per-request timeout for a Lambda Web Function?',
    choices: ['10 seconds', '30 seconds', '120 seconds', '900 seconds'],
    correctChoice: '900 seconds',
    tags: ['aws', 'trivia'],
  },
  {
    category: 'Web Functions',
    text: 'How many concurrent requests can a single sandbox serve?',
    choices: ['1', 'Up to 128', 'Up to 1000', 'Unlimited'],
    correctChoice: 'Up to 128',
    tags: ['aws', 'trivia'],
  },
  {
    category: 'Web Functions',
    text: 'Which one command deploys a Lambda Web Function?',
    choices: [
      'npx @aws/lambda-web deploy .',
      'aws lambda-web deploy',
      'sam deploy --guided',
      'aws lambda create-function',
    ],
    correctChoice: 'aws lambda-web deploy',
    tags: ['aws', 'trivia'],
  },
  {
    category: 'Web Functions',
    text: 'What HTTP mechanism streams live leaderboard updates in this app?',
    choices: ['WebSockets', 'Server-Sent Events (SSE)', 'gRPC', 'Long-poll only'],
    correctChoice: 'Server-Sent Events (SSE)',
    tags: ['aws', 'trivia'],
  },
  {
    category: 'Web Functions',
    text: 'Where does a Web Function read its bind host and port from?',
    choices: ['PORT', 'AWS_LAMBDA_HTTP_ENDPOINT', 'HTTP_HOST', 'localhost:3000'],
    correctChoice: 'AWS_LAMBDA_HTTP_ENDPOINT',
    tags: ['aws', 'trivia'],
  },
  {
    category: 'Web Functions',
    text: 'How much memory does a single Web Function sandbox have?',
    choices: ['128 MB', '512 MB', '1 GB', '2 GB'],
    correctChoice: '2 GB',
    tags: ['aws', 'trivia'],
  },
  // ── General trivia ───────────────────────────────────────────────────────
  {
    category: 'General',
    text: 'What does the "Q" in ServerlessQ stand for?',
    choices: ['Queue', 'Quiz', 'Query', 'Quorum'],
    correctChoice: 'Quiz',
    tags: ['warmup'],
  },
];

async function main(): Promise<void> {
  // Adopt the set if it is already there, so re-running never leaves two sets
  // with the same name and half the deck in each.
  const existingSet = await questionSetsRepo.findQuestionSetByName(QUESTION_SET_NAME);
  const questionSet =
    existingSet ??
    (await questionSetsRepo.createQuestionSet({
      name: QUESTION_SET_NAME,
      description: QUESTION_SET_DESCRIPTION,
    }));
  console.log(
    `${existingSet ? 'using' : 'created'} question set ${questionSet.questionSetId}: ${questionSet.name}\n`,
  );

  // Scan the whole pool, not just this set: a question seeded before question
  // sets existed carries no set id and would otherwise be invisible here,
  // re-created as a duplicate, and left stranded outside every container.
  const existing = await questionsRepo.listQuestions();
  const existingByText = new Map(existing.map((q) => [q.text, q]));

  let created = 0;
  let adopted = 0;
  let skipped = 0;
  for (const q of QUESTIONS) {
    const match = existingByText.get(q.text);
    if (match) {
      if (match.questionSetId === questionSet.questionSetId) {
        skipped++;
        console.log(`skip (exists): ${q.text}`);
      } else {
        await questionsRepo.replaceQuestion(match.questionId, {
          ...q,
          questionSetId: questionSet.questionSetId,
        });
        adopted++;
        console.log(`moved into set ${match.questionId}: ${q.text}`);
      }
      continue;
    }
    const saved = await questionsRepo.createQuestion({
      ...q,
      questionSetId: questionSet.questionSetId,
    });
    created++;
    console.log(`created ${saved.questionId}: ${saved.text}`);
  }
  console.log(`\nDone. ${created} created, ${adopted} moved into the set, ${skipped} skipped.`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
