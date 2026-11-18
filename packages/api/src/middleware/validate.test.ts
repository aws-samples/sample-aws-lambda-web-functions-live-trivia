import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { z } from 'zod';
import { validateBody } from './validate.ts';

describe('validateBody', () => {
  const app = express();
  app.use(express.json());
  app.post(
    '/selection',
    validateBody(
      z.object({ selection: z.object({ count: z.number().int().positive() }) }),
    ),
    (req, res) => res.json(req.body),
  );
  app.post(
    '/name',
    validateBody(z.object({ name: z.string().trim() })),
    (req, res) => res.json(req.body),
  );

  let server: ReturnType<typeof app.listen>;
  let baseUrl: string;

  beforeAll(async () => {
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.on('error', reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('keeps the structured validation envelope and nested issue path', async () => {
    const response = await fetch(`${baseUrl}/selection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection: { count: 0 } }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'VALIDATION',
        message: expect.stringMatching(/^selection\.count: /),
      },
    });
  });

  it('replaces the request body with parsed output before continuing', async () => {
    const response = await fetch(`${baseUrl}/name`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Sample game  ', ignored: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'Sample game' });
  });
});
