import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from './runtime-config';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('Cognito runtime configuration', () => {
  it('publishes the pool configuration together with the API origin', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            apiBaseUrl: 'https://api.example.test/',
            cognito: { region: 'us-east-1', userPoolId: 'us-east-1_fixture', clientId: 'client' },
          }),
        ),
    );
    expect(await loadRuntimeConfig()).toEqual({
      apiBaseUrl: 'https://api.example.test',
      cognito: { region: 'us-east-1', userPoolId: 'us-east-1_fixture', clientId: 'client' },
    });
  });
  it('uses Vite Cognito settings when the development config contains only an API origin', async () => {
    vi.stubEnv('VITE_COGNITO_REGION', 'us-east-1');
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'us-east-1_dev');
    vi.stubEnv('VITE_COGNITO_APP_CLIENT_ID', 'devclient');
    vi.stubGlobal('fetch', async () => new Response('{"apiBaseUrl":"http://localhost:3000"}'));
    expect((await loadRuntimeConfig()).cognito).toEqual({
      region: 'us-east-1',
      userPoolId: 'us-east-1_dev',
      clientId: 'devclient',
    });
  });
});
