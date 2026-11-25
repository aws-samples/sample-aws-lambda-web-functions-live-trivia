// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AdminSession from './adminSession';
import { createAdminAuthHandler } from './adminAuthRuntime';
import type { AdminAuthRequest, AdminAuthResponse } from './adminAuthProtocol';
const sdk = vi.hoisted(() => ({
  createContext: vi.fn(),
  createTokenProvider: vi.fn(),
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
  calls: [] as string[],
}));
vi.mock('aws-amplify', () => ({
  createAmplifyContext: sdk.createContext,
}));
vi.mock('aws-amplify/adapter-core', () => ({
  createUserPoolsTokenProvider: sdk.createTokenProvider,
}));
vi.mock('aws-amplify/auth', () => ({
  signIn: sdk.signIn,
  confirmSignIn: sdk.confirmSignIn,
  fetchAuthSession: sdk.fetchAuthSession,
  signOut: sdk.signOut,
}));
class AdapterWorker {
  static latest: AdapterWorker;
  private terminated = false;
  private listeners = new Map<string, ((event: MessageEvent<AdminAuthResponse>) => void)[]>();
  private handle = createAdminAuthHandler((data) => {
    queueMicrotask(() => {
      for (const listener of this.listeners.get('message') ?? [])
        listener({ data } as MessageEvent<AdminAuthResponse>);
    });
  });
  constructor() {
    AdapterWorker.latest = this;
  }
  postMessage(request: AdminAuthRequest) {
    if (this.terminated) return;
    queueMicrotask(() => void this.handle(request));
  }
  addEventListener(type: string, listener: (event: MessageEvent<AdminAuthResponse>) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: MessageEvent<AdminAuthResponse>) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }
  terminate() {
    this.terminated = true;
  }
  fail() {
    for (const listener of this.listeners.get('error') ?? [])
      listener({} as MessageEvent<AdminAuthResponse>);
  }
}
// Control the worker boundary without allowing a stalled SDK promise to drive
// the test clock or decide when retirement is complete.
class ControllableWorker {
  static instances: ControllableWorker[] = [];
  requests: AdminAuthRequest[] = [];
  terminated = false;
  stallAccessToken = false;
  listeners = new Map<string, ((event: MessageEvent<AdminAuthResponse>) => void)[]>();
  private username = '';
  constructor() {
    ControllableWorker.instances.push(this);
  }
  postMessage(request: AdminAuthRequest) {
    this.requests.push(request);
    queueMicrotask(() => {
      if (request.operation === 'configure') this.emit({ id: request.id });
      else if (request.operation === 'sign-in') {
        this.username = request.username;
        this.emit({ storage: 'set', key: 'session', value: request.username });
        this.emit({ id: request.id, value: 'signed-in' });
      } else if (request.operation === 'access-token' && !this.stallAccessToken)
        this.emit({ id: request.id, value: `token-${this.username}` });
    });
  }
  addEventListener(type: string, listener: (event: MessageEvent<AdminAuthResponse>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: MessageEvent<AdminAuthResponse>) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }
  emit(data: AdminAuthResponse) {
    for (const listener of this.listeners.get('message') ?? [])
      listener({ data } as MessageEvent<AdminAuthResponse>);
  }
  terminate() {
    this.terminated = true;
  }
  releaseRequests() {
    for (const request of this.requests) this.emit({ id: request.id });
  }
}
let configureAdminAuth: typeof AdminSession.configureAdminAuth;
let currentAdminAccessToken: typeof AdminSession.currentAdminAccessToken;
let signInAdmin: typeof AdminSession.signInAdmin;
let finishNewPassword: typeof AdminSession.finishNewPassword;
let signOutAdmin: typeof AdminSession.signOutAdmin;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('Worker', AdapterWorker);
  ({ configureAdminAuth, currentAdminAccessToken, signInAdmin, finishNewPassword, signOutAdmin } =
    await import('./adminSession'));
  vi.resetAllMocks();
  window.sessionStorage.clear();
  sdk.calls.length = 0;
  sdk.createTokenProvider.mockImplementation((_config: unknown, storage: unknown) => {
    sdk.calls.push('storage');
    return { storage };
  });
  sdk.createContext.mockImplementation((_config: unknown, options: unknown) => {
    sdk.calls.push('configure');
    return { libraryOptions: options };
  });
  configureAdminAuth({ region: 'us-east-1', userPoolId: 'us-east-1_fixture', clientId: 'client' });
  sdk.fetchAuthSession.mockResolvedValue({});
  await currentAdminAccessToken().catch(() => undefined);
  sdk.fetchAuthSession.mockReset();
  sdk.calls.length = 0;
});
afterEach(() => {
  window.sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('administrator browser session', () => {
  it('bridges worker token storage to session storage when constructing the isolated Auth context', async () => {
    configureAdminAuth({
      region: 'us-east-1',
      userPoolId: 'us-east-1_fixture',
      clientId: 'client',
    });
    await currentAdminAccessToken().catch(() => undefined);
    expect(sdk.calls).toEqual(['storage', 'configure']);
    const storage = sdk.createTokenProvider.mock.calls.at(-1)![1] as {
      setItem(key: string, value: string): Promise<void>;
      getItem(key: string): Promise<string | null>;
    };
    await storage.setItem('session', 'fixture');
    expect(await storage.getItem('session')).toBe('fixture');
    expect(window.sessionStorage.getItem('session')).toBe('fixture');
  });
  it('uses SRP and supports the first-login new-password challenge', async () => {
    configureAdminAuth({
      region: 'us-east-1',
      userPoolId: 'us-east-1_fixture',
      clientId: 'client',
    });
    sdk.signIn.mockResolvedValue({
      nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED', missingAttributes: [] },
    });
    expect(await signInAdmin('admin@example.com', 'temporary')).toBe('new-password');
    expect(sdk.signIn).toHaveBeenCalledWith(sdk.createContext.mock.results.at(-1)!.value, {
      username: 'admin@example.com',
      password: 'temporary',
      options: { authFlowType: 'USER_SRP_AUTH' },
    });
    sdk.confirmSignIn.mockResolvedValue({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });
    expect(await finishNewPassword('new-password')).toBe('signed-in');
    expect(sdk.confirmSignIn).toHaveBeenCalledWith(sdk.createContext.mock.results.at(-1)!.value, {
      challengeResponse: 'new-password',
    });
  });
  it('retrieves the refreshed session on every access token request', async () => {
    sdk.fetchAuthSession
      .mockResolvedValueOnce({
        tokens: {
          accessToken: { payload: { 'cognito:groups': ['admins'] }, toString: () => 'first' },
        },
      })
      .mockResolvedValueOnce({
        tokens: {
          accessToken: { payload: { 'cognito:groups': ['admins'] }, toString: () => 'refreshed' },
        },
      });
    expect(await currentAdminAccessToken()).toBe('first');
    expect(await currentAdminAccessToken()).toBe('refreshed');
  });
  it.each([{ groups: undefined }, { groups: [] }, { groups: ['superadmins'] }])(
    'denies a session without admins membership $groups',
    async ({ groups }) => {
      sdk.fetchAuthSession.mockResolvedValue({
        tokens: {
          accessToken: { payload: { 'cognito:groups': groups }, toString: () => 'non-admin' },
        },
      });
      await expect(currentAdminAccessToken()).rejects.toThrow('Administrator sign-in required');
    },
  );
  it('denies a missing or expired session', async () => {
    sdk.fetchAuthSession.mockResolvedValue({});
    await expect(currentAdminAccessToken()).rejects.toThrow('Administrator sign-in required');
  });
  it('signs out the Cognito session', async () => {
    await signOutAdmin();
    expect(sdk.signOut).toHaveBeenCalledOnce();
  });
  it('bounds four stalled retirements and rejects their pending calls while a fresh generation works', async () => {
    vi.useFakeTimers();
    ControllableWorker.instances = [];
    vi.stubGlobal('Worker', ControllableWorker);
    configureAdminAuth({
      region: 'us-east-1',
      userPoolId: 'us-east-1_fixture',
      clientId: 'client',
    });
    const retiredWorkers: ControllableWorker[] = [];
    const pendingResults: Promise<unknown>[] = [];
    const retirementResults: Promise<void>[] = [];
    const completedRetirements: number[] = [];
    const lateListeners: ((event: MessageEvent<AdminAuthResponse>) => void)[] = [];
    try {
      for (let cycle = 0; cycle < 4; cycle++) {
        expect(await signInAdmin(`old-user-${cycle}`, 'password')).toBe('signed-in');
        const worker = ControllableWorker.instances.at(-1)!;
        worker.stallAccessToken = true;
        for (let call = 0; call < 2; call++)
          pendingResults.push(
            currentAdminAccessToken().then(
              (token) => ({ token }),
              (error: unknown) => ({ error }),
            ),
          );
        await vi.advanceTimersByTimeAsync(0);
        expect(
          worker.requests.filter((request) => request.operation === 'access-token'),
        ).toHaveLength(1);
        lateListeners.push(...worker.listeners.get('message')!);
        retirementResults.push(
          signOutAdmin().then(() => {
            completedRetirements.push(cycle);
          }),
        );
        expect(window.sessionStorage.length).toBe(0);
        worker.emit({ storage: 'set', key: 'session', value: 'retired-secret' });
        expect(window.sessionStorage.length).toBe(0);
        retiredWorkers.push(worker);
      }

      expect(await signInAdmin('fresh-user', 'password')).toBe('signed-in');
      expect(await currentAdminAccessToken()).toBe('token-fresh-user');
      const freshStorage = { ...window.sessionStorage };
      await vi.advanceTimersByTimeAsync(1_999);
      expect(retiredWorkers.every((worker) => !worker.terminated)).toBe(true);
      expect(completedRetirements).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(retiredWorkers.every((worker) => worker.terminated)).toBe(true);
      expect(
        retiredWorkers.every((worker) => [...worker.listeners.values()].flat().length === 0),
      ).toBe(true);
      expect(completedRetirements).toEqual([0, 1, 2, 3]);
      for (const result of await Promise.all(pendingResults))
        expect(result).toMatchObject({
          error: { name: 'AdminSessionDenied', message: 'Administrator sign-in required' },
        });
      expect(vi.getTimerCount()).toBe(0);
      const newest = ControllableWorker.instances.at(-1)!;
      expect(newest.terminated).toBe(false);
      for (const listener of lateListeners) {
        for (const data of [
          { storage: 'set', key: 'session', value: 'retired-secret' },
          { storage: 'remove', key: 'session' },
          { storage: 'clear' },
          { id: 3, error: { name: 'SDKError', message: 'retired-secret' } },
        ] as AdminAuthResponse[])
          listener({ data } as MessageEvent<AdminAuthResponse>);
      }
      expect({ ...window.sessionStorage }).toEqual(freshStorage);
      expect(await currentAdminAccessToken()).toBe('token-fresh-user');
    } finally {
      retirementResults.push(signOutAdmin());
      for (let pass = 0; pass < 3; pass++) {
        for (const worker of ControllableWorker.instances) worker.releaseRequests();
        await vi.advanceTimersByTimeAsync(0);
      }
      await Promise.all([...retirementResults, ...pendingResults]);
    }
  });
  it('releases the retirement timer and worker listeners when revocation finishes promptly', async () => {
    vi.useFakeTimers();
    ControllableWorker.instances = [];
    vi.stubGlobal('Worker', ControllableWorker);
    configureAdminAuth({
      region: 'us-east-1',
      userPoolId: 'us-east-1_fixture',
      clientId: 'client',
    });
    expect(await signInAdmin('admin-user', 'password')).toBe('signed-in');
    const worker = ControllableWorker.instances.at(-1)!;
    const retirement = signOutAdmin();
    worker.releaseRequests();
    await retirement;
    expect(worker.terminated).toBe(true);
    expect([...worker.listeners.values()].flat()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('allows sign-out and fresh sign-in after the SDK worker fails', async () => {
    AdapterWorker.latest.fail();
    await expect(currentAdminAccessToken()).rejects.toThrow('Administrator sign-in required');
    await signOutAdmin();
    sdk.signIn.mockResolvedValue({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });
    expect(await signInAdmin('fresh-user', 'password')).toBe('signed-in');
  });
  it.each(['sign-in', 'new-password'] as const)(
    'denies a pending %s after sign-out while a fresh sign-in proceeds independently',
    async (operation) => {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const delayed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const storage = sdk.createTokenProvider.mock.calls.at(-1)![1] as {
        setItem(key: string, value: string): Promise<void>;
      };
      const pendingOperation = async () => {
        markStarted();
        await delayed;
        await storage.setItem('session', 'stale-session');
        return { isSignedIn: true, nextStep: { signInStep: 'DONE' } };
      };
      if (operation === 'sign-in') sdk.signIn.mockImplementationOnce(pendingOperation);
      else sdk.confirmSignIn.mockImplementationOnce(pendingOperation);
      const pendingResult = (
        operation === 'sign-in'
          ? signInAdmin('old-user', 'password')
          : finishNewPassword('password')
      ).then(
        (step) => ({ step }),
        (error: unknown) => ({ error }),
      );
      await started;
      await signOutAdmin();

      sdk.signIn.mockImplementationOnce(async () => {
        const freshStorage = sdk.createTokenProvider.mock.calls.at(-1)![1] as {
          setItem(key: string, value: string): Promise<void>;
        };
        await freshStorage.setItem('session', 'fresh-session');
        return { isSignedIn: true, nextStep: { signInStep: 'DONE' } };
      });
      const freshSignIn = signInAdmin('new-user', 'password');
      try {
        await vi.waitFor(() =>
          expect(window.sessionStorage.getItem('session')).toBe('fresh-session'),
        );
        expect(await freshSignIn).toBe('signed-in');
        release();
        expect(await pendingResult).toHaveProperty('error');
        expect(window.sessionStorage.getItem('session')).toBe('fresh-session');
      } finally {
        release();
        await pendingResult;
        await freshSignIn.catch(() => undefined);
      }
    },
  );
});
