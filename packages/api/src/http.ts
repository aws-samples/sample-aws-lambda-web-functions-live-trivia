import type { Response } from 'express';
import type { ApiErrorBody } from '@serverlessq/shared';

/** Send a structured error envelope `{ error: { code, message } }` (design §5). */
export function sendError(res: Response, status: number, code: string, message: string): void {
  const body: ApiErrorBody = { error: { code, message } };
  res.status(status).json(body);
}
