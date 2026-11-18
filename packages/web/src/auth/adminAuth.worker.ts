import { createAdminAuthHandler } from './adminAuthRuntime.ts';
import type { AdminAuthRequest, AdminAuthResponse } from './adminAuthProtocol';

// Use the structural subset shared by WorkerGlobalScope and the local SDK
// regression's worker-thread harness without adding worker globals to the SPA.
const worker = globalThis as unknown as {
  postMessage(message: AdminAuthResponse): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<AdminAuthRequest>) => void,
  ): void;
};
const handle = createAdminAuthHandler((message) => worker.postMessage(message));
worker.addEventListener('message', (event) => {
  void handle(event.data);
});
