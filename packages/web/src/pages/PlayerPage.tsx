import {
  Badge,
  Box,
  Button,
  Container,
  Flex,
  Heading,
  HStack,
  SimpleGrid,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Countdown } from '@/components/Countdown';
import { JoinForm } from '@/components/JoinForm';
import { LeaderboardTable } from '@/components/LeaderboardTable';
import { LobbyPanel } from '@/components/LobbyPanel';
import { useLiveGame } from '@/hooks/useLiveGame';

interface PlayerPageProps {
  apiBaseUrl: string;
}

export function PlayerPage({ apiBaseUrl }: PlayerPageProps) {
  // Always present: this page is only mounted at `/join/:gameId`, which react-router
  // will not match on an empty segment. The default keeps the type honest.
  const { gameId = '' } = useParams<{ gameId: string }>();
  const live = useLiveGame(apiBaseUrl, gameId);
  const [selectedChoice, setSelectedChoice] = useState<string>();

  useEffect(() => setSelectedChoice(undefined), [live.gameState?.question?.questionId]);

  if (live.loading && !live.gameState) {
    return (
      <Container maxW="7xl" py="20">
        <Box className="glass-panel loading-panel">
          <Spinner color="orange.400" />
          <Text>Finding the active game…</Text>
        </Box>
      </Container>
    );
  }

  if (!live.activeGameId || !live.gameState) {
    return (
      <Container maxW="3xl" py="20">
        <Box className="glass-panel empty-state large-empty-state">
          <Text className="eyebrow">LOBBY OFFLINE</Text>
          <Heading as="h1" size="3xl" mt="2">
            No active game yet.
          </Heading>
          <Text color="fg.muted" mt="3">
            The host is getting the next round ready. Try again in a moment.
          </Text>
          {live.error && <Text className="form-error">{live.error}</Text>}
          <Button mt="6" colorPalette="orange" onClick={() => void live.refresh()}>
            Check again
          </Button>
        </Box>
      </Container>
    );
  }

  const state = live.gameState;
  const inRound = state.status === 'IN_ROUND' && Boolean(state.question);
  const roundOpen = inRound && (!state.endsAt || state.endsAt > Date.now());
  const revealed = state.status === 'REVEAL';

  return (
    <>
      <Box className="hero-grid">
        <Container maxW="7xl" py={{ base: '10', md: '16' }}>
          <Text
            fontWeight="semibold"
            fontSize={{ base: 'xl', md: '2xl' }}
            mb="6"
            overflowWrap="anywhere"
          >
            {state.name ?? `Game ${state.gameId.slice(0, 8)}`}
          </Text>
          <SimpleGrid
            columns={{ base: 1, lg: 2 }}
            gap={{ base: '8', lg: '12' }}
            alignItems="center"
          >
            {live.player ? (
              <Box className="glass-panel join-card">
                <Text className="eyebrow">YOU'RE IN</Text>
                <Heading as="h1" size="3xl" mt="2">
                  {live.player.name}
                </Heading>
                <SimpleGrid columns={2} gap="3" mt="7">
                  <Box className="metric-tile">
                    <Text className="metric-value">{live.player.points.toLocaleString()}</Text>
                    <Text fontSize="xs" color="fg.muted">
                      Points
                    </Text>
                  </Box>
                  <Box className="metric-tile">
                    <Text className="metric-value">
                      {live.player.streak >= 3 ? '🔥 ' : ''}
                      {live.player.streak}
                    </Text>
                    <Text fontSize="xs" color="fg.muted">
                      Current streak
                    </Text>
                  </Box>
                </SimpleGrid>
                <Text color="fg.muted" mt="6" fontSize="sm">
                  Your identity is saved on this device so a refresh returns you to the game.
                </Text>
                <Button mt="5" size="sm" variant="ghost" onClick={live.forgetPlayer}>
                  Join as someone else
                </Button>
              </Box>
            ) : (
              <JoinForm onJoin={live.join} busy={live.joining} error={live.error} />
            )}

            {state.status === 'LOBBY' ? (
              <LobbyPanel
                playerCount={state.playerCount}
                questionCount={state.questionCount}
                joined={Boolean(live.player)}
                transport={live.transport}
              />
            ) : (
              <Box className="glass-panel question-card">
                <Flex justify="space-between" align="flex-start" gap="4">
                  <Box>
                    <HStack gap="2" mb="3">
                      <Badge colorPalette="orange">QUESTION {state.questionIndex + 1}</Badge>
                      <Badge variant="outline">{state.status.replace('_', ' ')}</Badge>
                    </HStack>
                    <Text className="eyebrow">LAMBDA WEB FUNCTIONS</Text>
                  </Box>
                  {inRound && state.endsAt && (
                    <Countdown endsAt={state.endsAt} durationSeconds={state.questionDurationSec} />
                  )}
                </Flex>

                {state.status === 'FINISHED' && (
                  <Box className="empty-state question-empty">
                    <Heading as="h2" size="2xl">
                      That's the game!
                    </Heading>
                    <Text color="fg.muted" mt="2">
                      Check the final leaderboard to see who came out on top.
                    </Text>
                  </Box>
                )}

                {state.question && (
                  <>
                    <Heading as="h2" size={{ base: 'xl', md: '2xl' }} mt="5" lineHeight="1.25">
                      {state.question.text}
                    </Heading>

                    <Stack gap="3" mt="7">
                      {state.question.choices.map((choice, index) => {
                        const isCorrect = revealed && state.correctChoice === choice;
                        return (
                          <Button
                            key={choice}
                            type="button"
                            variant={selectedChoice === choice || isCorrect ? 'solid' : 'outline'}
                            colorPalette={
                              isCorrect ? 'green' : selectedChoice === choice ? 'orange' : 'gray'
                            }
                            size="lg"
                            className="answer-choice"
                            disabled={!roundOpen || live.answerState === 'accepted'}
                            onClick={() => setSelectedChoice(choice)}
                          >
                            <span className="choice-key">{String.fromCharCode(65 + index)}</span>
                            <span>{choice}</span>
                          </Button>
                        );
                      })}
                    </Stack>

                    <Flex justify="space-between" align="center" gap="4" wrap="wrap" mt="6">
                      <Text fontSize="sm" color={live.error ? 'red.300' : 'fg.muted'}>
                        {live.error ??
                          (live.answerState === 'accepted'
                            ? 'Answer locked. Watch the leaderboard!'
                            : revealed
                              ? `Correct answer: ${state.correctChoice ?? 'revealing…'}`
                              : live.player
                                ? `Playing as ${live.player.name}`
                                : 'Join first to submit your answer')}
                      </Text>
                      {inRound && (
                        <Button
                          type="button"
                          colorPalette="orange"
                          disabled={
                            !roundOpen ||
                            !live.player ||
                            !selectedChoice ||
                            live.answerState === 'submitting' ||
                            live.answerState === 'accepted'
                          }
                          onClick={() => {
                            if (selectedChoice)
                              void live.answer(selectedChoice).catch(() => undefined);
                          }}
                        >
                          {live.answerState === 'submitting'
                            ? 'Submitting…'
                            : live.answerState === 'accepted'
                              ? 'Answer locked'
                              : 'Lock answer'}
                        </Button>
                      )}
                    </Flex>
                  </>
                )}
              </Box>
            )}
          </SimpleGrid>
        </Container>
      </Box>

      <Container maxW="7xl" pb={{ base: '12', md: '20' }}>
        <LeaderboardTable entries={live.leaderboard.topN} transport={live.transport} />
      </Container>
    </>
  );
}
