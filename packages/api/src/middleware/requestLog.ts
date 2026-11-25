import type { RequestHandler, Request, Response } from 'express';
import { logger } from '../logger.ts';
import { emitMetric } from '../metrics.ts';

/**
 * One structured `request` log line per response, plus a `RequestLatencyMs`
 * custom metric (plan: canary-observability). The log carries only non-sensitive
 * fields — Lambda request ID, method, the Express route PATTERN, status, duration
 * and (when present) the gameId. It never logs the body, other headers,
 * `Authorization`, the query string,
 * or the raw path: a raw path can contain a `playerId`, and the route pattern
 * (`/api/games/:gameId/players/:playerId`) conveys the same shape without the id.
 *
 * Route resolution: both the public router (mounted at the app root) and the
 * admin router (mounted at `/api/admin`) mount this middleware. A request that
 * misses every public route still passes through the public mount before
 * reaching the admin mount, so the same response can run this middleware twice.
 * A WeakSet keyed on the response instruments each response exactly once — the
 * first pass attaches the listeners, and by the time `finish`/`close` fires,
 * Express 5 has left `req.baseUrl`, `req.route` and `req.params` set to the
 * values of the router that actually handled the request, so the single listener
 * reports the correct mounted pattern (e.g. `/api/admin/games/:gameId/next`)
 * regardless of which mount attached it.
 */
const instrumented = new WeakSet<Response>();

function routePattern(req: Request): string {
  // req.route is only set once a ROUTE (not bare middleware) matched. A 404 or a
  // 401 blocked ahead of routing leaves it undefined → 'unmatched'.
  const raw = req.route?.path as unknown;
  const path = Array.isArray(raw) ? String(raw[0]) : typeof raw === 'string' ? raw : undefined;
  if (path === undefined) return 'unmatched';
  // req.baseUrl is the owning router's mount ('' for the public router,
  // '/api/admin' for the admin router). base + path is the full mounted pattern.
  return `${req.baseUrl}${path}` || 'unmatched';
}

function isEventStream(res: Response): boolean {
  const contentType = res.getHeader('content-type');
  return typeof contentType === 'string' && contentType.includes('text/event-stream');
}

export const requestLog: RequestHandler = (req, res, next) => {
  if (instrumented.has(res)) {
    next();
    return;
  }
  instrumented.add(res);

  const startedAt = process.hrtime.bigint();
  let logged = false;

  const emit = (aborted: boolean): void => {
    if (logged) return;
    logged = true;

    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
    const route = routePattern(req);
    const gameId = typeof req.params?.gameId === 'string' ? req.params.gameId : undefined;
    const requestId = req.get('lambda-web-request-id');

    logger.info(
      {
        ...(requestId !== undefined ? { requestId } : {}),
        method: req.method,
        route,
        status: res.statusCode,
        durationMs,
        // Only include optional facets when they apply — gameId is safe to log
        // (not sensitive); aborted flags a client disconnect before completion.
        ...(gameId !== undefined ? { gameId } : {}),
        ...(aborted ? { aborted: true } : {}),
      },
      'request',
    );

    // SSE streams are long-lived; their duration is a connection lifetime, not a
    // request latency, so they are logged above but excluded from the metric.
    if (isEventStream(res)) return;
    emitMetric('RequestLatencyMs', durationMs, 'Milliseconds', { Route: route });
  };

  res.on('finish', () => emit(false));
  res.on('close', () => {
    if (!res.writableFinished) emit(true);
  });

  next();
};
