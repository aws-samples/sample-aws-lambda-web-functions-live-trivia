// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as AdminSession from './adminSession';
import { closeSdkWorkers, RealSdkWorker } from './testing/realSdkWorker';

let configureAdminAuth: typeof AdminSession.configureAdminAuth;
let currentAdminAccessToken: typeof AdminSession.currentAdminAccessToken;
let signInAdmin: typeof AdminSession.signInAdmin;
let finishNewPassword: typeof AdminSession.finishNewPassword;
let signOutAdmin: typeof AdminSession.signOutAdmin;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('Worker', RealSdkWorker);
  ({ configureAdminAuth, currentAdminAccessToken, signInAdmin, finishNewPassword, signOutAdmin } =
    await import('./adminSession'));
});

it.each(['success', 'challenge', 'failure', 'srp-verifier'] as const)(
  'finishes a fresh real Amplify new-password challenge after retired SRP sign-in %s',
  async (outcome) => {
    configureAdminAuth({
      region: 'us-east-1',
      userPoolId: 'us-east-1_fixture',
      clientId: 'fixtureclient',
    });
    let releaseOldSignIn!: (response: Response) => void;
    let markOldSignInStarted!: () => void;
    const oldSignInStarted = new Promise<void>((resolve) => {
      markOldSignInStarted = resolve;
    });
    const freshToken = storedAccessToken(undefined, 'fresh-user');
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const target = new Headers(init.headers).get('x-amz-target');
      const body = JSON.parse(init.body as string);
      if (target === 'AWSCognitoIdentityProviderService.InitiateAuth') {
        if (body.AuthParameters.USERNAME === 'old-user') {
          markOldSignInStarted();
          return new Promise<Response>((resolve) => {
            releaseOldSignIn = resolve;
          });
        }
        expect(body).toMatchObject({
          AuthFlow: 'USER_SRP_AUTH',
          AuthParameters: { USERNAME: 'fresh-user' },
        });
        return new Response(
          JSON.stringify({
            ChallengeName: 'NEW_PASSWORD_REQUIRED',
            Session: 'fresh-challenge-session',
            ChallengeParameters: { requiredAttributes: '[]' },
          }),
        );
      }
      expect(target).toBe('AWSCognitoIdentityProviderService.RespondToAuthChallenge');
      if (body.ChallengeName === 'PASSWORD_VERIFIER') {
        expect(body).toMatchObject({
          Session: 'old-verifier-session',
          ChallengeResponses: { USERNAME: 'old-user' },
        });
        return new Response(
          JSON.stringify({
            AuthenticationResult: {
              AccessToken: storedAccessToken(undefined, 'old-user'),
              RefreshToken: 'old-refresh-token',
              TokenType: 'Bearer',
              ExpiresIn: 900,
            },
          }),
        );
      }
      expect(body).toMatchObject({
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        Session: 'fresh-challenge-session',
        ChallengeResponses: { USERNAME: 'fresh-user', NEW_PASSWORD: 'fresh-permanent-password' },
      });
      return new Response(
        JSON.stringify({
          AuthenticationResult: {
            AccessToken: freshToken,
            RefreshToken: 'fresh-refresh-token',
            TokenType: 'Bearer',
            ExpiresIn: 900,
          },
        }),
      );
    });
    const oldResult = signInAdmin('old-user', 'temporary-password').catch((error: unknown) => ({
      error,
    }));
    await oldSignInStarted;
    await signOutAdmin();
    try {
      expect(await signInAdmin('fresh-user', 'temporary-password')).toBe('new-password');
      const freshStorage = { ...window.sessionStorage };
      const oldResponse =
        outcome === 'failure'
          ? new Response(JSON.stringify({ __type: 'NotAuthorizedException', message: 'Denied' }), {
              status: 400,
            })
          : outcome === 'challenge'
            ? new Response(
                JSON.stringify({
                  ChallengeName: 'NEW_PASSWORD_REQUIRED',
                  Session: 'old-challenge-session',
                  ChallengeParameters: { requiredAttributes: '[]' },
                }),
              )
            : outcome === 'srp-verifier'
              ? new Response(
                  JSON.stringify({
                    ChallengeName: 'PASSWORD_VERIFIER',
                    Session: 'old-verifier-session',
                    ChallengeParameters: {
                      USER_ID_FOR_SRP: 'old-user',
                      SRP_B: '2',
                      SALT: 'deadbeef',
                      SECRET_BLOCK: btoa('old-secret-block'),
                    },
                  }),
                )
              : new Response(
                  JSON.stringify({
                    AuthenticationResult: {
                      AccessToken: storedAccessToken(undefined, 'old-user'),
                      RefreshToken: 'old-refresh-token',
                      TokenType: 'Bearer',
                      ExpiresIn: 900,
                    },
                  }),
                );
      releaseOldSignIn(oldResponse);
      expect(await oldResult).toHaveProperty('error');
      expect({ ...window.sessionStorage }).toEqual(freshStorage);
      expect(await finishNewPassword('fresh-permanent-password')).toBe('signed-in');
      expect(await currentAdminAccessToken()).toBe(freshToken);
      expect(window.localStorage.length).toBe(0);
    } finally {
      releaseOldSignIn(new Response('{}', { status: 400 }));
      await oldResult;
    }
  },
);

