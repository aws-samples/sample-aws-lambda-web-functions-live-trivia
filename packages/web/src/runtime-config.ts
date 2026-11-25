export interface RuntimeConfig {
  apiBaseUrl: string;
  cognito?: { region: string; userPoolId: string; clientId: string };
}

const fallbackApiBaseUrl =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const developmentCognito = {
    region: import.meta.env.VITE_COGNITO_REGION ?? '',
    userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? '',
    clientId: import.meta.env.VITE_COGNITO_APP_CLIENT_ID ?? '',
  };
  try {
    const response = await fetch('/config.json', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`config returned ${response.status}`);
    }

    const config = (await response.json()) as Partial<RuntimeConfig>;
    if (typeof config.apiBaseUrl !== 'string' || config.apiBaseUrl.length === 0) {
      throw new Error('config is missing apiBaseUrl');
    }

    const cognito = config.cognito;
    return {
      apiBaseUrl: config.apiBaseUrl.replace(/\/$/, ''),
      ...(cognito &&
      typeof cognito.region === 'string' &&
      typeof cognito.userPoolId === 'string' &&
      typeof cognito.clientId === 'string'
        ? { cognito }
        : { cognito: developmentCognito }),
    };
  } catch {
    return {
      apiBaseUrl: fallbackApiBaseUrl.replace(/\/$/, ''),
      cognito: developmentCognito,
    };
  }
}
