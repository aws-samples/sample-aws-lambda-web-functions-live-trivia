import { Box, Container, Heading, HStack, Spinner, Text } from '@chakra-ui/react';
import { useParams } from 'react-router-dom';
import { LeaderboardTable } from '@/components/LeaderboardTable';
import { useLiveGame } from '@/hooks/useLiveGame';

interface LeaderboardPageProps {
  apiBaseUrl: string;
}

/** Standings for one game, scoped by `/leaderboard/:gameId` — never "the" active game. */
export function LeaderboardPage({ apiBaseUrl }: LeaderboardPageProps) {
  const { gameId = '' } = useParams<{ gameId: string }>();
  const live = useLiveGame(apiBaseUrl, gameId);
  const entries = live.leaderboard.topN;

  return (
    <Box className="leaderboard-page">
      <Container maxW="7xl" py={{ base: '10', md: '16' }}>
        <HStack
          justify="space-between"
          align="flex-start"
          gap="4"
          wrap="wrap"
          mb={{ base: '8', md: '12' }}
        >
          <Box minW="0">
            <Text className="eyebrow">
              {live.gameState
                ? `${live.gameState.status.replace('_', ' ')} · QUESTION ${live.gameState.questionIndex + 1}`
                : 'LIVE RESULTS'}
            </Text>
            <Heading as="h1" size={{ base: '3xl', md: '5xl' }} mt="2">
              Fast minds rise.
            </Heading>
            <Text color="fg.muted" mt="3">
              Rank scoring rewards every millisecond. Streaks turn up the heat.
            </Text>
          </Box>
          {live.loading ? (
            <Spinner color="orange.400" />
          ) : (
            <Box className="region-pill">{live.transport.toUpperCase()}</Box>
          )}
        </HStack>

        {/* Errors get their own panel. They used to be rendered as sub-text under
            the podium placeholder, which framed a real failure as "still waiting". */}
        {live.error && (
          <Box className="glass-panel empty-state" mb={{ base: '8', md: '12' }}>
            <Heading as="h2" size="md">
              Standings unavailable
            </Heading>
            <Text className="form-error" role="alert">
              {live.error}
            </Text>
          </Box>
        )}

        <Box>
          <LeaderboardTable
            entries={entries}
            title="Overall standings"
            transport={live.transport}
          />
        </Box>
      </Container>
    </Box>
  );
}
