import type { ResourcesConfig } from 'aws-amplify';
import type { RuntimeConfig } from '@/runtime-config';
import type { AdminAuthInput, AdminAuthResponse } from './adminAuthProtocol';

interface SessionGeneration {
  active: boolean;
  operations: Promise<void>;
  request: (input: AdminAuthInput) => Promise<string | undefined>;
  retire: () => Promise<void>;
}
let resources: ResourcesConfig | undefined;
let generation: SessionGeneration | undefined;

// Revocation is best-effort: a retired realm gets at most two seconds for SDK
// sign-out and outstanding RPCs before its worker and pending calls are closed.
const RETIREMENT_TIMEOUT_MS = 2_000;

function createGeneration(config: ResourcesConfig): SessionGeneration {
  let worker: Worker | undefined = new Worker(new URL('./adminAuth.worker.ts', import.meta.url), {
    type: 'module',
  });
  const pending = new Map<
    number,
    { resolve: (value?: string) => void; reject: (error: Error) => void }
  >();
  let requestId = 0;
  let signedOut = false;
  let retirement: Promise<void> | undefined;
  let retirementTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveRetirement: (() => void) | undefined;
  function settleRetirement() {
    resolveRetirement?.();
    resolveRetirement = undefined;
  }
  function terminate() {
    next.active = false;
    if (retirementTimer !== undefined) {
      clearTimeout(retirementTimer);
      retirementTimer = undefined;
    }
    const retiredWorker = worker;
    worker = undefined;
    retiredWorker?.removeEventListener('message', onMessage);
    retiredWorker?.removeEventListener('error', terminate);
    for (const request of pending.values()) request.reject(new AdminSessionDenied());
    pending.clear();
    next.operations = Promise.resolve();
    retiredWorker?.terminate();
    settleRetirement();
  }
  function finishSignOut() {
    signedOut = true;
    if (!pending.size) terminate();
    else settleRetirement();
  }
  const next: SessionGeneration = {
    active: true,
    operations: Promise.resolve(),
    request(input) {
      if (!worker) return Promise.reject(new AdminSessionDenied());
      return new Promise((resolve, reject) => {
        const id = ++requestId;
        pending.set(id, { resolve, reject });
        try {
          worker!.postMessage({ ...input, id });
        } catch {
          pending.delete(id);
          reject(new AdminSessionDenied());
        }
      });
    },
    retire() {
      next.active = false;
      retirement ??= new Promise<void>((resolve) => {
        resolveRetirement = resolve;
        retirementTimer = setTimeout(terminate, RETIREMENT_TIMEOUT_MS);
        void next.request({ operation: 'sign-out' }).then(finishSignOut, finishSignOut);
      });
      return retirement;
    },
  };
  function onMessage(event: MessageEvent<AdminAuthResponse>) {
    const message = event.data;
    if ('storage' in message) {
      if (!next.active) return;
      if (message.storage === 'set') window.sessionStorage.setItem(message.key, message.value);
      else if (message.storage === 'remove') window.sessionStorage.removeItem(message.key);
      else window.sessionStorage.clear();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (!next.active) request.reject(new AdminSessionDenied());
    else if (message.error)
      request.reject(Object.assign(new Error(message.error.message), { name: message.error.name }));
    else request.resolve(message.value);
    if (signedOut && !pending.size) terminate();
  }
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', terminate);
  next.operations = next
    .request({ operation: 'configure', config, items: Object.entries(window.sessionStorage) })
    .then(() => undefined);
  return next;
}
export class AdminSessionDenied extends Error {
  constructor() {
    super('Administrator sign-in required');
    this.name = 'AdminSessionDenied';
  }
}
function runAuthOperation(session: SessionGeneration, input: AdminAuthInput) {
  const result = session.operations.then(async () => {
    if (!session.active) throw new AdminSessionDenied();
    const value = await session.request(input);
    if (!session.active) throw new AdminSessionDenied();
    return value;
  });
  session.operations = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
export function configureAdminAuth(config: RuntimeConfig['cognito']) {
  void generation?.retire();
  generation = undefined;
  resources =
    config?.clientId && config.region && config.userPoolId.startsWith(`${config.region}_`)
      ? {
          Auth: {
            Cognito: {
              userPoolId: config.userPoolId,
              userPoolClientId: config.clientId,
            },
          },
        }
      : undefined;
}
export async function signInAdmin(username: string, password: string) {
  if (!resources) throw new Error('Administrator authentication is not configured');
  generation ??= createGeneration(resources);
  return (await runAuthOperation(generation, { operation: 'sign-in', username, password })) as
    'signed-in' | 'new-password';
}
export async function finishNewPassword(password: string) {
  if (!generation) throw new AdminSessionDenied();
  return (await runAuthOperation(generation, { operation: 'new-password', password })) as
    'signed-in' | 'new-password';
}
export async function currentAdminAccessToken(): Promise<string> {
  if (!resources) throw new AdminSessionDenied();
  generation ??= createGeneration(resources);
  try {
    // The SDK worker renews expired tokens using this generation's refresh token.
    const token = await runAuthOperation(generation, { operation: 'access-token' });
    if (!token) throw new AdminSessionDenied();
    return token;
  } catch {
    throw new AdminSessionDenied();
  }
}
export async function signOutAdmin() {
  const retired = generation;
  generation = undefined;
  if (retired) retired.active = false;
  // Close the token bridge synchronously before SDK work can yield again.
  window.sessionStorage.clear();
  if (retired) await retired.retire();
}
