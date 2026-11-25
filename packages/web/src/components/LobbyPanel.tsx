import { Box, Heading, HStack, Text } from '@chakra-ui/react';
import type { TransportState } from '@/hooks/useLiveGame';

interface LobbyPanelProps {
  playerCount: number;
  questionCount: number;
  /** True once this device has a player identity in the game. */
  joined: boolean;
  transport: TransportState;
}

/**
 * What a player sees between scanning the QR and the first question.
 *
 * The join count is the whole point of this screen: it is the only feedback that
 * the room is filling up while nothing else is happening, and it reassures a
 * player who scanned early that they are not stuck on a dead page. It arrives on
 * the same SSE `state` frames that later carry the questions.
 */
export function LobbyPanel({ playerCount, questionCount, joined, transport }: LobbyPanelProps) {
  const connected = transport === 'sse' || transport === 'polling';

  return (
    <Box className="glass-panel lobby-card">
      <Text className="eyebrow">LOBBY</Text>
      <Heading as="h2" size={{ base: '2xl', md: '3xl' }} mt="2">
        {joined ? 'You’re in. Hold tight.' : 'Waiting for the host'}
      </Heading>

      <Box className="lobby-count" mt="7">
        <Text className="lobby-count-value">{playerCount.toLocaleString()}</Text>
        <Text className="lobby-count-label">
          {playerCount === 1 ? 'player has joined' : 'players have joined'}
        </Text>
      </Box>

      <Text color="fg.muted" mt="6">
        {joined
          ? `The first of ${questionCount} question${questionCount === 1 ? '' : 's'} appears here automatically the moment the host starts the game. Keep this tab open.`
          : `Pick a display name to claim your spot. ${questionCount} question${questionCount === 1 ? '' : 's'} to play.`}
      </Text>

      <HStack gap="2" mt="6">
        {connected && <span className="live-dot" />}
        <Text fontSize="xs" color="fg.subtle">
          {transport === 'sse'
            ? 'Live'
            : transport === 'polling'
              ? 'Live (polling fallback)'
              : transport === 'reconnecting'
                ? 'Reconnecting…'
                : 'Connecting…'}
        </Text>
      </HStack>
    </Box>
  );
}
