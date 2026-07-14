import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import './styles/base.css';
import App from './App.tsx';

// Fire-and-forget: ask the browser to persist storage so iOS Safari is less
// likely to evict localStorage / IndexedDB between visits (design §Risks 1).
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {
    /* best effort — ignore rejection */
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
