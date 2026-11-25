import type { LeaderboardSnapshot, PublicGameState } from '@serverlessq/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openLeaderboardStream } from '@/api/leaderboardStream';

type Listener = (event: Event) => void;

/**
 * Minimal stand-in for the browser's EventSource, driven by the test. Installed
 * on globalThis so `new EventSource(url)` inside openLeaderboardStream resolves
 * to it — no jsdom, same approach as HostPage.test.ts does for `window`.
 */
class FakeEventSource {
  static last: FakeEventSource | undefined;
  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Listener>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  /** Deliver a server frame to the matching listener as JSON in `event.data`. */
  emit(type: string, data: unknown): void {
    const listener = this.listeners.get(type);
    if (listener) listener({ data: JSON.stringify(data) } as unknown as MessageEvent<string>);
  }
}

beforeEach(() => {
  FakeEventSource.last = undefined;
  Object.defineProperty(globalThis, 'EventSource', {
    value: FakeEventSource,
    configurable: true,
    writable: true,
  });
});

function handlers() {
  return {
    onState: vi.fn(),
    onLeaderboard: vi.fn(),
    onReconnect: vi.fn(),
    onOpen: vi.fn(),
    onError: vi.fn(),
  };
}

const gameState: PublicGameState = {
  gameId: 'g1',
  status: 'IN_ROUND',
  questionIndex: 0,
  playerCount: 2,
  questionCount: 3,
  questionDurationSec: 20,
};

const snapshot: LeaderboardSnapshot = {
  topN: [{ name: 'Jan', points: 100, streak: 1 }],
  updatedAt: 5,
};

describe('openLeaderboardStream', () => {
  it('opens one EventSource at the given URL', () => {
    openLeaderboardStream('https://api.example.test/stream', handlers());
    expect(FakeEventSource.last?.url).toBe('https://api.example.test/stream');
  });

  it('routes state and leaderboard frames to the matching handlers', () => {
    const h = handlers();
    openLeaderboardStream('https://api.example.test/stream', h);
    const source = FakeEventSource.last;

    source?.emit('state', gameState);
    source?.emit('leaderboard', snapshot);

    expect(h.onState).toHaveBeenCalledWith(gameState);
    expect(h.onLeaderboard).toHaveBeenCalledWith(snapshot);
  });

  it('forwards reconnect, open, and error', () => {
    const h = handlers();
    openLeaderboardStream('https://api.example.test/stream', h);
    const source = FakeEventSource.last;

    source?.emit('reconnect', {});
    source?.onopen?.();
    source?.onerror?.();

    expect(h.onReconnect).toHaveBeenCalledOnce();
    expect(h.onOpen).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledOnce();
  });

  it('closes the underlying EventSource through the returned function', () => {
    const close = openLeaderboardStream('https://api.example.test/stream', handlers());
    const source = FakeEventSource.last;
    expect(source?.closed).toBe(false);
    close();
    expect(source?.closed).toBe(true);
  });
});
