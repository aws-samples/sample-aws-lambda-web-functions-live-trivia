import type { RequestHandler } from 'express';
import { AdminAuthError, verifyAdminJwt } from '../auth/adminJwt.ts';
import { sendError } from '../http.ts';
import { logger } from '../logger.ts';

/** Central gate for every /api/admin route, using Cognito access tokens. */
export const adminAuth: RequestHandler = async (req, res, next) => {
  const match = /^Bearer ([^\s]+)$/i.exec(req.header('authorization') ?? '');
  const provided = match?.[1] ?? '';
  if (!provided) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="admin"');
    sendError(res, 401, 'UNAUTHORIZED', 'Missing bearer token');
    return;
  }
  try {
    res.locals.admin = await verifyAdminJwt(provided);
    next();
  } catch (err) {
    const failure = err instanceof AdminAuthError ? err : new AdminAuthError(503);
    const status = failure.status;
    if (status === 401)
      res.setHeader('WWW-Authenticate', 'Bearer realm="admin", error="invalid_token"');
    if (status === 503) logger.error('admin authentication unavailable');
    sendError(res, status, failure.code, failure.message);
  }
};
