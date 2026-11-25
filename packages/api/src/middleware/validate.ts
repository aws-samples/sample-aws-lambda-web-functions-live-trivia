import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';
import { sendError } from '../http.ts';

/**
 * zod body-validation middleware (design §3.2 chain: … → zod → route). On
 * failure returns 400 with the structured error envelope; on success replaces
 * req.body with the parsed (typed) value.
 */
export function validateBody<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first?.path.join('.');
      const message = first ? `${path ? path + ': ' : ''}${first.message}` : 'Invalid request body';
      sendError(res, 400, 'VALIDATION', message);
      return;
    }
    req.body = result.data;
    next();
  };
}
