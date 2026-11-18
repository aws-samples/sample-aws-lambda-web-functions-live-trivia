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
  Text,
} from '@chakra-ui/react';
import { useParams } from 'react-router-dom';
import { JoinQr } from '@/components/JoinQr';
import { LeaderboardTable } from '@/components/LeaderboardTable';
import { QuestionStage } from '@/components/QuestionStage';
import { TopScorers } from '@/components/TopScorers';
import { useLiveGame } from '@/hooks/useLiveGame';

interface HostPageProps {
  apiBaseUrl: string;
}

/**
 * The projected screen (the one on the big display behind the speaker).
 *
 * Always scoped to `/host/:gameId`. With parallel sessions there is no active game
 * to follow, and a screen that guessed could swap games out from under the room
 * mid-session. Opened from the admin console's "Join screen" button.
 *
 * It follows the game through its whole life on one URL, because nobody is going
 * to retype a URL on a projector mid-session:
 *
 *   LOBBY    → giant QR and a live join counter. Getting people in is the only job.
 *   IN_ROUND → the question, its choices, and the countdown. QR shrinks to a rail
 *              for late joiners; top 3 sits underneath.
 *   REVEAL   → same board with the correct choice highlighted.
 *   FINISHED → final standings in full.
 *
 * Every transition is driven by the SSE `state` frame the players are already
 * receiving, so the screen follows the host's clicks with no polling of its own —
 * and it flips to REVEAL even if the host never clicks, because the API closes a
 * due round on the read path: either the countdown expired, or every joined player
 * has answered. So the dial can disappear with time still on it; that is the game
 * ending early, not a rendering glitch.
 */
