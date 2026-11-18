import { Worker as NodeWorker } from 'node:worker_threads';
import type { AdminAuthRequest, AdminAuthResponse } from '../adminAuthProtocol';

const workers = new Set<NodeWorker>();

// Run the production worker entry and installed SDK in separate real JS realms.
// Only Cognito HTTP crosses back to the test's fetch fixture; SDK state and all
// token-provider operations remain real inside each worker.
const bootstrap = `
const { parentPort, workerData } = require('node:worker_threads');
let handle;
const queued = [];
const requests = new Map();
let requestId = 0;
globalThis.postMessage = (message) => parentPort.postMessage(message);
globalThis.addEventListener = (_type, listener) => {
  handle = listener;
  for (const data of queued) listener({ data });
};
globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
  const id = ++requestId;
  requests.set(id, { resolve, reject });
  parentPort.postMessage({
    fetchRequest: { id, url: String(url), init: { ...init, headers: [...new Headers(init.headers)] } }
  });
});
parentPort.on('message', (message) => {
  if ('fetchResponse' in message) {
    const response = message.fetchResponse;
    const request = requests.get(response.id);
    requests.delete(response.id);
    if (response.error) request.reject(new Error(response.error));
    else request.resolve(new Response(response.body, response.init));
  } else if (handle) handle({ data: message });
  else queued.push(message);
});
import(workerData.entry).catch((error) => { throw error; });
`;

export class RealSdkWorker {
  static instances: RealSdkWorker[] = [];
  terminated = false;
  readonly exited: Promise<number>;
  private worker: NodeWorker;
  private listeners = new Map<string, ((event: MessageEvent<AdminAuthResponse>) => void)[]>();

  constructor(_entry: URL) {
    // Vite rewrites the browser worker URL to an HTTP asset URL under jsdom.
    // Resolve the same entry directly for Node's local module loader.
    const entryPath = '../adminAuth.worker.ts';
    const entry = new URL(entryPath, import.meta.url);
    this.worker = new NodeWorker(bootstrap, { eval: true, workerData: { entry: entry.href } });
    RealSdkWorker.instances.push(this);
    workers.add(this.worker);
    this.exited = new Promise((resolve) => {
      this.worker.once('exit', (code) => {
        workers.delete(this.worker);
        resolve(code);
      });
    });
    this.worker.on(
      'message',
      async (
        message:
          AdminAuthResponse | { fetchRequest: { id: number; url: string; init: RequestInit } },
      ) => {
        if ('fetchRequest' in message) {
          const { id, url, init } = message.fetchRequest;
          try {
            const response = await fetch(url, init);
            if (this.terminated) return;
            this.worker.postMessage({
              fetchResponse: {
                id,
                body: await response.text(),
                init: { status: response.status, headers: [...response.headers] },
              },
            });
          } catch (error) {
            if (this.terminated) return;
            this.worker.postMessage({
              fetchResponse: { id, error: error instanceof Error ? error.message : String(error) },
            });
          }
        } else {
          for (const listener of this.listeners.get('message') ?? []) {
            listener({ data: message } as MessageEvent<AdminAuthResponse>);
          }
        }
      },
    );
    this.worker.on('error', (error) => {
      for (const listener of this.listeners.get('error') ?? [])
        listener({ error } as unknown as MessageEvent<AdminAuthResponse>);
    });
  }

  postMessage(message: AdminAuthRequest) {
    this.worker.postMessage(message);
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
    void this.worker.terminate();
  }
}

export async function closeSdkWorkers() {
  await Promise.all([...workers].map((worker) => worker.terminate()));
  workers.clear();
  RealSdkWorker.instances = [];
}
