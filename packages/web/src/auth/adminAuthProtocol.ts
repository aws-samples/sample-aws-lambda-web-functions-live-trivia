import type { ResourcesConfig } from 'aws-amplify';

export type AdminAuthInput =
  | { operation: 'configure'; config: ResourcesConfig; items: [string, string][] }
  | { operation: 'sign-in'; username: string; password: string }
  | { operation: 'new-password'; password: string }
  | { operation: 'access-token' | 'sign-out' };
export type AdminAuthRequest = AdminAuthInput & { id: number };

export type AdminAuthResponse =
  | { storage: 'set'; key: string; value: string }
  | { storage: 'remove'; key: string }
  | { storage: 'clear' }
  | { id: number; value?: string; error?: { name: string; message: string } };
