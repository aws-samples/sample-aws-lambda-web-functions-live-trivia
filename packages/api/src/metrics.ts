import { environmentName, functionName, region, revisionId } from '@serverlessq/shared';
import { currentEndpointName } from './requestContext.ts';

/**
 * Emit a CloudWatch EMF (embedded metric format) metric line (DD-12/NFR-14).
 * The Lambda log agent extracts these into CloudWatch metrics under the
 * "ServerlessQ" namespace with `region`, optional `environment`, and the
 * deployed API `FunctionName` dimensions. Requests received through a named
 * Web Function endpoint also emit one endpoint-attributed series in the
 * "ServerlessQ/Endpoint" namespace. No PutMetricData call on the hot path;
 * it's just a structured stdout line.
 */
type Unit = 'Count' | 'Milliseconds' | 'None';

export function emitMetric(
  name: string,
  value: number,
  unit: Unit = 'Count',
  dims?: Record<string, string>,
): void {
  const extraKeys = dims ? Object.keys(dims) : [];
  const base = [
    'region',
    ...(environmentName ? ['environment'] : []),
    ...(functionName ? ['FunctionName'] : []),
  ];
  const endpointName = currentEndpointName();
  const aggregateDimensions: string[][] = [
    [...base, ...extraKeys],
    [...base, 'revision', ...extraKeys],
  ];
  const endpointDimensions: string[][] = endpointName
    ? [[...base, 'EndpointName', ...extraKeys]]
    : [];
  const metric = { Name: name, Unit: unit };

  const line: Record<string, unknown> = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'ServerlessQ',
          Dimensions: aggregateDimensions,
          Metrics: [metric],
        },
        ...(endpointName
          ? [
              {
                Namespace: 'ServerlessQ/Endpoint',
                Dimensions: endpointDimensions,
                Metrics: [metric],
              },
            ]
          : []),
      ],
    },
    region,
    ...(environmentName ? { environment: environmentName } : {}),
    ...(functionName ? { FunctionName: functionName } : {}),
    revision: revisionId,
    ...(endpointName ? { EndpointName: endpointName } : {}),
    ...dims,
    [name]: value,
  };

  // Write the EMF object as a bare JSON line on stdout, NOT via console.*: a
  // Lambda Web Function wraps console output inside its own JSON log event, and
  // CloudWatch does not extract EMF from that wrapped object — only an
  // unwrapped JSON line on stdout is picked up (Lambda Web Functions EMF docs).
  process.stdout.write(JSON.stringify(line) + '\n');
}