export function HostPage({ apiBaseUrl }: HostPageProps) {
  const { gameId = '' } = useParams<{ gameId: string }>();
  const live = useLiveGame(apiBaseUrl, gameId);

  if (live.loading && !live.gameState) {
    return (
      <Container maxW="7xl" py="24">
        <Box className="glass-panel loading-panel">
          <Spinner color="orange.400" />
          <Text>Finding the game to display…</Text>
        </Box>
      </Container>
    );
  }

  if (!live.activeGameId || !live.gameState) {
    return (
      <Container maxW="3xl" py="24">
        <Box className="glass-panel empty-state large-empty-state">
          <Text className="eyebrow">NOTHING TO DISPLAY</Text>
          <Heading as="h1" size="3xl" mt="2">
            No active game.
          </Heading>
          <Text color="fg.muted" mt="3">
            Create a game in the admin console, then bring this screen back up.
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
  // Built from the browser's own origin: the QR has to point at the web host the
  // audience can reach, which is exactly the origin serving this page. Nothing
  // to configure per environment, and it stays correct behind any endpoint.
  const joinUrl = `${window.location.origin}/join/${state.gameId}`;
  const open = state.status === 'LOBBY';
  const finished = state.status === 'FINISHED';
  // A round is on screen only once the question itself has arrived — the phase can
  // flip on the tick before `question` resolves, and half a board looks broken.
  const playing = (state.status === 'IN_ROUND' || state.status === 'REVEAL') && !!state.question;
  const players = state.playerCount;
  const connected = live.transport === 'sse' || live.transport === 'polling';
  // Same SSE stream as the join counter, already scoped to this game — the
  // standings below are this game's only, never a cross-game total.
  const entries = live.leaderboard.topN;

  const transportLine = (
    <HStack gap="2">
      {connected && <span className="live-dot" />}
      <Text fontSize="sm" color="fg.subtle">
        {live.transport === 'sse'
          ? 'Live over SSE'
          : live.transport === 'polling'
            ? 'Live over polling fallback'
            : 'Connecting…'}
      </Text>
    </HStack>
  );

  if (playing) {
    return (
      <>
        <Box className="hero-grid">
          <Container maxW="8xl" py={{ base: '6', md: '10' }}>
            <Flex
              direction={{ base: 'column', xl: 'row' }}
              gap={{ base: '6', xl: '10' }}
              align="stretch"
            >
              <Box flex="1" minW="0">
                <QuestionStage state={state} />
              </Box>

              {/* The code stays on screen all game: someone always scans late, and
                  a rail is enough once the question has earned the room's attention. */}
              <Box className="host-rail">
                <Box className="glass-panel host-rail-card">
                  <Text className="eyebrow">JOIN ANY TIME</Text>
                  <Text fontWeight="semibold" fontSize="xl" mt="2" overflowWrap="anywhere">
                    {state.name ?? `Game ${state.gameId.slice(0, 8)}`}
                  </Text>
                  <Box mt="4">
                    <JoinQr url={joinUrl} size={260} showUrl={false} />
                  </Box>
                  <Box className="host-count" mt="5">
                    <Text className="host-count-value host-count-value-sm">
                      {players.toLocaleString()}
                    </Text>
                    <Text className="host-count-label">
                      {players === 1 ? 'player' : 'players'} joined
                    </Text>
                  </Box>
                  <Box mt="4">{transportLine}</Box>
                </Box>
              </Box>
            </Flex>
          </Container>
        </Box>

        <Container maxW="8xl" pb={{ base: '10', md: '16' }}>
          <TopScorers entries={entries} transport={live.transport} />
        </Container>
      </>
    );
  }

  // An empty table on a projector is just noise, so the standings stay hidden
  // until there is something to rank.
  const showStandings = entries.length > 0;

  // FINISHED: no QR. The game is over, so a join code is an invitation to a game
  // nobody can join — it would sit there inviting the room to scan into a
  // finished lobby while the result is what everyone is actually looking at.
  // Single column, so the final standings get the whole screen.
  if (finished) {
    return (
      <>
        <Box className="hero-grid">
          <Container maxW="7xl" py={{ base: '8', md: '12' }}>
            <Box className="glass-panel host-panel host-final">
              <HStack gap="2" mb="4" justify="center">
                <Badge colorPalette="gray">FINISHED</Badge>
                <Badge variant="outline">
                  {state.questionCount} QUESTION{state.questionCount === 1 ? '' : 'S'}
                </Badge>
              </HStack>

              <Text className="eyebrow">GAME OVER</Text>
              <Heading as="h1" size={{ base: '3xl', md: '5xl' }} letterSpacing="tight" mt="2">
                That’s a wrap.
              </Heading>

              <Box className="host-count" mt="8">
                <Text className="host-count-value">{players.toLocaleString()}</Text>
                <Text className="host-count-label">
                  {players === 1 ? 'player' : 'players'} played
                </Text>
              </Box>

              <Text color="fg.muted" mt="6" fontSize={{ base: 'md', md: 'lg' }}>
                {showStandings ? 'Final standings below.' : 'No scores were recorded.'}
              </Text>

              <HStack mt="6" justify="center">
                {transportLine}
              </HStack>
            </Box>
          </Container>
        </Box>

        {showStandings && (
          <Container maxW="7xl" pb={{ base: '12', md: '20' }}>
            <Box className="host-standings">
              <LeaderboardTable
                entries={entries}
                title="Final standings"
                transport={live.transport}
              />
            </Box>
          </Container>
        )}
      </>
    );
  }

  // LOBBY: the QR leads — getting people in is the only job on screen.
  return (
    <>
      <Box className="hero-grid">
        <Container maxW="7xl" py={{ base: '8', md: '12' }}>
          <SimpleGrid
            columns={{ base: 1, lg: 2 }}
            gap={{ base: '8', lg: '12' }}
            alignItems="center"
          >
            <Box className="glass-panel host-panel">
              <HStack gap="2" mb="4">
                <Badge colorPalette={open ? 'orange' : 'green'}>
                  {state.status.replace('_', ' ')}
                </Badge>
                <Badge variant="outline">
                  {open
                    ? `${state.questionCount} QUESTION${state.questionCount === 1 ? '' : 'S'}`
                    : `QUESTION ${state.questionIndex + 1} OF ${state.questionCount}`}
                </Badge>
              </HStack>

              <Text
                fontWeight="semibold"
                fontSize={{ base: 'xl', md: '2xl' }}
                mb="4"
                overflowWrap="anywhere"
              >
                {state.name ?? `Game ${state.gameId.slice(0, 8)}`}
              </Text>
              <Text className="eyebrow">JOIN FROM YOUR PHONE</Text>
              <Heading as="h1" size={{ base: '3xl', md: '5xl' }} letterSpacing="tight" mt="2">
                Point your camera
                <br />
                <span className="gradient-text">at the code.</span>
              </Heading>

              <Box className="host-count" mt="8">
                <Text className="host-count-value">{players.toLocaleString()}</Text>
                <Text className="host-count-label">
                  {players === 1 ? 'player' : 'players'}
                  {open ? ' in the lobby' : ' joined'}
                </Text>
              </Box>

              <Text color="fg.muted" mt="6" fontSize={{ base: 'md', md: 'lg' }}>
                {open
                  ? 'The game starts as soon as the host kicks it off — no app, no account.'
                  : 'The game is under way. Scan to jump in on the next question.'}
              </Text>

              <Box mt="6">{transportLine}</Box>
            </Box>

            {/* Full size in the lobby, where scanning is the whole point. Smaller
                on the brief tick where a round has begun but its question has not
                arrived yet. Never on a FINISHED game — that returns above. */}
            <Box className="host-qr-column">
              <JoinQr url={joinUrl} size={open ? 620 : 400} />
            </Box>
          </SimpleGrid>
        </Container>
      </Box>

      {showStandings && (
        <Container maxW="7xl" pb={{ base: '12', md: '20' }}>
          <Box className="host-standings">
            <LeaderboardTable entries={entries} title="Live standings" transport={live.transport} />
          </Box>
        </Container>
      )}
    </>
  );
}
