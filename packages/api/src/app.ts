import express from 'express';
import type { ErrorRequestHandler } from 'express';
import cors from 'cors';
import { region, revisionId } from '@serverlessq/shared';
import { logger } from './logger.ts';
import { publicRouter } from './routers/public.ts';
import { adminRouter } from './routers/admin.ts';
import { requestContext } from './requestContext.ts';
import { requestLog } from './middleware/requestLog.ts';
import { corsOrigin } from './cors.ts';

const app = express();

// Capture Lambda's endpoint attribution once, before any application route emits telemetry.
app.use(requestContext);

// One proxy hop — the Lambda endpoint — sits in front of us, so trust it for req.ip.
app.set('trust proxy', 1);

// The SPA calls this API from a separate origin. Unconfigured production
// origins receive no CORS allow headers; Cognito protects admin routes separately.
app.use(cors({ origin: corsOrigin() }));

// Health check: which region and revision is actually serving this request.
// Public and unauthenticated; useful for verifying deployed configuration.
app.get('/api/health', requestLog, (_req, res) => {
  res.json({ status: 'ok', region: region ?? 'default-provider-chain', revision: revisionId });
});

// Reject compressed bodies before inflation and bound JSON parsing work.
app.use(express.json({ inflate: false, limit: '16kb' }));

// Feature routers: public game/answer/SSE routes, and admin behind a bearer token.
app.use(publicRouter);
app.use('/api/admin', adminRouter);

// Anything else is a structured 404.
app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
});

// Last line of defence: log the error, return a clean envelope, never a stack.
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const parserErrors: Record<string, { status: number; code: string; message: string }> = {
    'entity.too.large': {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'JSON body exceeds 16 KiB',
    },
    'encoding.unsupported': {
      status: 415,
      code: 'UNSUPPORTED_ENCODING',
      message: 'Compressed request bodies are not supported',
    },
    'entity.parse.failed': { status: 400, code: 'INVALID_JSON', message: 'Invalid JSON body' },
  };
  const parserError = parserErrors[err?.type as string];
  if (parserError) {
    const { status, code, message } = parserError;
    res.status(status).json({ error: { code, message } });
    return;
  }
  const requestId = req.get('lambda-web-request-id');
  logger.error({ err, ...(requestId !== undefined ? { requestId } : {}) }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
};
app.use(errorHandler);

// Lambda picks the host and port and passes them in AWS_LAMBDA_HTTP_ENDPOINT.
// There is no PORT variable — the app must listen on exactly what Lambda probes.
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '127.0.0.1:3000').split(':');
app.listen(Number(port), String(host), () => {
  logger.info({ host, port, revision: revisionId }, 'serverlessq-api listening');
});

export { app };
