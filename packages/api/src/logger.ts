import { region, revisionId } from '@serverlessq/shared';
import pino from 'pino';

// Structured JSON logs at INFO (DD-12/NFR-14). CloudWatch ingests these directly.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Replaces pino's default pid/hostname base, so the sandbox noise still stays
  // out. Stamping revision + region on every line is what lets you attribute a
  // log to one of two revisions during a canary — Web Function metrics carry no
  // revision dimension.
  base: { region, revision: revisionId },
});
