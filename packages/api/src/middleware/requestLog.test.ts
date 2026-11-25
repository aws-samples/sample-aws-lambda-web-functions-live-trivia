import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The metric sink is mocked so RequestLatencyMs emission can be asserted without
// writing EMF to stdout.
const emitMetric = vi.hoisted(() => vi.fn());
vi.mock('../metrics.ts', () => ({ emitMetric }));

const { requestLog } = await import('./requestLog.ts');
const { logger } = await import('../logger.ts');
const express = (await import('express')).default;

interface LoggedRequest {
  requestId?: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  gameId?: string;
  aborted?: boolean;
}

/**
 * An app shaped like the real one: the public router at the app root and the
 * admin router at /api/admin, both mounting requestLog. The admin stand-in
 * rejects a missing bearer BEFORE any route matches, mirroring adminAuth, so the
 * 401-logging path is covered without reaching Cognito signing-key endpoints.
 */
function buildApp() {
  const app = express();
  app.use(express.json());

  const pub = express.Router();
  pub.use(requestLog);
  pub.get('/api/games/:gameId', (_req, res) => {
    res.json({ ok: true });
  });
  pub.get('/api/games/:gameId/players/:playerId', (_req, res) => {
    res.json({ ok: true });
  });
  pub.get('/api/games/:gameId/leaderboard/stream', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': connected\n\n');
    res.end();
  });

  const admin = express.Router();
  admin.use(requestLog);
  admin.use((req, res, next) => {
    if (!req.headers.authorization) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
      return;
    }
    next();
  });
  admin.post('/games/:gameId/next', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(pub);
  app.use('/api/admin', admin);
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND' } });
  });
  return app;
}

function call(
  app: ReturnType<typeof buildApp>,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: opts.path,
          method: opts.method ?? 'GET',
          headers: opts.headers,
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            // Let the server's 'finish'/'close' listeners run before asserting.
            setTimeout(() => {
              server.close();
              resolve(res.statusCode ?? 0);
            }, 30);
          });
        },
      );
      req.on('error', reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  });
}

let infoSpy: ReturnType<typeof vi.spyOn>;

function requestLogs(): LoggedRequest[] {
  return infoSpy.mock.calls
    .filter((call: unknown[]) => call[1] === 'request')
    .map((call: unknown[]) => call[0] as LoggedRequest);
}

beforeEach(() => {
  emitMetric.mockReset();
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestLog route resolution', () => {
  it('adds the Lambda Web Function request ID to the structured request log', async () => {
    const status = await call(buildApp(), {
      path: '/api/games/G1',
      headers: { 'lambda-web-request-id': 'NF5U6CMIUAWPER24GXDNDEZSVU' },
    });
    expect(status).toBe(200);

    const logs = requestLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.requestId).toBe('NF5U6CMIUAWPER24GXDNDEZSVU');
  });

  it('logs the public route pattern, status, numeric duration and gameId', async () => {
    const status = await call(buildApp(), { path: '/api/games/G1' });
    expect(status).toBe(200);

    const logs = requestLogs();
    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.method).toBe('GET');
    expect(log.route).toBe('/api/games/:gameId');
    expect(log.status).toBe(200);
    expect(typeof log.durationMs).toBe('number');
    expect(Number.isFinite(log.durationMs)).toBe(true);
    expect(log.durationMs).toBeGreaterThanOrEqual(0);
    // Rounded to one decimal place: re-rounding the value is a no-op.
    expect(Math.round(log.durationMs * 10) / 10).toBe(log.durationMs);
    expect(log.gameId).toBe('G1');

    expect(emitMetric).toHaveBeenCalledWith('RequestLatencyMs', log.durationMs, 'Milliseconds', {
      Route: '/api/games/:gameId',
    });
  });

  it('logs the admin route with its /api/admin mount, exactly once despite the double mount', async () => {
    const status = await call(buildApp(), {
      method: 'POST',
      path: '/api/admin/games/G2/next',
      headers: { authorization: 'Bearer secret-token-value', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(status).toBe(200);

    const logs = requestLogs();
    // The request passes through the public mount AND the admin mount; it must
    // still produce one log line, attributed to the admin route.
    expect(logs).toHaveLength(1);
    expect(logs[0]!.route).toBe('/api/admin/games/:gameId/next');
    expect(logs[0]!.status).toBe(200);
    expect(logs[0]!.gameId).toBe('G2');

    expect(emitMetric).toHaveBeenCalledTimes(1);
    expect(emitMetric).toHaveBeenCalledWith(
      'RequestLatencyMs',
      expect.any(Number),
      'Milliseconds',
      {
        Route: '/api/admin/games/:gameId/next',
      },
    );
  });

  it("logs a pre-route 401 as 'unmatched' (adminAuth rejects before a route matches)", async () => {
    const status = await call(buildApp(), { method: 'POST', path: '/api/admin/games/G9/next' });
    expect(status).toBe(401);

    const logs = requestLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.route).toBe('unmatched');
    expect(logs[0]!.status).toBe(401);
  });

  it("logs a missed path as 'unmatched'", async () => {
    const status = await call(buildApp(), { path: '/nope' });
    expect(status).toBe(404);

    const logs = requestLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.route).toBe('unmatched');
    expect(logs[0]!.status).toBe(404);
  });
});

describe('requestLog redaction', () => {
  it('never logs the raw path (with playerId), the token, the body, or headers', async () => {
    await call(buildApp(), {
      path: '/api/games/G1/players/P1-secret?token=leak',
      headers: { authorization: 'Bearer secret-token-value', 'x-secret': 'nope' },
    });

    const logs = requestLogs();
    expect(logs).toHaveLength(1);
    const log = logs[0]!;

    // The route pattern conveys shape without the ids.
    expect(log.route).toBe('/api/games/:gameId/players/:playerId');
    // gameId is explicitly allowed (not sensitive); playerId is not surfaced.
    expect(log.gameId).toBe('G1');
    expect(Object.keys(log)).not.toContain('playerId');

    // Nothing sensitive leaked anywhere in the logged object.
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain('P1-secret'); // raw playerId
    expect(serialized).not.toContain('secret-token-value'); // Authorization
    expect(serialized).not.toContain('token=leak'); // query string
    expect(serialized.toLowerCase()).not.toContain('authorization');
  });
});

describe('requestLog SSE handling', () => {
  it('logs an event-stream response but skips the RequestLatencyMs metric', async () => {
    const status = await call(buildApp(), { path: '/api/games/G3/leaderboard/stream' });
    expect(status).toBe(200);

    const logs = requestLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.route).toBe('/api/games/:gameId/leaderboard/stream');
    expect(logs[0]!.gameId).toBe('G3');

    // Long-lived streams are logged but not metered as request latency.
    expect(emitMetric).not.toHaveBeenCalled();
  });
});
