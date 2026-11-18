import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pin region + revision BEFORE anything pulls in @serverlessq/shared, since its
// config reads these from the environment at module-eval time.
process.env.AWS_REGION = 'us-west-2';
process.env.REVISION_ID = 'rev-test';
process.env.TRIVIA_ENV_NAME = 'live';
process.env.TRIVIA_FUNCTION_NAME = 'serverlessq-live-api';

const { emitMetric } = await import('./metrics.ts');

/**
 * The EMF line contract (plan: canary-observability). A metric must be a bare
 * JSON line on stdout — not console.*, which Lambda wraps in its own log event
 * so CloudWatch never extracts the embedded metric.
 */
describe('emitMetric EMF line', () => {
  let writes: string[];
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writes = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function soleLine(): { raw: string; obj: Record<string, unknown> } {
    expect(writes).toHaveLength(1);
    const raw = writes[0]!;
    // Exactly one trailing newline, and the body parses as JSON.
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.slice(0, -1).includes('\n')).toBe(false);
    return { raw, obj: JSON.parse(raw) as Record<string, unknown> };
  }

  function cwMetrics(obj: Record<string, unknown>) {
    const aws = obj._aws as { CloudWatchMetrics: Array<Record<string, unknown>> };
    return aws.CloudWatchMetrics[0]!;
  }

  it('writes a parsable JSON line with a newline, never via console.log', () => {
    emitMetric('PlayersJoined', 1);

    const { obj } = soleLine();
    expect(consoleLog).not.toHaveBeenCalled();

    const cw = cwMetrics(obj);
    expect(cw.Namespace).toBe('ServerlessQ');
    // No extra dims → function-scoped environment and revision series.
    expect(cw.Dimensions).toEqual([
      ['region', 'environment', 'FunctionName'],
      ['region', 'environment', 'FunctionName', 'revision'],
    ]);
    expect(cw.Metrics).toEqual([{ Name: 'PlayersJoined', Unit: 'Count' }]);

    // Root carries each dimension's value and the metric value itself.
    expect(obj.region).toBe('us-west-2');
    expect(obj.environment).toBe('live');
    expect(obj.FunctionName).toBe('serverlessq-live-api');
    expect(obj.revision).toBe('rev-test');
    expect(obj.PlayersJoined).toBe(1);
  });

  it('appends caller dimensions to BOTH dimension sets and the root', () => {
    emitMetric('RequestLatencyMs', 12.3, 'Milliseconds', { Route: '/api/games/:gameId' });

    const { obj } = soleLine();
    const cw = cwMetrics(obj);

    expect(cw.Dimensions).toEqual([
      ['region', 'environment', 'FunctionName', 'Route'],
      ['region', 'environment', 'FunctionName', 'revision', 'Route'],
    ]);
    expect(cw.Metrics).toEqual([{ Name: 'RequestLatencyMs', Unit: 'Milliseconds' }]);
    expect(obj.Route).toBe('/api/games/:gameId');
    expect(obj.region).toBe('us-west-2');
    expect(obj.revision).toBe('rev-test');
    expect(obj.RequestLatencyMs).toBe(12.3);
  });

  it('defaults the unit to Count and emits the RoundClosed trigger shape', () => {
    emitMetric('RoundClosed', 1, 'Count', { Trigger: 'host' });

    const { obj } = soleLine();
    const cw = cwMetrics(obj);
    expect(cw.Dimensions).toEqual([
      ['region', 'environment', 'FunctionName', 'Trigger'],
      ['region', 'environment', 'FunctionName', 'revision', 'Trigger'],
    ]);
    expect(obj.Trigger).toBe('host');
    expect(obj.RoundClosed).toBe(1);
  });
});

// From 18e49b6: named environments (TRIVIA_ENV_NAME) add an `environment`
// dimension so demo1..demo4 don't share one metric series.
describe('environment metrics', () => {
  afterEach(() => {
    delete process.env.TRIVIA_ENV_NAME;
    delete process.env.TRIVIA_FUNCTION_NAME;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function emitIn(environment: string | undefined, functionName?: string) {
    if (environment) process.env.TRIVIA_ENV_NAME = environment;
    else delete process.env.TRIVIA_ENV_NAME;
    if (functionName) process.env.TRIVIA_FUNCTION_NAME = functionName;
    else delete process.env.TRIVIA_FUNCTION_NAME;
    vi.resetModules();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const { emitMetric: emit } = await import('./metrics.ts');
    emit('AnswersSubmitted', 1);
    return JSON.parse(writes[0]!) as {
      environment?: string;
      FunctionName?: string;
      AnswersSubmitted: number;
      _aws: { CloudWatchMetrics: Array<{ Dimensions: string[][] }> };
    };
  }

  it('keeps metrics from separate demo environments distinct', async () => {
    for (const environment of ['demo1', 'demo2']) {
      const functionName = `serverlessq-${environment}-api`;
      const metric = await emitIn(environment, functionName);
      expect(metric.environment).toBe(environment);
      expect(metric.FunctionName).toBe(functionName);
      expect(metric._aws.CloudWatchMetrics[0]!.Dimensions).toEqual([
        ['region', 'environment', 'FunctionName'],
        ['region', 'environment', 'FunctionName', 'revision'],
      ]);
      expect(metric.AnswersSubmitted).toBe(1);
    }
  });

  it('preserves the original deployment metric dimensions', async () => {
    const metric = await emitIn(undefined);
    expect(metric.environment).toBeUndefined();
    expect(metric.FunctionName).toBeUndefined();
    expect(metric._aws.CloudWatchMetrics[0]!.Dimensions).toEqual([
      ['region'],
      ['region', 'revision'],
    ]);
  });
});
