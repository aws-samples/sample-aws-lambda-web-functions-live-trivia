import {
  Badge,
  Box,
  Button,
  Container,
  Heading,
  HStack,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { ActiveGameSummary } from '@serverlessq/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { getActiveGames } from '@/api/client';

interface GamesPageProps {
  apiBaseUrl: string;
}

/** Directory refresh cadence. Slower than the in-game SSE tick — this list only
 *  changes when a host creates, starts, or ends a session. */
const REFRESH_MS = 5_000;

const statusCopy: Record<ActiveGameSummary['status'], string> = {
  LOBBY: 'Waiting to start',
  IN_ROUND: 'Question in play',
  REVEAL: 'Revealing answer',
  FINISHED: 'Ended',
};

/**
 * Public game directory at `/`.
 *
 * Several games run in parallel, so there is nothing to auto-resolve here — the
 * page lists them and each row carries its own gameId. A row links to
 * `/join/:gameId`, the exact URL that game's QR code encodes, so scanning and
 * tapping land on the same lobby. This is the fallback for anyone whose camera
 * will not cooperate.
 */
export function GamesPage({ apiBaseUrl }: GamesPageProps) {
  const [games, setGames] = useState<ActiveGameSummary[]>();
  const [error, setError] = useState<string>();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const body = await getActiveGames(apiBaseUrl, signal);
        if (!signal?.aborted) {
          setGames(body.games);
          setError(undefined);
        }
      } catch (loadError) {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
        setError(loadError instanceof Error ? loadError.message : 'Could not load games');
      }
    },
    [apiBaseUrl],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(controller.signal), REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);

  const joinable = games?.filter((game) => game.joinable) ?? [];
  const ended = games?.filter((game) => !game.joinable) ?? [];

  return (
    <Container maxW="4xl" py={{ base: '10', md: '16' }}>
      <Text className="eyebrow">LIVE TRIVIA</Text>
      <Heading as="h1" size={{ base: '3xl', md: '4xl' }} mt="2">
        Pick your game.
      </Heading>
      <Text color="fg.muted" mt="3">
        Scan the QR code on the screen at the front, or tap your session below.
      </Text>

      {games === undefined && !error && (
        <Box className="glass-panel loading-panel" mt="8">
          <Spinner color="orange.400" />
          <Text>Looking for live games…</Text>
        </Box>
      )}

      {error && (
        <Box className="glass-panel empty-state large-empty-state" mt="8">
          <Heading as="h2" size="xl">
            Could not load games
          </Heading>
          <Text className="form-error">{error}</Text>
          <Button mt="6" colorPalette="orange" onClick={() => void load()}>
            Try again
          </Button>
        </Box>
      )}

      {games !== undefined && games.length === 0 && (
        <Box className="glass-panel empty-state large-empty-state" mt="8">
          <Heading as="h2" size="2xl">
            No live games right now.
          </Heading>
          <Text color="fg.muted" mt="3">
            Sit tight — a host will open one shortly.
          </Text>
        </Box>
      )}

      {joinable.length > 0 && (
        <Stack gap="3" mt="8">
          {joinable.map((game) => (
            <RouterLink key={game.gameId} to={`/join/${game.gameId}`} className="game-row-link">
              <Box className="glass-panel game-row">
                <HStack justify="space-between" align="center" gap="4">
                  <Box minW="0">
                    <HStack gap="2" mb="2">
                      <Badge colorPalette={game.status === 'LOBBY' ? 'orange' : 'green'}>
                        {statusCopy[game.status]}
                      </Badge>
                      <Badge variant="outline">{game.questionCount} Q</Badge>
                    </HStack>
                    <Text fontWeight="semibold" fontSize="xl" overflowWrap="anywhere">
                      {game.name ?? `Game ${game.gameId.slice(0, 8)}`}
                    </Text>
                    <Text className="game-row-players">
                      {game.playerCount.toLocaleString()}{' '}
                      {game.playerCount === 1 ? 'player' : 'players'}
                    </Text>
                    {/* A short id also distinguishes games with the same name. */}
                    <Text className="game-row-id" title={game.gameId}>
                      #{game.gameId.slice(0, 8)}
                    </Text>
                  </Box>
                  <Text className="game-row-cta" aria-hidden="true">
                    Join →
                  </Text>
                </HStack>
              </Box>
            </RouterLink>
          ))}
        </Stack>
      )}

      {ended.length > 0 && (
        <Box mt="10">
          <Text className="eyebrow">RECENTLY ENDED</Text>
          <Stack gap="3" mt="3">
            {ended.map((game) => (
              <Box key={game.gameId} className="glass-panel game-row is-ended">
                <HStack justify="space-between" align="center" gap="4">
                  <Box minW="0">
                    <Badge colorPalette="gray" mb="2">
                      {statusCopy[game.status]}
                    </Badge>
                    <Text fontWeight="semibold" fontSize="xl" overflowWrap="anywhere">
                      {game.name ?? `Game ${game.gameId.slice(0, 8)}`}
                    </Text>
                    <Text className="game-row-players">
                      {game.playerCount.toLocaleString()}{' '}
                      {game.playerCount === 1 ? 'player' : 'players'}
                    </Text>
                    <Text className="game-row-id" title={game.gameId}>
                      #{game.gameId.slice(0, 8)}
                    </Text>
                  </Box>
                  <RouterLink to={`/leaderboard/${game.gameId}`} className="game-row-cta">
                    Results →
                  </RouterLink>
                </HStack>
              </Box>
            ))}
          </Stack>
        </Box>
      )}
    </Container>
  );
}
