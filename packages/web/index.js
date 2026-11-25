/* global console, process */
import express from 'express';
import { join } from 'node:path';
import { securityHeaders } from './security-headers.js';

const app = express();
const distDirectory = join(import.meta.dirname, 'dist');
const apiBaseUrl = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const cognito = {
  region: process.env.COGNITO_REGION ?? '',
  userPoolId: process.env.COGNITO_USER_POOL_ID ?? '',
  clientId: process.env.COGNITO_APP_CLIENT_ID ?? '',
};

app.disable('x-powered-by');
const responseSecurityHeaders = securityHeaders(apiBaseUrl, cognito.region);
app.use((_request, response, next) => {
  for (const [name, value] of Object.entries(responseSecurityHeaders)) {
    response.set(name, value);
  }
  next();
});

// One built SPA points at any API — local, HomeRegion, MultiRegion — because the
// URL is served at runtime, not baked into the browser bundle.
app.get('/config.json', (_request, response) => {
  response.set('Cache-Control', 'no-store');
  response.json({ apiBaseUrl, cognito });
});

// Serve the built SPA, then fall back to index.html so client-side routes work.
app.use(express.static(distDirectory, { index: false, maxAge: '1h' }));
app.get(['/', '/*splat'], (_request, response) => {
  response.set('Cache-Control', 'no-cache');
  response.sendFile(join(distDirectory, 'index.html'));
});

// The SAME bind as the API: listen on the address Lambda chose. No PORT variable.
const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '127.0.0.1:3001').split(':');
app.listen(port, host, () => {
  console.log(
    JSON.stringify({ level: 'info', message: 'serverlessq-web listening', host, port, apiBaseUrl }),
  );
});
