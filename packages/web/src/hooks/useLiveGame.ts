import type {
  JoinPlayerResponse,
  LeaderboardSnapshot,
  PlayerStatusResponse,
  PublicGameState,
} from '@serverlessq/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiClientError,
  getGameState,
  getLeaderboard,
  getPlayerStatus,
  joinGame,
  leaderboardStreamUrl,
  submitAnswer as postAnswer,
} from '@/api/client';
import { openLeaderboardStream } from '@/api/leaderboardStream';

/**
 * Identities are stored per game, keyed by gameId.
 *
 * Parallel sessions mean one device can legitimately hold a player in several
 * games at once (a host testing two rooms, an attendee in a side game). The old
 * single-slot key meant opening game B silently discarded the identity in game A.
 */
const PLAYER_STORAGE_KEY = 'serverlessq.players.v1';
const FALLBACK_AFTER_ERRORS = 3;
const FALLBACK_POLL_MS = 2_000;

export type TransportState = 'idle' | 'connecting' | 'sse' | 'reconnecting' | 'polling';
export type AnswerState = 'idle' | 'submitting' | 'accepted';

interface StoredPlayer {
  gameId: string;
  playerId: string;
  name: string;
}

function readAll(): Record<string, StoredPlayer> {
  try {
    const value = window.localStorage.getItem(PLAYER_STORAGE_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value) as Record<string, Partial<StoredPlayer>>;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, p]) => p && p.gameId && p.playerId && p.name) as Array<
        [string, StoredPlayer]
      >,
    );
  } catch {
    return {};
  }
}

function readStoredPlayer(gameId: string): StoredPlayer | null {
  return readAll()[gameId] ?? null;
}

/** Write (or clear, when `player` is null) this game's identity, leaving others intact. */
function storePlayer(gameId: string, player: StoredPlayer | null): void {
  const all = readAll();
  if (player) all[gameId] = player;
  else delete all[gameId];
  if (Object.keys(all).length === 0) window.localStorage.removeItem(PLAYER_STORAGE_KEY);
  else window.localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(all));
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

/**
 * Live state for one explicitly identified game.
 *
 * `gameId` is required, never discovered. Parallel sessions mean there is no
 * single "active game" to resolve, so every surface — player lobby, host screen,
 * leaderboard — is scoped by the gameId in its URL. Any screen that guessed would
 * silently move players between concurrent games.
 */
