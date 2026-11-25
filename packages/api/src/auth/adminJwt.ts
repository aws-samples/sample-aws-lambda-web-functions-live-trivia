import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { CognitoJwtVerifierSingleUserPool } from 'aws-jwt-verify/cognito-verifier';
import {
  JwtInvalidClaimError,
  JwtInvalidSignatureError,
  JwtInvalidSignatureAlgorithmError,
  JwtParseError,
  JwtWithoutValidKidError,
  KidNotFoundInJwksError,
  WaitPeriodNotYetEndedJwkError,
} from 'aws-jwt-verify/error';
import type { Jwks, JwksCache } from 'aws-jwt-verify/jwk';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { decomposeUnverifiedJwt } from 'aws-jwt-verify/jwt';
import { cognitoConfig } from '@serverlessq/shared';

export interface AdminPrincipal {
  sub: string;
  groups: string[];
}
export interface AdminJwtConfig {
  userPoolId: string;
  clientId: string;
  region: string;
}
export class AdminAuthError extends Error {
  readonly status: 401 | 403 | 503;
  readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'AUTH_UNAVAILABLE';
  constructor(status: 401 | 403 | 503) {
    super(
      status === 503
        ? 'Admin authentication temporarily unavailable'
        : status === 403
          ? 'Administrator group membership required'
          : 'Invalid or expired access token',
    );
    this.name = 'AdminAuthError';
    this.status = status;
    this.code = status === 503 ? 'AUTH_UNAVAILABLE' : status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED';
  }
}

/** Retain the URL-wide fetch backoff without mistaking it for a per-key miss. */
function rotationAwareCache(cache: JwksCache): JwksCache {
  const backoffMs = 10_000; // SimpleJwksCache's default healthy-fetch penalty.
  const absent = new Map<string, { until: number; kids: Set<string> }>();
  const waiting = new Map<string, Promise<void>>();
  const lookup: JwksCache['getJwk'] = async (uri, jwt) => {
    try {
      return await cache.getJwk(uri, jwt);
    } catch (error) {
      if (error instanceof KidNotFoundInJwksError && typeof jwt.header.kid === 'string') {
        let missing = absent.get(uri);
        if (!missing || missing.until <= Date.now()) {
          missing = { until: Date.now() + backoffMs, kids: new Set() };
          absent.set(uri, missing);
        }
        missing.kids.add(jwt.header.kid);
      }
      throw error;
    }
  };
  return {
    addJwks: (uri, jwks) => cache.addJwks(uri, jwks),
    getJwks: (uri) => cache.getJwks(uri),
    getCachedJwk: (uri, jwt) => cache.getCachedJwk(uri, jwt),
    async getJwk(uri, jwt) {
      try {
        return await lookup(uri, jwt);
      } catch (error) {
        if (!(error instanceof WaitPeriodNotYetEndedJwkError)) throw error;
        const missing = absent.get(uri);
        if (
          missing &&
          missing.until > Date.now() &&
          typeof jwt.header.kid === 'string' &&
          missing.kids.has(jwt.header.kid)
        ) {
          throw new KidNotFoundInJwksError('Signing key confirmed absent from JWKS');
        }
        // A different kid may be a newly rotated key. Wait out the URL-wide
        // penalty, sharing the wait across requests, then retry through the
        // library cache. Never bypass its backoff or cryptographic verification.
        let retry = waiting.get(uri);
        if (!retry) {
          retry = new Promise<void>((resolve) => {
            setTimeout(
              resolve,
              Math.max(0, (missing?.until ?? Date.now() + backoffMs) - Date.now()),
            );
          }).finally(() => waiting.delete(uri));
          waiting.set(uri, retry);
        }
        await retry;
        return lookup(uri, jwt);
      }
    },
  };
}

/** Identity is verified before inspecting authorization claims. No AWS credentials are needed. */
export function createAdminJwtVerifier(
  config: AdminJwtConfig,
  dependencies: { jwks?: Jwks; jwksCache?: JwksCache } = {},
): (token: string) => Promise<AdminPrincipal> {
  let verifier:
    | CognitoJwtVerifierSingleUserPool<{
        userPoolId: string;
        tokenUse: 'access';
        clientId: string;
      }>
    | undefined;
  try {
    if (!config.clientId || !config.region || !config.userPoolId.startsWith(`${config.region}_`)) {
      throw new Error('Cognito configuration missing or inconsistent');
    }
    verifier = CognitoJwtVerifier.create(
      {
        userPoolId: config.userPoolId,
        tokenUse: 'access',
        clientId: config.clientId,
      },
      { jwksCache: rotationAwareCache(dependencies.jwksCache ?? new SimpleJwksCache()) },
    );
    if (dependencies.jwks) verifier.cacheJwks(dependencies.jwks);
  } catch {
    // Keep the public API running when admin configuration is unavailable.
    verifier = undefined;
  }
  return async (token) => {
    if (!verifier) throw new AdminAuthError(503);
    let payload;
    try {
      // Reject unrelated issuers before a key lookup. This prefilter grants no
      // trust; the library still verifies all claims and the signature below.
      if (
        decomposeUnverifiedJwt(token).payload.iss !==
        CognitoJwtVerifier.parseUserPoolId(config.userPoolId).issuer
      ) {
        throw new AdminAuthError(401);
      }
      payload = await verifier.verify(token);
    } catch (error) {
      if (error instanceof AdminAuthError) throw error;
      const invalidIdentity =
        error instanceof JwtInvalidClaimError ||
        error instanceof JwtParseError ||
        error instanceof JwtInvalidSignatureError ||
        error instanceof JwtInvalidSignatureAlgorithmError ||
        error instanceof JwtWithoutValidKidError ||
        error instanceof KidNotFoundInJwksError;
      throw new AdminAuthError(invalidIdentity ? 401 : 503);
    }
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp)
    )
      throw new AdminAuthError(401);
    const groups = payload['cognito:groups'];
    if (!Array.isArray(groups) || !groups.includes('admins')) throw new AdminAuthError(403);
    return { sub: payload.sub, groups };
  };
}

export const verifyAdminJwt = createAdminJwtVerifier(cognitoConfig);
