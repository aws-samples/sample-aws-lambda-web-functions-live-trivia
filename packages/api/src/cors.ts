import type { CorsOptions } from 'cors';

function normalizeConfiguredOrigin(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid WEB_ORIGIN value: ${value}`);
  }

  const isHttpOrigin = url.protocol === 'http:' || url.protocol === 'https:';
  const hasOriginOnly =
    !url.username &&
    !url.password &&
    (url.pathname === '' || url.pathname === '/') &&
    !url.search &&
    !url.hash;

  if (!isHttpOrigin || !hasOriginOnly || url.hostname.includes('*')) {
    throw new Error(`Invalid WEB_ORIGIN value: ${value}`);
  }

  return url.origin;
}

export function corsOrigin(
  webOrigin = process.env.WEB_ORIGIN,
  nodeEnv = process.env.NODE_ENV,
): CorsOptions['origin'] {
  const configuredOrigins =
    webOrigin === undefined || webOrigin === ''
      ? nodeEnv === 'development'
        ? ['http://127.0.0.1:5173']
        : []
      : webOrigin
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean);

  if (webOrigin !== undefined && webOrigin !== '' && configuredOrigins.length === 0) {
    throw new Error('Invalid WEB_ORIGIN value: configuration contains no origins');
  }

  const allowedOrigins = new Set(configuredOrigins.map(normalizeConfiguredOrigin));

  return (requestOrigin, callback) => {
    const allowed = requestOrigin === undefined || allowedOrigins.has(requestOrigin);
    callback(null, allowed);
  };
}