afterEach(async () => {
  await closeSdkWorkers();
  vi.useRealTimers();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

it('finishes a fresh real Amplify challenge after the same user’s retired new-password confirmation completes', async () => {
  configureAdminAuth({
    region: 'us-east-1',
    userPoolId: 'us-east-1_fixture',
    clientId: 'fixtureclient',
  });
  let releaseOldConfirmation!: (response: Response) => void;
  let markOldConfirmationStarted!: () => void;
  const oldConfirmationStarted = new Promise<void>((resolve) => {
    markOldConfirmationStarted = resolve;
  });
  const freshToken = storedAccessToken();
  let signIns = 0;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const target = new Headers(init.headers).get('x-amz-target');
    const body = JSON.parse(init.body as string);
    if (target === 'AWSCognitoIdentityProviderService.InitiateAuth') {
      return new Response(
        JSON.stringify({
          ChallengeName: 'NEW_PASSWORD_REQUIRED',
          Session: ++signIns === 1 ? 'old-challenge-session' : 'fresh-challenge-session',
          ChallengeParameters: { requiredAttributes: '[]' },
        }),
      );
    }
    expect(target).toBe('AWSCognitoIdentityProviderService.RespondToAuthChallenge');
    if (body.Session === 'old-challenge-session') {
      markOldConfirmationStarted();
      return new Promise<Response>((resolve) => {
        releaseOldConfirmation = resolve;
      });
    }
    expect(body).toMatchObject({
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: 'fresh-challenge-session',
      ChallengeResponses: { USERNAME: 'admin-user', NEW_PASSWORD: 'fresh-permanent-password' },
    });
    return new Response(
      JSON.stringify({
        AuthenticationResult: {
          AccessToken: freshToken,
          RefreshToken: 'fresh-refresh-token',
          TokenType: 'Bearer',
          ExpiresIn: 900,
        },
      }),
    );
  });
  expect(await signInAdmin('admin-user', 'temporary-password')).toBe('new-password');
  const oldResult = finishNewPassword('old-permanent-password').catch((error: unknown) => ({
    error,
  }));
  await oldConfirmationStarted;
  await signOutAdmin();
  try {
    expect(await signInAdmin('admin-user', 'temporary-password')).toBe('new-password');
    const freshStorage = { ...window.sessionStorage };
    releaseOldConfirmation(
      new Response(
        JSON.stringify({
          AuthenticationResult: {
            AccessToken: storedAccessToken(1),
            RefreshToken: 'old-refresh-token',
            TokenType: 'Bearer',
            ExpiresIn: 900,
          },
        }),
      ),
    );
    expect(await oldResult).toHaveProperty('error');
    expect({ ...window.sessionStorage }).toEqual(freshStorage);
    expect(await finishNewPassword('fresh-permanent-password')).toBe('signed-in');
    expect(await currentAdminAccessToken()).toBe(freshToken);
    expect(window.localStorage.length).toBe(0);
  } finally {
    releaseOldConfirmation(new Response('{}', { status: 400 }));
    await oldResult;
  }
});

function storedAccessToken(
  exp = Math.floor(Date.now() / 1000) + 900,
  sub = 'admin-user',
  revocable = false,
) {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll('=', '');
  return `${encode({ alg: 'RS256' })}.${encode({
    sub,
    'cognito:groups': ['admins'],
    token_use: 'access',
    client_id: 'fixtureclient',
    iat: Math.floor(Date.now() / 1000),
    exp,
    ...(revocable ? { origin_jti: 'fixture-origin' } : {}),
  })}.fixture`;
}

function restoreSession(token: string) {
  const prefix = 'CognitoIdentityServiceProvider.fixtureclient';
  window.sessionStorage.setItem(`${prefix}.LastAuthUser`, 'admin-user');
  window.sessionStorage.setItem(`${prefix}.admin-user.accessToken`, token);
  window.sessionStorage.setItem(`${prefix}.admin-user.refreshToken`, 'fixture-refresh-token');
  configureAdminAuth({
    region: 'us-east-1',
    userPoolId: 'us-east-1_fixture',
    clientId: 'fixtureclient',
  });
}

