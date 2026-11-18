import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Shared from '@serverlessq/shared';
import type * as AdminJwt from '../auth/adminJwt.ts';
import { generateKeyPairSync, sign } from 'node:crypto';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';

const identity = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../auth/adminJwt.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof AdminJwt>()),
  verifyAdminJwt: identity.verify,
}));
vi.mock('@serverlessq/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof Shared>();
  return {
    ...actual,
    gamesRepo: { ...actual.gamesRepo, listGames: async () => [], listActiveGames: async () => [] },
  };
});
const { adminRouter } = await import('../routers/admin.ts');
const { publicRouter } = await import('../routers/public.ts');
const { createAdminJwtVerifier, AdminAuthError } = await import('../auth/adminJwt.ts');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const localVerify = createAdminJwtVerifier(
  { userPoolId: 'us-east-1_fixture', clientId: 'fixtureclient', region: 'us-east-1' },
  {
    jwks: {
      keys: [{ ...publicKey.export({ format: 'jwk' }), kty: 'RSA', kid: 'fixture', use: 'sig' }],
    },
  },
);
function signedToken(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', kid: 'fixture' })}.${encode({
    iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture',
    sub: 'admin-user',
    client_id: 'fixtureclient',
    token_use: 'access',
    exp: Math.floor(Date.now() / 1000) + 900,
    ...claims,
  })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(publicRouter);
  app.use('/api/admin', adminRouter);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
describe('central admin route gate', () => {
  it('keeps the bearer challenge on repeated unknown-key requests after a healthy JWKS fetch', async () => {
    const unknownKey = createAdminJwtVerifier(
      { userPoolId: 'us-east-1_fixture', clientId: 'fixtureclient', region: 'us-east-1' },
      {
        jwksCache: new SimpleJwksCache({
          fetcher: {
            fetch: async () => new TextEncoder().encode(JSON.stringify({ keys: [] })).buffer,
          },
        }),
      },
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      identity.verify.mockImplementationOnce(unknownKey);
      const response = await fetch(`${base}/api/admin/games`, {
        headers: { authorization: `Bearer ${signedToken({ 'cognito:groups': ['admins'] })}` },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer');
      expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }
  });
  it.each([undefined, 'Basic ignored', 'Bearer', 'Bearer a b'])(
    'challenges missing or malformed header %j',
    async (authorization) => {
      const response = await fetch(`${base}/api/admin/games`, {
        headers: authorization ? { authorization } : {},
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer');
    },
  );
  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [503, 'AUTH_UNAVAILABLE'],
  ])('returns %i for verifier failure', async (status, code) => {
    identity.verify.mockRejectedValueOnce(new AdminAuthError(status as 401 | 403 | 503));
    const response = await fetch(`${base}/api/admin/games`, {
      headers: { authorization: 'Bearer fixture' },
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(response.headers.has('www-authenticate')).toBe(status === 401);
  });
  it('allows authenticated admins to use the real admin router', async () => {
    identity.verify.mockResolvedValueOnce({ sub: 'admin-user', groups: ['admins'] });
    const response = await fetch(`${base}/api/admin/games`, {
      headers: { authorization: 'Bearer fixture' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ games: [] });
  });
  it('hides unexpected verifier error details behind an availability failure', async () => {
    identity.verify.mockRejectedValueOnce(new Error('private verifier internals'));
    const response = await fetch(`${base}/api/admin/games`, {
      headers: { authorization: 'Bearer fixture' },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: 'AUTH_UNAVAILABLE',
        message: 'Admin authentication temporarily unavailable',
      },
    });
  });
  it('gates unknown admin paths too', async () => {
    expect((await fetch(`${base}/api/admin/not-a-route`)).status).toBe(401);
  });
  it('keeps the real public game directory anonymous', async () => {
    const response = await fetch(`${base}/api/games/active`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ games: [] });
  });
  it.each([
    ['expired non-admin', { exp: 1, 'cognito:groups': [] }, 401],
    ['wrong client', { client_id: 'other', 'cognito:groups': ['admins'] }, 401],
    ['non-admin', { 'cognito:groups': ['hosts'] }, 403],
    ['admin', { 'cognito:groups': ['admins'] }, 200],
  ])('enforces real cryptographic verification for %s', async (_name, claims, status) => {
    identity.verify.mockImplementationOnce(localVerify);
    const response = await fetch(`${base}/api/admin/games`, {
      headers: { authorization: `Bearer ${signedToken(claims)}` },
    });
    expect(response.status).toBe(status);
    expect(response.headers.has('www-authenticate')).toBe(status === 401);
  });
});
