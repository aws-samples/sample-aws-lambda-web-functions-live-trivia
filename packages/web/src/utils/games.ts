import type { Game } from '@serverlessq/shared';

export function getLatestGames(games: Game[]): Game[] {
  return games.toSorted((a, b) => b.createdAt - a.createdAt).slice(0, 10);
}
