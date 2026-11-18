import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import type { PublicGameState } from '@serverlessq/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QuestionStage } from '@/components/QuestionStage';

/**
 * The projected board is the one surface the whole room can read at once, so the
 * "answer withheld until REVEAL" rule (US-B3) has to hold in the markup, not just
 * in the payload. Static server rendering is enough — no DOM, no jsdom dependency;
 * these assertions are about what the room sees, not about interaction.
 */
function render(state: PublicGameState): string {
  return renderToStaticMarkup(
    createElement(ChakraProvider, {
      value: defaultSystem,
      children: createElement(QuestionStage, { state }),
    }),
  );
}

function state(overrides: Partial<PublicGameState> = {}): PublicGameState {
  return {
    gameId: 'g1',
    status: 'IN_ROUND',
    questionIndex: 1,
    playerCount: 12,
    questionCount: 5,
    questionDurationSec: 20,
    question: {
      questionId: 'q2',
      text: 'Which runtime powers Lambda Web Functions?',
      choices: ['Node.js 20', 'Node.js 24'],
    },
    endsAt: Date.now() + 10_000,
    ...overrides,
  };
}

describe('QuestionStage — projected question board', () => {
  it('shows the question, its lettered choices, and the countdown while the round is open', () => {
    const html = render(state());

    expect(html).toContain('Which runtime powers Lambda Web Functions?');
    expect(html).toContain('Node.js 24');
    expect(html).toContain('QUESTION 2 OF 5');
    expect(html).toContain('countdown');
    // Nothing is highlighted while the round is open.
    expect(html).not.toContain('is-correct');
  });

  it('highlights the correct choice at REVEAL and drops the dial', () => {
    const html = render(
      state({ status: 'REVEAL', endsAt: undefined, correctChoice: 'Node.js 24' }),
    );

    expect(html).toContain('is-correct');
    // The highlight must not rely on colour alone.
    expect(html).toContain('correct answer');
    // A dial frozen at zero reads as a broken screen.
    expect(html).not.toContain('countdown');
  });

  it('renders no board before the question has arrived on the stream', () => {
    // The phase can flip a tick before `question` resolves, and half a board on a
    // projector reads as a bug. (Chakra still emits its global <style> tags here,
    // so this asserts on the board markup rather than an empty string.)
    expect(render(state({ question: undefined }))).not.toContain('question-stage');
  });
});
