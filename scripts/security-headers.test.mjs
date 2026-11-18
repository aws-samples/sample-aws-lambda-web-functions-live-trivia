import assert from 'node:assert/strict';
import test from 'node:test';
import { securityHeaders } from '../packages/web/security-headers.js';

test('web security headers restrict scripts and permit only required connections', () => {
  const headers = securityHeaders(
    'https://api.example.com/path',
    'ap-southeast-1',
  );
  const policy = headers['Content-Security-Policy'];

  assert.match(policy, /(?:^|; )script-src 'self'(?:;|$)/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
  assert.match(
    policy,
    /connect-src 'self' https:\/\/api\.example\.com https:\/\/cognito-idp\.ap-southeast-1\.amazonaws\.com/,
  );
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
});

test('invalid runtime configuration does not widen connect-src', () => {
  const policy = securityHeaders('not a URL', 'not-a-region')['Content-Security-Policy'];
  assert.match(policy, /(?:^|; )connect-src 'self'(?:;|$)/);
});
