import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.AWS_REGION = 'ap-southeast-1';
process.env.REVISION_ID = 'rev-endpoint-test';
process.env.TRIVIA_ENV_NAME = 'live';
process.env.TRIVIA_FUNCTION_NAME = 'serverlessq-live-api';

vi.mock('../logger.ts', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

const { emitMetric } = await import('../metrics.ts');
const { requestContext } = await import('../requestContext.ts');
const { requestLog } = await import('./requestLog.ts');

async function exerciseRequest(endpointName?: string): Promise<void> {
  const req = {
    method: 'GET',
    baseUrl: '',
    route: { path: '/metric' },
    params: {},
    headers: endpointName ? { 'lambda-web-endpoint-name': endpointName } : {},
  } as unknown as Request;
  const responseEvents = new EventEmitter();
  const res = Object.assign(responseEvents, {
    statusCode: 200,
    writableFinished: true,
    getHeader: () => 'application/json',
  }) as unknown as Response;

  await new Promise<void>((resolve) => {
    requestContext(req, res, () => {
      requestLog(req, res, () => {
        emitMetric('PlayersJoined', 1);
        setImmediate(() => {
          responseEvents.emit('finish');
          resolve();
        });
      });
    });
  });
}

describe('request endpoint telemetry', () => {
  let writes: string[];

  beforeEach(() => {
    writes = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds the Lambda Web endpoint to route metrics without removing function-wide series', async () => {
    await exerciseRequest('global');

    const metrics = writes
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line._aws);
    expect(metrics).toHaveLength(2);
    for (const metric of metrics) {
      expect(metric.EndpointName).toBe('global');
      const cloudWatch = metric._aws as {
        CloudWatchMetrics: Array<{ Namespace: string; Dimensions: string[][] }>;
      };
      expect(cloudWatch.CloudWatchMetrics).toHaveLength(2);
      const aggregate = cloudWatch.CloudWatchMetrics[0]!;
      expect(aggregate.Namespace).toBe('ServerlessQ');
      expect(aggregate.Dimensions.every((set) => !set.includes('EndpointName'))).toBe(true);
      const endpoint = cloudWatch.CloudWatchMetrics[1]!;
      expect(endpoint.Namespace).toBe('ServerlessQ/Endpoint');
      expect(endpoint.Dimensions).toHaveLength(1);
      expect(endpoint.Dimensions.every((set) => set.includes('EndpointName'))).toBe(true);
    }
  });
});
