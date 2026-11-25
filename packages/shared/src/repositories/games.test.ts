import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Game } from '../types.js';

const send = vi.hoisted(() => vi.fn());
vi.mock('./ddb.js', () => ({ ddb: { send } }));

const { createGame, getGame, listGames } = await import('./games.js');

const storedGames = new Map<string, Game>();

beforeEach(() => {
  storedGames.clear();
  send.mockReset().mockImplementation(async (command: unknown) => {
    if (command instanceof PutCommand) {
      const item = structuredClone(command.input.Item) as Game;
      storedGames.set(item.gameId, item);
      return {};
    }
    if (command instanceof GetCommand) {
      return { Item: storedGames.get(command.input.Key?.gameId as string) };
    }
    if (command instanceof ScanCommand) {
      return { Items: [...storedGames.values()] };
    }
    throw new Error('Unexpected DynamoDB command');
  });
});

describe('game names', () => {
  const input = { questionIds: ['q1'], questionDurationSec: 20, activate: false };

  it('persists a supplied name and returns it in game reads and the admin list', async () => {
    const created = await createGame({ ...input, name: '  Team trivia  ' });

    expect(created.name).toBe('Team trivia');
    expect(await getGame(created.gameId)).toMatchObject({ name: 'Team trivia' });
    expect(await listGames()).toEqual([created]);
  });

  it.each([undefined, '', '   ', '\n\t'])(
    'generates and persists a readable name when the name is %j',
    async (name) => {
      const created = await createGame({ ...input, name });

      expect(created.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ [1-9]\d{3}$/);
      expect(await getGame(created.gameId)).toMatchObject({ name: created.name });
      expect(await listGames()).toEqual([created]);
    },
  );

  it('can still read and list games created before names existed', async () => {
    const legacy: Game = {
      gameId: 'legacy',
      status: 'LOBBY',
      questionIds: ['q1'],
      currentIndex: 0,
      questionDurationSec: 20,
      createdAt: 1,
    };
    storedGames.set(legacy.gameId, legacy);

    expect(await getGame(legacy.gameId)).toEqual(legacy);
    expect(await listGames()).toEqual([legacy]);
  });
});
