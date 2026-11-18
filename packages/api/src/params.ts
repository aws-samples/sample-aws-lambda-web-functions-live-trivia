import type { Request } from 'express';

/**
 * Read a required route param as a string. Express 5's types widen param values
 * to `string | string[] | undefined`; for our defined routes (`:gameId`, etc.)
 * the value is always a present string at runtime. Missing → '' (lookups then
 * 404 cleanly) rather than throwing.
 */
export function reqParam(req: Request, key: string): string {
  const v = req.params[key];
  return typeof v === 'string' ? v : '';
}