it('restores real Amplify tokens from session storage without persisting them in local storage', async () => {
  const token = storedAccessToken();
  restoreSession(token);

  expect(await currentAdminAccessToken()).toBe(token);
  expect(window.localStorage.length).toBe(0);
});

it('bounds four real SDK workers with stalled refresh and RevokeToken requests', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  configureAdminAuth({
    region: 'us-east-1',
    userPoolId: 'us-east-1_fixture',
    clientId: 'fixtureclient',
  });
  let markRefreshStarted!: () => void;
  let markRevocationStarted!: () => void;
  const releaseRequests: (() => void)[] = [];
  const pendingResults: Promise<unknown>[] = [];
  const retirementResults: Promise<void>[] = [];
  const completedRetirements: number[] = [];
  const retiredWorkers: RealSdkWorker[] = [];
  const freshToken = storedAccessToken(undefined, 'fresh-user', true);
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const target = new Headers(init.headers).get('x-amz-target');
    const body = JSON.parse(init.body as string);
    if (target === 'AWSCognitoIdentityProviderService.InitiateAuth') {
      const username = body.AuthParameters.USERNAME as string;
      return new Response(
        JSON.stringify({
          AuthenticationResult: {
            AccessToken: freshToken,
            RefreshToken: `${username}-refresh-token`,
            TokenType: 'Bearer',
            ExpiresIn: 900,
          },
        }),
      );
    }
    if (target === 'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken') {
      expect(body.RefreshToken).toBe('fixture-refresh-token');
      markRefreshStarted();
      return new Promise<Response>((resolve) => {
        releaseRequests.push(() =>
          resolve(
            new Response(
              JSON.stringify({
                AuthenticationResult: {
                  AccessToken: storedAccessToken(undefined, 'retired-user', true),
                  RefreshToken: 'retired-refresh-token',
                  TokenType: 'Bearer',
                  ExpiresIn: 900,
                },
              }),
            ),
          ),
        );
      });
    }
    expect(target).toBe('AWSCognitoIdentityProviderService.RevokeToken');
    expect(body.ClientId).toBe('fixtureclient');
    if (body.Token === 'fresh-user-refresh-token') return new Response('{}');
    expect(body.Token).toBe('fixture-refresh-token');
    markRevocationStarted();
    return new Promise<Response>((resolve) => {
      releaseRequests.push(() => resolve(new Response('{}')));
    });
  });
  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      const refreshing = new Promise<void>((resolve) => {
        markRefreshStarted = resolve;
      });
      const revoking = new Promise<void>((resolve) => {
        markRevocationStarted = resolve;
      });
      restoreSession(storedAccessToken(1, 'admin-user', true));
      pendingResults.push(
        currentAdminAccessToken().then(
          (token) => ({ token }),
          (error: unknown) => ({ error }),
        ),
      );
      retiredWorkers.push(RealSdkWorker.instances.at(-1)!);
      await refreshing;
      retirementResults.push(
        signOutAdmin().then(() => {
          completedRetirements.push(cycle);
        }),
      );
      expect(window.sessionStorage.length).toBe(0);
      await revoking;
    }
    expect(releaseRequests).toHaveLength(8);
    expect(await signInAdmin('fresh-user', 'password')).toBe('signed-in');
    expect(await currentAdminAccessToken()).toBe(freshToken);
    const newest = RealSdkWorker.instances.at(-1)!;
    const freshStorage = { ...window.sessionStorage };
    await vi.advanceTimersByTimeAsync(1_999);
    expect(retiredWorkers.every((worker) => !worker.terminated)).toBe(true);
    expect(completedRetirements).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(retiredWorkers.every((worker) => worker.terminated)).toBe(true);
    await Promise.all(retiredWorkers.map((worker) => worker.exited));
    await Promise.all(retirementResults);
    for (const result of await Promise.all(pendingResults))
      expect(result).toMatchObject({
        error: { name: 'AdminSessionDenied', message: 'Administrator sign-in required' },
      });
    expect(completedRetirements).toEqual([0, 1, 2, 3]);
    expect(vi.getTimerCount()).toBe(0);
    expect(newest.terminated).toBe(false);
    for (const release of releaseRequests) release();
    expect({ ...window.sessionStorage }).toEqual(freshStorage);
    expect(await currentAdminAccessToken()).toBe(freshToken);
    expect(window.localStorage.length).toBe(0);
  } finally {
    for (const release of releaseRequests) release();
    await Promise.all([...pendingResults, ...retirementResults]);
    await signOutAdmin();
  }
});

