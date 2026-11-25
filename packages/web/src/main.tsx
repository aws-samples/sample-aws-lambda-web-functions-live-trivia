import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from '@/App';
import { Provider } from '@/components/ui/provider';
import { loadRuntimeConfig } from '@/runtime-config';
import { configureAdminAuth } from '@/auth/adminSession';
import '@/styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root element');
}

const config = await loadRuntimeConfig();
configureAdminAuth(config.cognito);

createRoot(rootElement).render(
  <StrictMode>
    <Provider defaultTheme="dark">
      <BrowserRouter>
        <App config={config} />
      </BrowserRouter>
    </Provider>
  </StrictMode>,
);
