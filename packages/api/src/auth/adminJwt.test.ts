import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { createAdminJwtVerifier } from './adminJwt.ts';

const config = { userPoolId: 'us-east-1_fixture', clientId: 'fixtureclient', region: 'us-east-1' };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = {
  keys: [
    {
      ...publicKey.export({ format: 'jwk' }),
      kty: 'RSA',
      kid: 'fixture',
      use: 'sig',
      alg: 'RS256',
    },
  ],
};
const verify = () => createAdminJwtVerifier(config, { jwks });
function token(overrides: Record<string, unknown> = {}, key = privateKey, kid = 'fixture') {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', kid })}.${encode({
    iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fixture',
    sub: 'admin-user',
    client_id: 'fixtureclient',
    token_use: 'access',
    exp: Math.floor(Date.now() / 1000) + 900,
    iat: Math.floor(Date.now() / 1000),
    'cognito:groups': ['admins'],
    ...overrides,
  })}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

describe('admin Cognito identity before group authorization', () => {
  it('accepts a signed access token with exact admins membership', async () => {
    await expect(verify()(token())).resolves.toEqual({ sub: 'admin-user', groups: ['admins'] });
  });
  it.each([
    ['expired', { exp: 1 }],
    ['missing expiry', { exp: undefined }],
    ['missing subject', { sub: undefined }],
    ['missing issuer', { iss: undefined }],
    ['wrong issuer', { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_other' }],
    ['wrong client', { client_id: 'other' }],
    ['ID token', { token_use: 'id', aud: 'fixtureclient' }],
    ['missing token use', { token_use: undefined }],
    ['expired non-admin', { exp: 1, 'cognito:groups': [] }],
  ])('rejects %s identity as 401', async (_name, claims) => {
    await expect(verify()(token(claims))).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });
  it.each(['', 'not-a-jwt', 'a.b.c'])('rejects malformed identity %j as 401', async (value) => {
    await expect(verify()(value)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects an invalid signature as 401', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(verify()(token({}, other.privateKey))).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    { groups: undefined },
    { groups: [] },
    { groups: ['Admins'] },
    { groups: ['superadmins'] },
    { groups: 'admins' },
  ])('rejects authenticated non-admin groups $groups as 403', async ({ groups }) => {
    await expect(verify()(token({ 'cognito:groups': groups }))).rejects.toMatchObject({
      status: 403,
    });
  });
  it('accepts admins alongside other groups', async () => {
    await expect(verify()(token({ 'cognito:groups': ['hosts', 'admins'] }))).resolves.toMatchObject(
      { sub: 'admin-user' },
    );
  });
  it('fails closed with 503 for missing or inconsistent configuration', async () => {
    for (const invalid of [
      { ...config, clientId: '' },
      { ...config, region: 'eu-west-1' },
    ]) {
      await expect(createAdminJwtVerifier(invalid)(token())).rejects.toMatchObject({
        status: 503,
        code: 'AUTH_UNAVAILABLE',
      });
    }
  });
  it('fails closed with 503 when JWKS fetching is unavailable', async () => {
    const unavailable = createAdminJwtVerifier(config, {
      jwksCache: new SimpleJwksCache({
        fetcher: {
          fetch: async () => {
            throw new Error('JWKS transport unavailable');
          },
        },
      }),
    });
    await expect(unavailable(token())).rejects.toMatchObject({
      status: 503,
      code: 'AUTH_UNAVAILABLE',
    });
    await expect(unavailable(token())).rejects.toMatchObject({
      status: 503,
      code: 'AUTH_UNAVAILABLE',
    });
  });
  it('keeps unknown signing keys unauthorized during the healthy JWKS fetch penalty', async () => {
    const unknownKey = createAdminJwtVerifier(config, {
      jwksCache: new SimpleJwksCache({
        fetcher: {
          fetch: async () => new TextEncoder().encode(JSON.stringify({ keys: [] })).buffer,
        },
      }),
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(unknownKey(token())).rejects.toMatchObject({
        status: 401,
        code: 'UNAUTHORIZED',
      });
    }
  });
  it.each(['available', 'unavailable'] as const)(
    'retries a different rotated key after an unrelated miss when JWKS is %s',
    async (availability) => {
      vi.useFakeTimers();
      try {
        let fetches = 0;
        const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const verifyRotated = createAdminJwtVerifier(config, {
          jwksCache: new SimpleJwksCache({
            fetcher: {
              fetch: async () => {
                fetches++;
                if (fetches > 1 && availability === 'unavailable')
                  throw new Error('JWKS transport unavailable');
                return new TextEncoder().encode(
                  JSON.stringify(
                    fetches === 1
                      ? jwks
                      : {
                          keys: [
                            {
                              ...rotated.publicKey.export({ format: 'jwk' }),
                              kty: 'RSA',
                              kid: 'rotated',
                              use: 'sig',
                              alg: 'RS256',
                            },
                          ],
                        },
                  ),
                ).buffer;
              },
            },
          }),
        });
        await expect(verifyRotated(token({}, privateKey, 'bogus'))).rejects.toMatchObject({
          status: 401,
        });
        await expect(verifyRotated(token({}, privateKey, 'bogus'))).rejects.toMatchObject({
          status: 401,
        });
        expect(fetches).toBe(1);
        const result = verifyRotated(token({}, rotated.privateKey, 'rotated')).then(
          (principal) => ({ principal }),
          (error: unknown) => ({ error }),
        );
        await vi.advanceTimersByTimeAsync(10_000);
        if (availability === 'available') {
          expect(await result).toEqual({
            principal: { sub: 'admin-user', groups: ['admins'] },
          });
          // A fetched key still has to verify the actual cryptographic signature.
          await expect(verifyRotated(token({}, privateKey, 'rotated'))).rejects.toMatchObject({
            status: 401,
          });
        } else {
          expect(await result).toMatchObject({
            error: { status: 503, code: 'AUTH_UNAVAILABLE' },
          });
        }
        expect(fetches).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('fails closed with 503 when the signing key is unusable', async () => {
    const invalidKey = createAdminJwtVerifier(config, {
      jwks: { keys: [{ kid: 'fixture', kty: 'RSA', use: 'sig' }] },
    });
    await expect(invalidKey(token())).rejects.toMatchObject({
      status: 503,
      code: 'AUTH_UNAVAILABLE',
    });
  });
});
