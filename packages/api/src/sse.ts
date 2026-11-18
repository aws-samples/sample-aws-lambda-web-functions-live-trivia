import type { Response } from 'express';
import {
  gamesRepo,
  scoresRepo,
  leaderboardTopN,
  timers,
  sseConnectionLimits,
} from '@serverlessq/shared';
import { resolvePublicGameState } from './views.ts';
import { settleRound } from './services/round.ts';
import { emitMetric } from './metrics.ts';
import { logger } from './logger.ts';

/**
 * Per-execution-environment SSE fan-out (design §3.2 / R-10). ONE poller per
 * gameId reads game state + the top-N leaderboard every 1–2 s and writes that
 * one snapshot to every local connection — so hundreds of streams cost one
 * query set per tick, not one read per connection. The poller starts on the
 * first connection for a gameId and stops when the last one leaves.
 */
interface Room {
  conns: Set<Response>;
  pollTimer: NodeJS.Timeout;
  heartbeatTimer: NodeJS.Timeout;
}

const rooms = new Map<string, Room>();
let activeConnections = 0;

// Helpers for SSE framing, shared snapshots, heartbeats, and connection metrics.

/** The SSE wire format is just "event: <name>\n data: <json>\n\n". */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * One snapshot of a game for the stream: settle a round that is already over
 * (countdown expired, or everyone answered), then the public state + standings.
 * Returns the frames to write, or undefined if the game has gone.
 */
async function readSnapshot(
  gameId: string,
): Promise<{ frames: string; terminal: boolean } | undefined> {
  const current = await gamesRepo.getGame(gameId);
  if (!current) return undefined;
  const game = await settleRound(current);
  const [state, topN] = await Promise.all([
    resolvePublicGameState(game),
    scoresRepo.getLeaderboard(gameId, leaderboardTopN),
  ]);
  return {
    frames: frame('state', state) + frame('leaderboard', { topN, updatedAt: Date.now() }),
    terminal: game.status === 'FINISHED',
  };
}

/** SSE comment line, keeps intermediaries from closing an idle connection. */
function heartbeat(gameId: string): void {
  const room = rooms.get(gameId);
  if (!room) return;
  for (const res of room.conns) res.write(': ping\n\n');
}

/** Emit metrics for a new connection. */
function registerConnection(): void {
  activeConnections += 1;
  emitMetric('LeaderboardStreamsOpened', 1);
  emitMetric('ActiveSSEConnections', activeConnections);
}

export function addConnection(gameId: string, res: Response): boolean {
  // A browser just opened a stream. Add it to this game's room, and start the
  // room's single poller if this is the first connection for the game.
  let room = rooms.get(gameId);
  if (
    activeConnections >= sseConnectionLimits.perEnvironment ||
    (room?.conns.size ?? 0) >= sseConnectionLimits.perGame
  ) {
    return false;
  }
  if (!room) {
    room = {
      conns: new Set(),
      pollTimer: setInterval(() => void poll(gameId), timers.pollIntervalMs),
      heartbeatTimer: setInterval(() => heartbeat(gameId), timers.heartbeatMs),
    };
    rooms.set(gameId, room);
  }
  room.conns.add(res);
  registerConnection();
  void poll(gameId); // push a snapshot now; don't wait for the first tick
  return true;
}

// The poller tick: read ONE snapshot of the game, write it to EVERY connection.
async function poll(gameId: string) {
  const room = rooms.get(gameId);
  if (!room || room.conns.size === 0) return;
  try {
    const snapshot = await readSnapshot(gameId);
    if (!snapshot) {
      closeRoom(gameId);
      return;
    }
    for (const res of room.conns) res.write(snapshot.frames);
    if (snapshot.terminal) closeRoom(gameId);
  } catch (err) {
    logger.error({ err, gameId }, 'sse poll failed');
  }
}

function closeRoom(gameId: string): void {
  const room = rooms.get(gameId);
  if (!room) return;
  for (const res of [...room.conns]) {
    res.end();
    removeConnection(gameId, res);
  }
}

/** Last connection out stops the game's poller. */
export function removeConnection(gameId: string, res: Response): void {
  const room = rooms.get(gameId);
  if (!room) return;
  if (room.conns.delete(res)) {
    activeConnections = Math.max(0, activeConnections - 1);
    emitMetric('ActiveSSEConnections', activeConnections);
  }
  if (room.conns.size === 0) {
    clearInterval(room.pollTimer);
    clearInterval(room.heartbeatTimer);
    rooms.delete(gameId);
  }
}
