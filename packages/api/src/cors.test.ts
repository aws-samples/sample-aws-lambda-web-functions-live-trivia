import type { CorsOptions } from 'cors';
import { describe, expect, it } from 'vitest';
import { corsOrigin } from './cors.ts';

type OriginCallback = Exclude<
  CorsOptions['origin'],
  boolean | string | RegExp | unknown[] | undefined
>;

function checkOrigin(
  originSetting: CorsOptions['origin'],
  requestOrigin?: string,
): Promise<boolean> {
  expect(originSetting).toBeTypeOf('function');

  return new Promise((resolve, reject) => {
    (originSetting as OriginCallback)(requestOrigin, (error, allowedOrigin) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(allowedOrigin === true);
    });
  });
}

describe('corsOrigin', () => {
  it.each([undefined, ''])(
    'denies production browser origins when WEB_ORIGIN is %j',
    async (value) => {
      await expect(
        checkOrigin(corsOrigin(value, 'production'), 'https://viewer.example'),
      ).resolves.toBe(false);
      await expect(
        checkOrigin(corsOrigin(value, 'production'), 'http://127.0.0.1:5173'),
      ).resolves.toBe(false);
    },
  );

  it('allows only the explicit loopback Vite origin in development by default', async () => {
    const origin = corsOrigin(undefined, 'development');
    await expect(checkOrigin(origin, 'http://127.0.0.1:5173')).resolves.toBe(true);
    await expect(checkOrigin(origin, 'http://localhost:5173')).resolves.toBe(false);
    await expect(checkOrigin(origin, 'https://viewer.example')).resolves.toBe(false);
  });

  it('does not add the development origin to an explicit allowlist', async () => {
    await expect(
      checkOrigin(corsOrigin('https://viewer.example', 'development'), 'http://127.0.0.1:5173'),
    ).resolves.toBe(false);
  });

  it('keeps no-Origin service requests usable before configuration', async () => {
    await expect(checkOrigin(corsOrigin(undefined, 'production'))).resolves.toBe(true);
  });

  it('allows exact origins from a comma-separated configuration', async () => {
    const origin = corsOrigin('https://one.example, https://two.example');

    await expect(checkOrigin(origin, 'https://one.example')).resolves.toBe(true);
    await expect(checkOrigin(origin, 'https://two.example')).resolves.toBe(true);
  });

  it('allows non-browser requests without an Origin header', async () => {
    await expect(checkOrigin(corsOrigin('https://viewer.example'))).resolves.toBe(true);
  });

  it('rejects origins that are not configured', async () => {
    await expect(
      checkOrigin(corsOrigin('https://viewer.example'), 'https://unlisted.example'),
    ).resolves.toBe(false);
  });

  it('normalizes a trailing slash in a configured origin', async () => {
    await expect(
      checkOrigin(corsOrigin('https://viewer.example/'), 'https://viewer.example'),
    ).resolves.toBe(true);
  });

  it.each([
    'not-an-origin',
    ' ',
    ',',
    ' , ',
    'ftp://viewer.example',
    'https://*.example.com',
    'https://viewer.example/path',
    'https://viewer.example?query=yes',
    'https://viewer.example#fragment',
  ])('rejects invalid configured origin %s', (configuredOrigin) => {
    expect(() => corsOrigin(configuredOrigin)).toThrow(/WEB_ORIGIN/);
  });
});
