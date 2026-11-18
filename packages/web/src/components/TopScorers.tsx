import { Badge, Box, HStack, Text } from '@chakra-ui/react';
import type { LeaderboardEntry } from '@serverlessq/shared';
import type { TransportState } from '@/hooks/useLiveGame';

interface TopScorersProps {
  /** Already ranked by the server; this only takes the first `limit`. */
  entries: LeaderboardEntry[];
  limit?: number;
  transport?: TransportState;
}

const medals = ['🥇', '🥈', '🥉'];

/**
 * Top-3 strip under the projected question.
 *
 * Deliberately not the full LeaderboardTable: between rounds the screen's job is
 * the question, and a table of every player would push it off a projector. The
 * full standings still show at FINISHED.
 */
export function TopScorers({ entries, limit = 3, transport = 'idle' }: TopScorersProps) {
  const top = entries.slice(0, limit);
  if (top.length === 0) return null;

  const connected = transport === 'sse' || transport === 'polling';

  return (
    <Box className="glass-panel top-scorers">
      <HStack justify="space-between" align="center" gap="3" mb="4" wrap="wrap">
        <Text className="eyebrow">TOP {top.length}</Text>
        <Badge colorPalette={connected ? 'green' : 'gray'} variant="subtle" className="live-badge">
          {connected && <span className="live-dot" />} {connected ? 'LIVE' : 'WAITING'}
        </Badge>
      </HStack>

      <Box className="top-scorers-row">
        {top.map((entry, index) => (
          <Box key={`${index}:${entry.name}`} className={`top-scorer place-${index + 1}`}>
            <Text className="top-scorer-medal" aria-label={`rank ${index + 1}`}>
              {medals[index] ?? index + 1}
            </Text>
            <Box minW="0">
              <Text className="top-scorer-name">{entry.name}</Text>
              <Text className="top-scorer-meta">
                {entry.points.toLocaleString()} pts
                {entry.streak >= 3 ? ` · 🔥 ${entry.streak}` : ''}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
