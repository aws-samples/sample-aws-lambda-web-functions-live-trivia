import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { AdminPage } from '@/pages/AdminPage';
import { GamesPage } from '@/pages/GamesPage';
import { HostPage } from '@/pages/HostPage';
import { LeaderboardPage } from '@/pages/LeaderboardPage';
import { PlayerPage } from '@/pages/PlayerPage';
import type { RuntimeConfig } from '@/runtime-config';

interface AppProps {
  config: RuntimeConfig;
}

/**
 * Routing rule: every game surface is scoped by an explicit `:gameId`.
 *
 * Games run in parallel, so no screen may resolve "the active game" — a page that
 * guessed would drop a player into the wrong concurrent session. The only
 * unscoped route is `/`, which lists the games rather than picking one, and the
 * bare `/host` and `/leaderboard` paths redirect there instead of guessing.
 */
export function App({ config }: AppProps) {
  return (
    <AppShell apiBaseUrl={config.apiBaseUrl}>
      <Routes>
        <Route path="/" element={<GamesPage apiBaseUrl={config.apiBaseUrl} />} />

        {/* Player lobby. This is the URL each game's QR code encodes, and the same
            URL a directory row links to — scanning and tapping are one path. */}
        <Route path="/join/:gameId" element={<PlayerPage apiBaseUrl={config.apiBaseUrl} />} />

        {/* Projected screen showing that game's QR and live standings. Reached
            from the admin console, never from the nav. */}
        <Route path="/host/:gameId" element={<HostPage apiBaseUrl={config.apiBaseUrl} />} />
        <Route path="/host" element={<Navigate to="/" replace />} />

        <Route
          path="/leaderboard/:gameId"
          element={<LeaderboardPage apiBaseUrl={config.apiBaseUrl} />}
        />
        <Route path="/leaderboard" element={<Navigate to="/" replace />} />

        <Route path="/admin" element={<AdminPage apiBaseUrl={config.apiBaseUrl} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
