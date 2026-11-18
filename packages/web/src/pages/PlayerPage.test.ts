import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import type { PublicGameState } from '@serverlessq/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const useLiveGame = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useLiveGame', () => ({ useLiveGame }));

const { PlayerPage } = await import('@/pages/PlayerPage');

function render(name?: string): string {
  const state: PublicGameState = {
    gameId: 'g1',
    name,
    status: 'LOBBY',
    questionIndex: 0,
    playerCount: 2,
    questionCount: 3,
    questionDurationSec: 20,
  };
  useLiveGame.mockReturnValue({
    activeGameId: state.gameId,
    gameState: state,
    leaderboard: { topN: [], updatedAt: 0 },
    loading: false,
    transport: 'sse',
    joining: false,
    join: vi.fn(),
  });
  return renderToStaticMarkup(
    createElement(ChakraProvider, {
      value: defaultSystem,
      children: createElement(
        MemoryRouter,
        { initialEntries: ['/join/g1'] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/join/:gameId',
            element: createElement(PlayerPage, { apiBaseUrl: 'https://api.example.test' }),
          }),
        ),
      ),
    }),
  );
}

describe('PlayerPage join screen', () => {
  it.each(['Team trivia', 'Sunny Otter 4821'])(
    'shows the game name %j before a player joins',
    (name) => {
      const html = render(name);

      expect(html).toContain(name);
      expect(html).toContain('Display name');
      expect(html).toContain('Join the game');
    },
  );

  it('identifies an unnamed legacy game by its short id', () => {
    const html = render();

    expect(html).toContain('Game g1');
    expect(html).toContain('Join the game');
  });
});
