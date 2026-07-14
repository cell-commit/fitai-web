import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * Subtle toast shown when a new service worker (a fresh deploy) is waiting.
 * registerType is 'prompt' so the update never hot-swaps mid-session — the user
 * taps Reload when ready. Renders nothing until an update is available.
 */
export function UpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className="update-toast" role="status">
      <span className="update-toast__text">App updated — reload to get it</span>
      <div className="update-toast__actions">
        <button
          className="btn btn--inline"
          onClick={() => void updateServiceWorker(true)}
        >
          Reload
        </button>
        <button
          className="btn btn--ghost btn--inline"
          onClick={() => setNeedRefresh(false)}
          aria-label="Dismiss update notice"
        >
          Later
        </button>
      </div>
    </div>
  );
}