it('completes real SDK revocation and releases its worker before the retirement deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const token = storedAccessToken(undefined, 'admin-user', true);
  restoreSession(token);
  expect(await currentAdminAccessToken()).toBe(token);
  const worker = RealSdkWorker.instances.at(-1)!;
  const revocations: unknown[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('x-amz-target')).toBe(
      'AWSCognitoIdentityProviderService.RevokeToken',
    );
    revocations.push(JSON.parse(init.body as string));
    return new Response('{}');
  });
  await signOutAdmin();
  expect(revocations).toEqual([{ ClientId: 'fixtureclient', Token: 'fixture-refresh-token' }]);
  expect(worker.terminated).toBe(true);
  await worker.exited;
  expect(vi.getTimerCount()).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
});

it('keeps real Amplify storage empty when a pending refresh completes after sign-out', async () => {
  restoreSession(storedAccessToken(1));
  let releaseRefresh!: (response: Response) => void;
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('x-amz-target')).toBe(
      'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken',
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      ClientId: 'fixtureclient',
      RefreshToken: 'fixture-refresh-token',
    });
    markRefreshStarted();
    return new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    });
  });
  const refreshResult = currentAdminAccessToken().then(
    (token) => ({ token }),
    (error: unknown) => ({ error }),
  );
  await refreshStarted;
  await signOutAdmin();
  expect(window.sessionStorage.length).toBe(0);

  releaseRefresh(
    new Response(
      JSON.stringify({
        AuthenticationResult: {
          AccessToken: storedAccessToken(),
          RefreshToken: 'refreshed-fixture-token',
          TokenType: 'Bearer',
          ExpiresIn: 900,
        },
      }),
    ),
  );
  const result = await refreshResult;
  expect(window.sessionStorage.length).toBe(0);
  expect(result).toHaveProperty('error');
  await expect(currentAdminAccessToken()).rejects.toThrow('Administrator sign-in required');
  expect(window.sessionStorage.length).toBe(0);
  expect(window.localStorage.length).toBe(0);
});

it('signs in with real Amplify while an old refresh is unresolved and rejects its late writes', async () => {
  restoreSession(storedAccessToken(1));
  let releaseRefresh!: (response: Response) => void;
  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  const freshToken = storedAccessToken(undefined, 'fresh-user');
  let freshRequests = 0;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const target = new Headers(init.headers).get('x-amz-target');
    if (target === 'AWSCognitoIdentityProviderService.GetTokensFromRefreshToken') {
      markRefreshStarted();
      return new Promise<Response>((resolve) => {
        releaseRefresh = resolve;
      });
    }
    expect(target).toBe('AWSCognitoIdentityProviderService.InitiateAuth');
    expect(JSON.parse(init.body as string)).toMatchObject({
      AuthFlow: 'USER_SRP_AUTH',
      ClientId: 'fixtureclient',
      AuthParameters: { USERNAME: 'fresh-user' },
    });
    freshRequests++;
    return new Response(
      JSON.stringify({
        AuthenticationResult: {
          AccessToken: freshToken,
          RefreshToken: 'fresh-refresh-token',
          TokenType: 'Bearer',
          ExpiresIn: 900,
        },
      }),
    );
  });
  const oldResult = currentAdminAccessToken().then(
    (token) => ({ token }),
    (error: unknown) => ({ error }),
  );
  await refreshStarted;
  await signOutAdmin();
  expect(window.sessionStorage.length).toBe(0);
  const freshSignIn = signInAdmin('fresh-user', 'fresh-password');
  try {
    await vi.waitFor(() => expect(freshRequests).toBe(1));
    expect(await freshSignIn).toBe('signed-in');
    expect(await currentAdminAccessToken()).toBe(freshToken);
    const freshStorage = { ...window.sessionStorage };
    releaseRefresh(
      new Response(
        JSON.stringify({
          AuthenticationResult: {
            AccessToken: storedAccessToken(),
            RefreshToken: 'stale-refresh-token',
            TokenType: 'Bearer',
            ExpiresIn: 900,
          },
        }),
      ),
    );
    expect(await oldResult).toHaveProperty('error');
    expect({ ...window.sessionStorage }).toEqual(freshStorage);
    expect(await currentAdminAccessToken()).toBe(freshToken);
    expect(window.localStorage.length).toBe(0);
  } finally {
    // A failing regression must not leave old SDK work hanging across tests.
    releaseRefresh(new Response('{}', { status: 400 }));
    await oldResult;
    await freshSignIn.catch(() => undefined);
  }
});