export function useLiveGame(apiBaseUrl: string, gameId: string) {
  const [activeGameId, setActiveGameId] = useState<string>();
  const [gameState, setGameState] = useState<PublicGameState>();
  const [leaderboard, setLeaderboard] = useState<LeaderboardSnapshot>({
    topN: [],
    updatedAt: 0,
  });
  const [player, setPlayer] = useState<PlayerStatusResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [transport, setTransport] = useState<TransportState>('idle');
  const [answerState, setAnswerState] = useState<AnswerState>('idle');
  const [joining, setJoining] = useState(false);
  const activeIdentity = useRef<StoredPlayer | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(undefined);
      try {
        let state: PublicGameState;
        try {
          state = await getGameState(apiBaseUrl, gameId, signal);
        } catch (stateError) {
          // The id comes from a URL (a scanned QR, a shared link, a directory
          // row), so it can point at a game the host has since deleted. Report
          // that instead of leaving the page stuck on a spinner.
          if (stateError instanceof ApiClientError && stateError.status === 404) {
            setActiveGameId(undefined);
            setGameState(undefined);
            setLeaderboard({ topN: [], updatedAt: Date.now() });
            setTransport('idle');
            setError('That game no longer exists. Ask the host for a fresh QR code.');
            return;
          }
          throw stateError;
        }

        setActiveGameId(gameId);
        setGameState(state);

        // Seed the standings over REST too.
        //
        // The leaderboard used to arrive ONLY on the SSE stream, which made it the
        // one surface with a single point of failure: `state` above comes from this
        // fetch, so a client whose stream was blocked, throttled, or slow to attach
        // showed a live-looking game next to a permanently empty leaderboard —
        // while a client on a healthy stream saw everything. Same game, same room,
        // two different screens.
        //
        // Non-fatal on purpose: if this fails the stream still fills it in.
        void getLeaderboard(apiBaseUrl, gameId, signal)
          .then((snapshot) => {
            // A slow response must not clobber a fresher stream frame that landed
            // while it was in flight; both timestamps come from the same API.
            setLeaderboard((current) =>
              snapshot.updatedAt >= current.updatedAt ? snapshot : current,
            );
          })
          .catch(() => undefined);

        // Only this game's identity is consulted; identities for other concurrent
        // games stay untouched in storage.
        const stored = readStoredPlayer(gameId);
        if (!stored) {
          activeIdentity.current = null;
          setPlayer(undefined);
          return;
        }

        try {
          const status = await getPlayerStatus(apiBaseUrl, gameId, stored.playerId, signal);
          activeIdentity.current = stored;
          setPlayer(status);
        } catch (statusError) {
          // Kicked, or the game was cleared — drop just this game's identity.
          if (statusError instanceof ApiClientError && statusError.status === 404) {
            storePlayer(gameId, null);
            activeIdentity.current = null;
            setPlayer(undefined);
          } else {
            throw statusError;
          }
        }
      } catch (refreshError) {
        if (!(refreshError instanceof DOMException && refreshError.name === 'AbortError')) {
          setError(messageFrom(refreshError));
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [apiBaseUrl, gameId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!activeGameId) return;

    let disposed = false;
    let closeStream: (() => void) | undefined;
    let pollTimer: number | undefined;
    let consecutiveErrors = 0;

    // Not guarded by `disposed`, to stay symmetric with the `state` handler: the
    // two frames ride the SAME stream and arrive together, so dropping one and
    // keeping the other would split the screen. A late setState on an unmounted
    // component is a no-op in React 18+, and the stream is closed by the cleanup
    // below. `poll()` still guards, because there a guard stops a self-rescheduling
    // timer rather than a single render.
    const updateLeaderboard = (snapshot: LeaderboardSnapshot) => {
      setLeaderboard(snapshot);
    };

    const poll = async () => {
      if (disposed) return;
      const controller = new AbortController();
      try {
        const [state, snapshot] = await Promise.all([
          getGameState(apiBaseUrl, activeGameId, controller.signal),
          getLeaderboard(apiBaseUrl, activeGameId, controller.signal),
        ]);
        if (!disposed) {
          setGameState(state);
          updateLeaderboard(snapshot);
          setError(undefined);
        }
      } catch (pollError) {
        if (!disposed) setError(messageFrom(pollError));
      } finally {
        if (!disposed) pollTimer = window.setTimeout(() => void poll(), FALLBACK_POLL_MS);
      }
    };

    const startPolling = () => {
      closeStream?.();
      closeStream = undefined;
      setTransport('polling');
      void poll();
    };

    setTransport('connecting');
    closeStream = openLeaderboardStream(leaderboardStreamUrl(apiBaseUrl, activeGameId), {
      onState: (state) => setGameState(state),
      onLeaderboard: (snapshot) => updateLeaderboard(snapshot),
      onReconnect: () => setTransport('reconnecting'),
      onOpen: () => {
        consecutiveErrors = 0;
        setTransport('sse');
        setError(undefined);
      },
      onError: () => {
        consecutiveErrors += 1;
        setTransport('reconnecting');
        if (consecutiveErrors >= FALLBACK_AFTER_ERRORS) startPolling();
      },
    });

    return () => {
      disposed = true;
      closeStream?.();
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [activeGameId, apiBaseUrl]);

  useEffect(() => {
    const identity = activeIdentity.current;
    if (!activeGameId || !identity || gameState?.status === 'IN_ROUND') return;
    const controller = new AbortController();
    void getPlayerStatus(apiBaseUrl, activeGameId, identity.playerId, controller.signal)
      .then(setPlayer)
      .catch((statusError: unknown) => {
        if (!(statusError instanceof DOMException && statusError.name === 'AbortError')) {
          setError(messageFrom(statusError));
        }
      });
    return () => controller.abort();
  }, [activeGameId, apiBaseUrl, gameState?.status]);

  useEffect(() => {
    setAnswerState('idle');
  }, [gameState?.question?.questionId]);

  const join = useCallback(
    async (name: string): Promise<JoinPlayerResponse> => {
      if (!activeGameId) throw new Error('No active game');
      setError(undefined);
      setJoining(true);
      try {
        const joined = await joinGame(apiBaseUrl, activeGameId, { name });
        const identity: StoredPlayer = joined;
        storePlayer(gameId, identity);
        activeIdentity.current = identity;
        setPlayer({
          playerId: joined.playerId,
          name: joined.name,
          state: 'ACTIVE',
          points: 0,
          streak: 0,
        });
        return joined;
      } catch (joinError) {
        setError(messageFrom(joinError));
        throw joinError;
      } finally {
        setJoining(false);
      }
    },
    [activeGameId, apiBaseUrl, gameId],
  );

  const answer = useCallback(
    async (choice: string): Promise<void> => {
      const identity = activeIdentity.current;
      const questionId = gameState?.question?.questionId;
      if (!activeGameId || !identity || !questionId) throw new Error('Join before answering');
      setAnswerState('submitting');
      setError(undefined);
      try {
        await postAnswer(apiBaseUrl, activeGameId, questionId, {
          playerId: identity.playerId,
          choice,
        });
        setAnswerState('accepted');
      } catch (answerError) {
        setAnswerState('idle');
        setError(messageFrom(answerError));
        throw answerError;
      }
    },
    [activeGameId, apiBaseUrl, gameState?.question?.questionId],
  );

  const forgetPlayer = useCallback(() => {
    storePlayer(gameId, null);
    activeIdentity.current = null;
    setPlayer(undefined);
  }, [gameId]);

  return {
    activeGameId,
    gameState,
    leaderboard,
    player,
    loading,
    joining,
    error,
    transport,
    answerState,
    join,
    answer,
    refresh,
    forgetPlayer,
  };
}
