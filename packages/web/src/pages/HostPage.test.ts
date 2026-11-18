import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import type { LeaderboardSnapshot, PublicGameState } from '@serverlessq/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// HostPage builds the join URL from the browser's own origin, so the projector
// always points at the host serving it. Static rendering has no window.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    value: { location: { origin: 'https://web.example.test' } },
    configurable: true,
    writable: true,
  });
});
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

const useLiveGame = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useLiveGame', () => ({ useLiveGame }));

const { HostPage } = await import('@/pages/HostPage');

const leaderboard: LeaderboardSnapshot = {
  topN: [
    { name: 'Jan', points: 375, streak: 3 },
    { name: 'Fab', points: 100, streak: 0 },
  ],
  updatedAt: 1,
};

function state(overrides: Partial<PublicGameState> = {}): PublicGameState {
  return {
    gameId: 'g1',
    status: 'LOBBY',
    questionIndex: 0,
    playerCount: 2,
    questionCount: 3,
    questionDurationSec: 20,
    ...overrides,
  };
}

function render(gameState: PublicGameState): string {
  useLiveGame.mockReturnValue({
    activeGameId: gameState.gameId,
    gameState,
    leaderboard,
    loading: false,
    transport: 'sse',
    refresh: vi.fn(),
  });
  return renderToStaticMarkup(
    createElement(ChakraProvider, {
      value: defaultSystem,
      children: createElement(
        MemoryRouter,
        { initialEntries: [`/host/${gameState.gameId}`] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/host/:gameId',
            element: createElement(HostPage, { apiBaseUrl: 'https://api.example.test' }),
          }),
        ),
      ),
    }),
  );
}

describe('HostPage — the projected screen', () => {
  it('leads with the join QR in the lobby', () => {
    const html = render(state());

    // JoinQr titles its SVG with the URL it encodes.
    expect(html).toContain('/join/g1');
    expect(html).toContain('Point your camera');
    expect(html).toContain('Game g1');
  });

  it('shows the game name on the join screen beside the QR code', () => {
    const html = render(state({ name: 'Sunny Otter 4821' }));

    expect(html).toContain('Sunny Otter 4821');
    expect(html).toContain('/join/g1');
    expect(html).toContain('Point your camera');
  });

  it('drops the QR once the game is FINISHED and shows the final standings', () => {
    const html = render(state({ status: 'FINISHED' }));

    // The whole point: a join code on a finished game invites the room to scan
    // into a lobby nobody can play.
    expect(html).not.toContain('/join/g1');
    expect(html).toContain('Final standings');
    expect(html).toContain('That’s a wrap.');
    expect(html).toContain('Jan');
  });

  it('keeps the QR as a rail while a round is on screen, for late joiners', () => {
    const html = render(
      state({
        name: 'Team trivia',
        status: 'IN_ROUND',
        endsAt: Date.now() + 10_000,
        question: { questionId: 'q1', text: 'Which runtime?', choices: ['20', '24'] },
      }),
    );

    expect(html).toContain('/join/g1');
    expect(html).toContain('Team trivia');
    expect(html).toContain('Which runtime?');
    // Top-3 strip rather than the full table while the question holds the screen.
    expect(html).not.toContain('Final standings');
  });
});
