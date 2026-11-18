import { Badge, Box, Heading, HStack, Text } from '@chakra-ui/react';
import type { LeaderboardEntry } from '@serverlessq/shared';
import type { TransportState } from '@/hooks/useLiveGame';

interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  title?: string;
  transport?: TransportState;
}

const transportCopy: Record<TransportState, string> = {
  idle: 'WAITING',
  connecting: 'CONNECTING',
  sse: 'LIVE · SSE',
  reconnecting: 'RECONNECTING',
  polling: 'LIVE · POLLING',
};

export function LeaderboardTable({
  entries,
  title = 'Live leaderboard',
  transport = 'idle',
}: LeaderboardTableProps) {
  const connected = transport === 'sse' || transport === 'polling';

  return (
    <Box className="glass-panel leaderboard-card">
      <HStack justify="space-between" align="flex-start" gap="3" wrap="wrap" mb="4">
        <Box minW="0">
          <Text className="eyebrow">UPDATES EVERY 1–2 SECONDS</Text>
          <Heading as="h2" size="xl" mt="1">
            {title}
          </Heading>
        </Box>
        <Badge colorPalette={connected ? 'green' : 'gray'} variant="subtle" className="live-badge">
          {connected && <span className="live-dot" />} {transportCopy[transport]}
        </Badge>
      </HStack>

      {entries.length === 0 ? (
        <Box className="empty-state">
          <Text fontWeight="semibold">No scores yet</Text>
          <Text color="fg.muted" fontSize="sm" mt="1">
            The leaderboard will fill as players answer.
          </Text>
        </Box>
      ) : (
        <Box overflowX="auto">
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Player</th>
                <th>Streak</th>
                <th className="numeric">Points</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${index}:${entry.name}`}>
                  <td>
                    <span className={`rank rank-${index + 1}`}>{index + 1}</span>
                  </td>
                  <td>
                    <strong>{entry.name}</strong>
                  </td>
                  <td>{entry.streak >= 3 ? `🔥 ${entry.streak}` : entry.streak || '—'}</td>
                  <td className="numeric points-cell">{entry.points.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>
      )}
    </Box>
  );
}
