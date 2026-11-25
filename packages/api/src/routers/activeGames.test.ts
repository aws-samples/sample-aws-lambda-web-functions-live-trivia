import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Shared from '@serverlessq/shared';
import type { ActiveGamesResponse, Game } from '@serverlessq/shared';

const listActiveGames = vi.hoisted(() => vi.fn());
vi.mock('@serverlessq/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
  return { ...actual, gamesRepo: { ...actual.gamesRepo, listActiveGames } };
});
vi.mock('../middleware/requestLog.ts', () => ({
  requestLog: ((_req, _res, next) => next()) satisfies RequestHandler,
}));

const { publicRouter } = await import('./public.ts');
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(publicRouter);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function toDirectory(games: Game[]): Promise<ActiveGamesResponse> {
  listActiveGames.mockResolvedValue(games);
  const response = await fetch(`${baseUrl}/api/games/active`);
  expect(response.status).toBe(200);
  return response.json() as Promise<ActiveGamesResponse>;
}

function game(overrides: Partial<Game> = {}): Game {
  return {
    gameId: 'g1',
    status: 'LOBBY',
    active: 'Y',
    questionIds: ['q1', 'q2'],
    currentIndex: 0,
    questionDurationSec: 20,
    createdAt: 1_000,
    ...overrides,
  };
}

describe('public game directory', () => {
  it('lists every concurrent game, newest first', async () => {
    const body = await toDirectory([
      game({ gameId: 'older', createdAt: 1_000 }),
      game({ gameId: 'newest', createdAt: 3_000 }),
      game({ gameId: 'middle', createdAt: 2_000 }),
    ]);

    // Parallel sessions are the point: none of these may be dropped.
    expect(body.games.map((g) => g.gameId)).toEqual(['newest', 'middle', 'older']);
  });

  it('marks a finished game unjoinable but still lists it', async () => {
    const body = await toDirectory([game({ gameId: 'done', status: 'FINISHED' })]);

    expect(body.games).toHaveLength(1);
    expect(body.games[0]).toMatchObject({ gameId: 'done', joinable: false });
  });

  it('treats in-flight phases as joinable, so latecomers can still get in', async () => {
    const body = await toDirectory([
      game({ gameId: 'lobby', status: 'LOBBY', createdAt: 3 }),
      game({ gameId: 'round', status: 'IN_ROUND', createdAt: 2 }),
      game({ gameId: 'reveal', status: 'REVEAL', createdAt: 1 }),
    ]);

    expect(body.games.every((g) => g.joinable)).toBe(true);
  });

  it('carries names for current games and still lists unnamed legacy games', async () => {
    const body = await toDirectory([
      game({ gameId: 'named', name: 'Team trivia', createdAt: 2 }),
      game({ gameId: 'legacy', createdAt: 1 }),
    ]);

    expect(body.games[0]).toMatchObject({ gameId: 'named', name: 'Team trivia' });
    expect(body.games[1]).toMatchObject({ gameId: 'legacy' });
    expect(body.games[1]).not.toHaveProperty('name');
  });

  it('carries the per-game counts the directory renders', async () => {
    const body = await toDirectory([
      game({ gameId: 'a', participantCount: 12, questionIds: ['q1', 'q2', 'q3'] }),
      // A game created before the join counter existed reports 0, not undefined.
      game({ gameId: 'b', createdAt: 0 }),
    ]);

    expect(body.games[0]).toMatchObject({ gameId: 'a', playerCount: 12, questionCount: 3 });
    expect(body.games[1]).toMatchObject({ gameId: 'b', playerCount: 0, questionCount: 2 });
  });
});
