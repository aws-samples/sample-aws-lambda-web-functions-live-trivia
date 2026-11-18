import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ddbRegion } from '../config.js';

/**
 * Single DynamoDB Document client, created once at module scope and reused
 * across all concurrent requests in the sandbox (multi-concurrency rule,
 * design §3.2).
 *
 * Pinned to `ddbRegion` (DDB_REGION), never the sandbox's own AWS_REGION: the
 * tables are regional, so they live in one region no matter where this function
 * is serving from. Every DynamoDB call in the app goes through this client, so
 * this line is the single place that choice is made.
 */
const baseClient = new DynamoDBClient({ region: ddbRegion });

export const ddb = DynamoDBDocumentClient.from(baseClient, {
  marshallOptions: {
    // Let optional fields be omitted rather than stored as NULL.
    removeUndefinedValues: true,
  },
});
