import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import type { Game, QuestionSet } from '@serverlessq/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AdminGamesTable } from './AdminGamesTable';
import { getLatestGames } from '@/utils/games';

function game(overrides: Partial<Game> = {}): Game {
  return {
    gameId: 'g1',
    name: 'Team trivia',
    status: 'LOBBY',
    questionIds: ['q1'],
    currentIndex: 0,
    questionDurationSec: 20,
    createdAt: Date.UTC(2026, 9, 15, 10),
    ...overrides,
  };
}

function render(games: Game[], selectedGameId?: string, questionSets: QuestionSet[] = []) {
  const html = renderToStaticMarkup(
    createElement(ChakraProvider, {
      value: defaultSystem,
      children: createElement(AdminGamesTable, {
        games: getLatestGames(games),
        selectedGameId,
        questionSets,
        onSelectGame: vi.fn(),
      }),
    }),
  );
  return html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
}

describe('admin games table', () => {
  it('shows only the newest ten games, newest first, from an unordered response', () => {
    const games = Array.from({ length: 13 }, (_, index) =>
      game({ gameId: `g${index}`, name: `Session ${index}`, createdAt: index * 1000 }),
    );
    const unordered = [
      ...games.filter((_, index) => index % 2 === 0),
      ...games.filter((_, index) => index % 2 !== 0),
    ];
    const originalOrder = unordered.map((game) => game.gameId);

    const html = render(unordered);

    expect(html.match(/<tr\b/g)).toHaveLength(10);
    expect(
      [...html.matchAll(/aria-label="Select Session (\d+)"/g)].map((match) => match[1]),
    ).toEqual(['12', '11', '10', '9', '8', '7', '6', '5', '4', '3']);
    expect(unordered.map((game) => game.gameId)).toEqual(originalOrder);
  });

  it('marks the selected game and shows its name, set, listing, and creation time', () => {
    const selected = game({
      gameId: '12345678-1234-4567-89ab-123456789abc',
      questionSetId: 'set1',
      active: 'Y',
    });
    const html = render([selected], selected.gameId, [
      { questionSetId: 'set1', name: 'Warm-up questions', createdAt: 1 },
    ]);

    expect(html).toContain('class="is-selected"');
    expect(html).toMatch(/<input(?=[^>]*aria-label="Select Team trivia")(?=[^>]*checked="")[^>]*>/);
    expect(html).toContain('Team trivia');
    expect(html).toMatch(/<p[^>]*>12345678-1234-4567-89ab-123456789abc<\/p>/);
    expect(html).toContain('Warm-up questions');
    expect(html).toContain('LOBBY');
    expect(html).toContain('Listed');
    expect(html).toContain('<time dateTime="2026-10-15T10:00:00.000Z">');
  });

  it('supports fewer than ten games and older games without names or question sets', () => {
    const html = render([game({ gameId: 'legacy-game', name: undefined })]);

    expect(html.match(/<tr\b/g)).toHaveLength(1);
    expect(html).toContain('legacy-game');
    expect(html).toContain('aria-label="Select legacy-game"');
    expect(html).toContain('Unlisted');
    expect(html).not.toContain('is-selected');
  });
});
