import type { Response } from 'express';
import type * as Shared from '@serverlessq/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getGame = vi.hoisted(() => vi.fn());
const getLeaderboard = vi.hoisted(() => vi.fn());
vi.mock('@serverlessq/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof Shared>()),
  gamesRepo: { getGame },
  scoresRepo: { getLeaderboard },
  sseConnectionLimits: { perGame: 2, perEnvironment: 3 },
}));

const { addConnection, removeConnection } = await import('./sse.ts');
const { timers } = await import('@serverlessq/shared');

describe('leaderboard stream opening events', () => {
  let metrics: Array<Record<string, unknown>>;
  let connections: Response[];

  function connection(): Response {
    const res = { write: vi.fn(), end: vi.fn() } as unknown as Response;
    connections.push(res);
    return res;
  }

  function openingEvents() {
    return metrics.filter((metric) => 'LeaderboardStreamsOpened' in metric);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    metrics = [];
    connections = [];
    getGame.mockReset().mockResolvedValue({
      gameId: 'g1',
      status: 'LOBBY',
      questionIds: ['q1', 'q2'],
      currentIndex: 0,
      questionDurationSec: 20,
      createdAt: 1000,
    });
    getLeaderboard.mockReset().mockResolvedValue([]);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      metrics.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      return true;
    });
  });

  afterEach(() => {
    for (const res of connections) removeConnection('g1', res);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('emits one Count increment for each registered stream and preserves the local gauge', () => {
    addConnection('g1', connection());
    addConnection('g1', connection());

    expect(openingEvents().map((metric) => metric.LeaderboardStreamsOpened)).toEqual([1, 1]);
    for (const event of openingEvents()) {
      const emf = event._aws as {
        CloudWatchMetrics: Array<{ Metrics: Array<{ Name: string; Unit: string }> }>;
      };
      expect(emf.CloudWatchMetrics[0]!.Metrics).toEqual([
        { Name: 'LeaderboardStreamsOpened', Unit: 'Count' },
      ]);
    }
    expect(
      metrics
        .filter((metric) => 'ActiveSSEConnections' in metric)
        .map((metric) => metric.ActiveSSEConnections),
    ).toEqual([1, 2]);
  });

  it('does not count frames, heartbeats or closes as new streams and preserves shared polling', async () => {
    const first = connection();
    const second = connection();
    addConnection('g1', first);
    addConnection('g1', second);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);

    getGame.mockClear();
    getLeaderboard.mockClear();
    vi.mocked(first.write).mockClear();
    vi.mocked(second.write).mockClear();
    await vi.advanceTimersByTimeAsync(timers.pollIntervalMs);
    expect(getGame).toHaveBeenCalledTimes(1);
    expect(getLeaderboard).toHaveBeenCalledTimes(1);
    expect(first.write).toHaveBeenCalledWith(expect.stringContaining('event: state'));
    expect(second.write).toHaveBeenCalledWith(expect.stringContaining('event: leaderboard'));
    await vi.advanceTimersByTimeAsync(timers.heartbeatMs);
    expect(first.write).toHaveBeenCalledWith(': ping\n\n');
    expect(second.write).toHaveBeenCalledWith(': ping\n\n');
    expect(openingEvents()).toHaveLength(2);

    removeConnection('g1', first);
    expect(vi.getTimerCount()).toBe(2);
    removeConnection('g1', second);
    expect(vi.getTimerCount()).toBe(0);
    expect(openingEvents()).toHaveLength(2);
    expect(
      metrics
        .filter((metric) => 'ActiveSSEConnections' in metric)
        .map((metric) => metric.ActiveSSEConnections),
    ).toEqual([1, 2, 1, 0]);
  });

  it('counts a reopened stream as a new event after the previous connection closes', () => {
    const first = connection();
    addConnection('g1', first);
    removeConnection('g1', first);
    addConnection('g1', connection());

    expect(openingEvents().map((metric) => metric.LeaderboardStreamsOpened)).toEqual([1, 1]);
    expect(
      metrics
        .filter((metric) => 'ActiveSSEConnections' in metric)
        .map((metric) => metric.ActiveSSEConnections),
    ).toEqual([1, 0, 1]);
  });

  it('rejects connections above the per-game and per-environment limits', () => {
    const first = connection();
    const second = connection();
    const otherGame = connection();
    const rejected = connection();

    expect(addConnection('g1', first)).toBe(true);
    expect(addConnection('g1', second)).toBe(true);
    expect(addConnection('g2', otherGame)).toBe(true);
    expect(addConnection('g2', rejected)).toBe(false);

    expect(vi.getTimerCount()).toBe(4);
    removeConnection('g2', otherGame);
    removeConnection('g2', rejected);
  });

  it('writes the final snapshot and closes every stream when the game is finished', async () => {
    getGame.mockResolvedValue({
      gameId: 'g1',
      status: 'FINISHED',
      questionIds: ['q1'],
      currentIndex: 0,
      questionDurationSec: 20,
      createdAt: 1000,
    });
    const first = connection();
    const second = connection();

    addConnection('g1', first);
    addConnection('g1', second);
    await vi.advanceTimersByTimeAsync(0);

    expect(first.write).toHaveBeenCalledWith(expect.stringContaining('event: leaderboard'));
    expect(second.write).toHaveBeenCalledWith(expect.stringContaining('event: state'));
    expect(first.end).toHaveBeenCalledTimes(1);
    expect(second.end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
