import type { Game, QuestionSet } from '@serverlessq/shared';
import { Badge, Box, Text } from '@chakra-ui/react';

interface AdminGamesTableProps {
  games: Game[];
  questionSets: QuestionSet[];
  selectedGameId?: string;
  onSelectGame: (gameId: string) => void;
}

export function AdminGamesTable({
  games,
  questionSets,
  selectedGameId,
  onSelectGame,
}: AdminGamesTableProps) {
  return (
    <Box overflowX="auto" mt="4">
      <table className="leaderboard-table admin-games-table" aria-label="Latest games">
        <thead>
          <tr>
            <th scope="col">Select</th>
            <th scope="col">Game</th>
            <th scope="col">Status</th>
            <th scope="col">Question set</th>
            <th scope="col">Public listing</th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {games.map((game) => {
            const questionSet = questionSets.find(
              (set) => set.questionSetId === game.questionSetId,
            );
            const created = new Date(game.createdAt);
            const selected = game.gameId === selectedGameId;
            return (
              <tr
                key={game.gameId}
                className={selected ? 'is-selected' : undefined}
                onClick={() => onSelectGame(game.gameId)}
              >
                <td>
                  <input
                    type="radio"
                    name="selected-game"
                    aria-label={`Select ${game.name ?? game.gameId}`}
                    checked={selected}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => onSelectGame(game.gameId)}
                  />
                </td>
                <td>
                  <Text fontWeight="semibold" overflowWrap="anywhere">
                    {game.name ?? game.gameId}
                  </Text>
                  {game.name && (
                    <Text
                      fontSize="calc(1em - 2px)"
                      color="fg.muted"
                      overflowWrap="anywhere"
                      mt="1"
                    >
                      {game.gameId}
                    </Text>
                  )}
                </td>
                <td>
                  <Badge
                    colorPalette={
                      game.status === 'LOBBY'
                        ? 'orange'
                        : game.status === 'FINISHED'
                          ? 'gray'
                          : 'green'
                    }
                    variant="subtle"
                  >
                    {game.status.replace('_', ' ')}
                  </Badge>
                </td>
                <td>{questionSet?.name ?? '—'}</td>
                <td>
                  <Badge colorPalette={game.active === 'Y' ? 'green' : 'gray'} variant="outline">
                    {game.active === 'Y' ? 'Listed' : 'Unlisted'}
                  </Badge>
                </td>
                <td>
                  <time dateTime={created.toISOString()}>
                    {created.toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Box>
  );
}
