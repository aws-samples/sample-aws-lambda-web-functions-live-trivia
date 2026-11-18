import { questionsRepo, type Game, type PublicGameState } from '@serverlessq/shared';

/**
 * Build the public game-state DTO (design §5.2). Resolves the current question
 * while a round is live or revealed. `correctChoice` is included only at
 * REVEAL/FINISHED — never while the round is open (US-B3).
 */
export async function resolvePublicGameState(game: Game): Promise<PublicGameState> {
  const state: PublicGameState = {
    gameId: game.gameId,
    ...(game.name ? { name: game.name } : {}),
    status: game.status,
    questionIndex: game.currentIndex,
    // Read straight off the game item — no extra query on the SSE tick path.
    playerCount: game.participantCount ?? 0,
    questionCount: game.questionIds.length,
    questionDurationSec: game.questionDurationSec,
  };

  if (game.status === 'IN_ROUND' || game.status === 'REVEAL') {
    const questionId = game.questionIds[game.currentIndex];
    if (questionId) {
      const q = await questionsRepo.getQuestion(questionId);
      if (q) {
        state.question = { questionId: q.questionId, text: q.text, choices: q.choices };
        if (game.status === 'IN_ROUND' && game.currentStartedAt !== undefined) {
          state.endsAt = game.currentStartedAt + game.questionDurationSec * 1000;
        }
        if (game.status === 'REVEAL') {
          state.correctChoice = q.correctChoice;
        }
      }
    }
  }

  return state;
}
