// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAdminConsole } from './useAdminConsole';
import { AdminSessionDenied } from '@/auth/adminSession';

const auth = vi.hoisted(() => ({
  currentAdminAccessToken: vi.fn(),
  signInAdmin: vi.fn(),
  finishNewPassword: vi.fn(),
  signOutAdmin: vi.fn(),
}));
vi.mock('@/auth/adminSession', async (original) => ({
  ...(await original()),
  ...auth,
}));
let root: Root;
let admin: ReturnType<typeof useAdminConsole>;
let denied = false;
let tokenNumber = 0;
const requests: { path: string; token: string | null }[] = [];
function Harness() {
  admin = useAdminConsole('https://api.example.test');
  return null;
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  denied = false;
  tokenNumber = 0;
  requests.length = 0;
  auth.currentAdminAccessToken.mockImplementation(async () => `access-${++tokenNumber}`);
  auth.signOutAdmin.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({ path, token: new Headers(init.headers).get('Authorization') });
    if (denied)
      return new Response(
        JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Group membership required' } }),
        { status: 403 },
      );
    const body = path.endsWith('/question-sets')
      ? { questionSets: [{ questionSetId: 'set1', name: 'Set', createdAt: 1 }] }
      : path.endsWith('/questions')
        ? { questions: [{ questionId: 'q1' }] }
        : path.endsWith('/players')
          ? { players: [{ playerId: 'p1' }] }
          : {
              games: [
                { gameId: 'g1', questionIds: ['q1'], active: 'Y', status: 'LOBBY', createdAt: 1 },
              ],
            };
    return new Response(JSON.stringify(body));
  });
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(createElement(Harness));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  window.sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('admin console session lifetime', () => {
  it('clears a denied restored session so a later sign-in can proceed', async () => {
    await act(async () => root.unmount());
    const sessionKey = 'CognitoIdentityServiceProvider.fixtureclient.LastAuthUser';
    window.sessionStorage.setItem(sessionKey, 'non-admin-user');
    auth.currentAdminAccessToken.mockImplementation(async () => {
      if (window.sessionStorage.getItem(sessionKey) !== 'admin-user') {
        throw new AdminSessionDenied();
      }
      return `access-${++tokenNumber}`;
    });
    auth.signOutAdmin.mockImplementation(async () => {
      window.sessionStorage.removeItem(sessionKey);
    });
    auth.signInAdmin.mockImplementation(async () => {
      if (window.sessionStorage.getItem(sessionKey)) {
        throw new Error('There is already a signed in user.');
      }
      window.sessionStorage.setItem(sessionKey, 'admin-user');
      return 'signed-in';
    });
    root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(createElement(Harness));
    });
    expect(admin.restoring).toBe(false);
    expect(admin.authenticated).toBe(false);
    expect(window.sessionStorage.getItem(sessionKey)).toBeNull();

    await act(async () => {
      await admin.signIn('admin@example.com', 'password');
    });
    expect(admin.authenticated).toBe(true);
    expect(admin.error).toBeUndefined();
    expect(admin.games).toHaveLength(1);
  });
  it('restores the session and fetches a current token for each admin request and poll', async () => {
    expect(admin.authenticated).toBe(true);
    expect(admin.games).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(requests.length).toBeGreaterThan(4);
    expect(new Set(requests.map((request) => request.token)).size).toBe(requests.length);
  });
  it('clears all admin data and stops polling when the API denies membership', async () => {
    denied = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(admin.authenticated).toBe(false);
    expect(admin.games).toEqual([]);
    expect(admin.questionSets).toEqual([]);
    expect(admin.questions).toEqual([]);
    expect(admin.players).toEqual([]);
    const count = requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(requests).toHaveLength(count);
  });
  it('clears console data and stops polling immediately on sign-out', async () => {
    await act(async () => {
      await admin.signOut();
    });
    expect(admin.authenticated).toBe(false);
    expect(admin.games).toEqual([]);
    expect(admin.players).toEqual([]);
    const count = requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(requests).toHaveLength(count);
  });
  it('does not restore admin data from an in-flight response after sign-out', async () => {
    const releases: ((response: Response) => void)[] = [];
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    let pending: Promise<void>;
    await act(async () => {
      pending = admin.refresh();
    });
    await act(async () => {
      await admin.signOut();
    });
    // The two parallel refresh reads are both pending. Aborting/signing out
    // must not make a late server response render data again.
    await act(async () => {
      for (const release of releases) release(new Response('{"games":[],"questionSets":[]}'));
      await pending!;
    });
    expect(admin.games).toEqual([]);
    expect(admin.authenticated).toBe(false);
  });
  it('does not sign out a fresh session when an older sign-in is denied after sign-out', async () => {
    await act(async () => {
      await admin.signOut();
    });
    let rejectOldSignIn!: (error: Error) => void;
    auth.signInAdmin.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOldSignIn = reject;
        }),
    );
    let oldSignIn!: Promise<void>;
    await act(async () => {
      oldSignIn = admin.signIn('old-user', 'password');
    });
    await act(async () => {
      await admin.signOut();
    });
    auth.signInAdmin.mockResolvedValueOnce('signed-in');
    await act(async () => {
      await admin.signIn('new-user', 'password');
    });
    expect(admin.authenticated).toBe(true);

    await act(async () => {
      rejectOldSignIn(new AdminSessionDenied());
      await oldSignIn;
    });
    expect(admin.authenticated).toBe(true);
    expect(admin.games).toHaveLength(1);
    expect(admin.error).toBeUndefined();
  });
});
