import { URL } from 'node:url';

function safeOrigin(value) {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

function cognitoOrigin(region) {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(region)) return undefined;
  const dnsSuffix = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  return `https://cognito-idp.${region}.${dnsSuffix}`;
}

export function securityHeaders(apiBaseUrl, cognitoRegion) {
  const connectSources = new Set(["'self'"]);
  const apiOrigin = safeOrigin(apiBaseUrl);
  const identityOrigin = cognitoOrigin(cognitoRegion);
  if (apiOrigin) connectSources.add(apiOrigin);
  if (identityOrigin) connectSources.add(identityOrigin);

  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'none'",
      `connect-src ${[...connectSources].join(' ')}`,
      "font-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "img-src 'self' data:",
      "manifest-src 'self'",
      "media-src 'none'",
      "object-src 'none'",
      "script-src 'self'",
      // Chakra/Emotion injects style elements at runtime. Scripts remain
      // restricted to same-origin files and cannot use eval or inline code.
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}
