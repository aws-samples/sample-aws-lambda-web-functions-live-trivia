import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

interface RequestContext {
  endpointName?: string;
}

const context = new AsyncLocalStorage<RequestContext>();
const safeEndpointName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const requestContext: RequestHandler = (req, _res, next) => {
  const header = req.headers['lambda-web-endpoint-name'];
  const endpointName =
    typeof header === 'string' && safeEndpointName.test(header) ? header : undefined;
  context.run({ endpointName }, next);
};

export function currentEndpointName(): string | undefined {
  return context.getStore()?.endpointName;
}
