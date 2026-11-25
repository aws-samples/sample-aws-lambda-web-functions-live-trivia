import type { LeaderboardSnapshot, PublicGameState } from '@serverlessq/shared';

/** What the UI wants to hear about from the live stream. */
export interface LeaderboardStreamHandlers {
  onState: (state: PublicGameState) => void;
  onLeaderboard: (snapshot: LeaderboardSnapshot) => void;
  onReconnect: () => void;
  onOpen: () => void;
  onError: () => void;
}

// Each SSE message arrives as JSON text in `event.data`; parse it back to a type.
function parseState(event: Event): PublicGameState {
  return JSON.parse((event as MessageEvent<string>).data);
}
function parseLeaderboard(event: Event): LeaderboardSnapshot {
  return JSON.parse((event as MessageEvent<string>).data);
}

// EventSource is the browser's built-in SSE client. Give it a URL and it holds
// the connection open and reconnects on its own; we just react to each event.
export function openLeaderboardStream(url: string, handlers: LeaderboardStreamHandlers) {
  const source = new EventSource(url);

  // 'state' moves the question/phase forward; 'leaderboard' updates the standings.
  // They ride the SAME stream, so the screen can never show one without the other.
  source.addEventListener('state', (event) => handlers.onState(parseState(event)));
  source.addEventListener('leaderboard', (event) =>
    handlers.onLeaderboard(parseLeaderboard(event)),
  );

  // Reserved compatibility hook; the current server does not emit this event.
  // Browser EventSource reconnects automatically after interruption or timeout.
  source.addEventListener('reconnect', () => handlers.onReconnect());

  // Connection opened cleanly / connection dropped.
  source.onopen = () => handlers.onOpen();
  source.onerror = () => handlers.onError();

  // Hand the caller a function to close the stream when the screen goes away.
  return () => source.close();
}
