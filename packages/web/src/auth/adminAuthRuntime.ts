import { createAmplifyContext } from 'aws-amplify';
import type { AmplifyContext } from 'aws-amplify';
import { createUserPoolsTokenProvider } from 'aws-amplify/adapter-core';
import { signIn, confirmSignIn, fetchAuthSession, signOut } from 'aws-amplify/auth';
import type { AdminAuthRequest, AdminAuthResponse } from './adminAuthProtocol';

function nextStep(result: Awaited<ReturnType<typeof signIn>>) {
  if (result.isSignedIn) return 'signed-in';
  if (
    result.nextStep.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' &&
    !result.nextStep.missingAttributes?.length
  )
    return 'new-password';
  throw new Error('This sign-in challenge is unsupported. Contact the pool administrator.');
}

// Each worker loads its own SDK module graph. Amplify's module-global
// signInStore and synchronous storage fallback stay in this realm; they cannot
// read/reset another generation's challenge state.
export function createAdminAuthHandler(post: (message: AdminAuthResponse) => void) {
  let context: AmplifyContext;
  return async (request: AdminAuthRequest) => {
    try {
      let value: string | undefined;
      switch (request.operation) {
        case 'configure': {
          const items = new Map(request.items);
          const storage = {
            async getItem(key: string) {
              return items.get(key) ?? null;
            },
            async setItem(key: string, value: string) {
              items.set(key, value);
              post({ storage: 'set', key, value });
            },
            async removeItem(key: string) {
              items.delete(key);
              post({ storage: 'remove', key });
            },
            async clear() {
              items.clear();
              post({ storage: 'clear' });
            },
          };
          context = createAmplifyContext(request.config, {
            Auth: { tokenProvider: createUserPoolsTokenProvider(request.config.Auth!, storage) },
          });
          break;
        }
        case 'sign-in':
          value = nextStep(
            await signIn(context, {
              username: request.username,
              password: request.password,
              options: { authFlowType: 'USER_SRP_AUTH' },
            }),
          );
          break;
        case 'new-password':
          value = nextStep(await confirmSignIn(context, { challengeResponse: request.password }));
          break;
        case 'access-token': {
          const token = (await fetchAuthSession(context)).tokens?.accessToken;
          const groups = token?.payload['cognito:groups'];
          if (token && Array.isArray(groups) && groups.includes('admins')) value = token.toString();
          break;
        }
        case 'sign-out':
          await signOut(context);
          break;
      }
      post({ id: request.id, value });
    } catch (error) {
      post({
        id: request.id,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : 'Administrator authentication failed',
        },
      });
    }
  };
}
