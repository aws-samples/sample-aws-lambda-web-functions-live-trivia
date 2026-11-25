import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }));
vi.mock('./logger.ts', () => ({ logger }));

let server: Server;
let base: string;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('WEB_ORIGIN', 'https://web.example.test');
  vi.stubEnv('AWS_LAMBDA_HTTP_ENDPOINT', '127.0.0.1:0');
  // Observe the application's real listener to close it after exercising HTTP.
  const listen = express.application.listen;
  const observer = vi.spyOn(express.application, 'listen').mockImplementation(function (
    this: express.Application,
    ...args
  ) {
    server = listen.apply(this, args as Parameters<typeof listen>);
    return server;
  });
  await import('./app.ts');
  observer.mockRestore();
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  try {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

describe('application HTTP security boundaries', () => {
  it('correlates health request logs with the Lambda Web Function request ID', async () => {
    logger.info.mockClear();
    const requestId = 'NF5U6CMIUAWPER24GXDNDEZSVU';

    const response = await fetch(`${base}/api/health`, {
      headers: { 'lambda-web-request-id': requestId },
    });
    expect(response.status).toBe(200);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ requestId, route: '/api/health' }),
      'request',
    );
  });

  it('correlates unhandled errors with the Lambda Web Function request ID', async () => {
    logger.error.mockClear();
    const requestId = '2AE6YTKZLFCIRH24G2W4A6ICVM';

    const response = await fetch(`${base}/api/games/%E0%A4%A`, {
      headers: { 'lambda-web-request-id': requestId },
    });
    expect(response.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), requestId }),
      'unhandled error',
    );
  });

  it('allows the configured origin on health responses', async () => {
    const response = await fetch(`${base}/api/health`, {
      headers: { Origin: 'https://web.example.test' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://web.example.test');
  });

  it('does not emit CORS allow headers for rejected origins', async () => {
    const response = await fetch(`${base}/api/health`, {
      headers: { Origin: 'https://unlisted.example.test' },
    });
    expect(response.status).toBe(200);
    expect(
      [...response.headers.keys()].filter((header) => header.startsWith('access-control-allow-')),
    ).toEqual([]);
  });

  it('does not emit CORS allow headers for rejected preflight requests', async () => {
    const response = await fetch(`${base}/api/admin/games`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://unlisted.example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(
      [...response.headers.keys()].filter((header) => header.startsWith('access-control-allow-')),
    ).toEqual([]);
  });

  it('allows authenticated request headers for the configured origin preflight', async () => {
    const response = await fetch(`${base}/api/admin/games`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://web.example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://web.example.test');
    expect(response.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
  });

  it('keeps no-Origin health requests usable', async () => {
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('keeps admin authorization independent of allowed browser origins', async () => {
    const response = await fetch(`${base}/api/admin/games`, {
      headers: { Origin: 'https://web.example.test' },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://web.example.test');
  });

  async function postJson(body: string | Buffer, headers: Record<string, string> = {}) {
    return fetch(`${base}/not-a-route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  }

  it('accepts uncompressed JSON at the 16 KiB boundary', async () => {
    const body = JSON.stringify({ data: 'a'.repeat(16 * 1024 - 11) });
    expect(Buffer.byteLength(body)).toBe(16 * 1024);
    expect((await postJson(body)).status).toBe(404);
  });

  it('rejects JSON above 16 KiB before route handling', async () => {
    const response = await postJson(JSON.stringify({ data: 'a'.repeat(16 * 1024 - 10) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'JSON body exceeds 16 KiB' },
    });
  });

  it.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const)('rejects %s request bodies without inflating them', async (encoding, compress) => {
    const response = await postJson(compress(JSON.stringify({ data: 'a'.repeat(1024 * 1024) })), {
      'content-encoding': encoding,
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: {
        code: 'UNSUPPORTED_ENCODING',
        message: 'Compressed request bodies are not supported',
      },
    });
  });

  it('returns a bounded client error for malformed JSON', async () => {
    const response = await postJson('{"private-input":');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'INVALID_JSON', message: 'Invalid JSON body' },
    });
  });
});
