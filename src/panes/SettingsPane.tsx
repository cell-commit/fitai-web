import { useEffect, useState } from 'react';
import type { Settings } from '../types';
import { getSettings, saveSettings } from '../services/storage';
import {
  testConnection,
  getSyncStatus,
  type ConnectionFile,
  type SyncStatus,
} from '../services/driveSync';

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function fmtSyncTime(ms: number | null): string {
  if (!ms) return 'never';
  return new Date(ms).toLocaleString();
}

const EMPTY: Settings = {
  calorieTarget: 2000,
  proteinTarget: 150,
  name: '',
  restDefaultSec: 90,
  restSoundEnabled: true,
  watchReminderEnabled: true,
};

export function SettingsPane() {
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testFiles, setTestFiles] = useState<ConnectionFile[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);

  useEffect(() => {
    getSettings().then(setSettings);
    getSyncStatus().then(setStatus);
  }, []);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((s) => ({ ...s, [key]: value }));
    setSaved(false);
  }

  async function handleSave() {
    await saveSettings(settings);
    setSaved(true);
    setStatus(await getSyncStatus());
  }

  async function handleTest() {
    setTesting(true);
    setTestError(null);
    setTestFiles(null);
    // Persist first so the sync client reads the freshest URL/token.
    await saveSettings(settings);
    setSaved(true);
    try {
      const files = await testConnection();
      setTestFiles(files);
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
      setStatus(await getSyncStatus());
    }
  }

  return (
    <div className="pane">
      <div className="section-label">Coach</div>

      <div className="field">
        <label className="field__label" htmlFor="api-key">
          Anthropic API key
        </label>
        <div className="input-group">
          <input
            id="api-key"
            className="input"
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="sk-ant-…"
            value={settings.anthropicApiKey ?? ''}
            onChange={(e) => update('anthropicApiKey', e.target.value)}
          />
          <button
            type="button"
            className="btn btn--ghost btn--inline"
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="field__hint">
          Stored only on this device (localStorage). Never uploaded or bundled.
        </p>
      </div>

      <div className="section-label">Drive Sync</div>

      <div className="field">
        <label className="field__label" htmlFor="as-url">
          Apps Script URL
        </label>
        <input
          id="as-url"
          className="input"
          type="url"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://script.google.com/macros/s/…/exec"
          value={settings.appsScriptUrl ?? ''}
          onChange={(e) => update('appsScriptUrl', e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="as-token">
          Sync token
        </label>
        <input
          id="as-token"
          className="input"
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="shared secret from Code.gs"
          value={settings.appsScriptToken ?? ''}
          onChange={(e) => update('appsScriptToken', e.target.value)}
        />
        <p className="field__hint">
          Deploy guide: docs/apps-script/README.md.
        </p>
      </div>

      <div className="section-label">Workout</div>

      <div className="field">
        <label className="field__label" htmlFor="rest-default">
          Rest timer default (seconds)
        </label>
        <input
          id="rest-default"
          className="input"
          type="number"
          inputMode="numeric"
          min={15}
          step={15}
          value={settings.restDefaultSec ?? 90}
          onChange={(e) =>
            update('restDefaultSec', Math.max(15, Number(e.target.value) || 0))
          }
        />
        <p className="field__hint">
          Starts automatically when you tick a set off. You can add or take 15s
          during the rest, or skip it.
        </p>
      </div>

      <label className="field-check">
        <input
          type="checkbox"
          checked={settings.restSoundEnabled !== false}
          onChange={(e) => update('restSoundEnabled', e.target.checked)}
        />
        <span>Sound when the rest ends</span>
      </label>
      <p className="field__hint">
        Best-effort only, and the countdown on screen is the real alert: iPhone
        mutes it when the ringer switch is off, and nothing can play while the
        app is in the background or the screen is locked. There is no vibration
        option because iOS Safari has no vibration API at all.
      </p>

      <label className="field-check">
        <input
          type="checkbox"
          checked={settings.watchReminderEnabled !== false}
          onChange={(e) => update('watchReminderEnabled', e.target.checked)}
        />
        <span>Remind me to start my Apple Watch workout</span>
      </label>
      <p className="field__hint">
        A dismissible banner at the top of a fresh session.
      </p>

      <div className="section-label">Targets</div>

      <div className="field">
        <label className="field__label" htmlFor="name">
          Name
        </label>
        <input
          id="name"
          className="input"
          type="text"
          placeholder="Jason"
          value={settings.name}
          onChange={(e) => update('name', e.target.value)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="cal">
          Daily calorie target
        </label>
        <input
          id="cal"
          className="input"
          type="number"
          inputMode="numeric"
          value={settings.calorieTarget}
          onChange={(e) => update('calorieTarget', Number(e.target.value) || 0)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="prot">
          Daily protein target (g)
        </label>
        <input
          id="prot"
          className="input"
          type="number"
          inputMode="numeric"
          value={settings.proteinTarget}
          onChange={(e) => update('proteinTarget', Number(e.target.value) || 0)}
        />
      </div>

      <button className="btn" onClick={handleSave}>
        {saved ? 'Saved ✓' : 'Save Settings'}
      </button>

      <div style={{ height: 'var(--sp-md)' }} />

      <button
        className="btn btn--secondary"
        onClick={handleTest}
        disabled={testing}
      >
        {testing ? 'Testing…' : 'Test connection'}
      </button>

      {testFiles && (
        <div style={{ marginTop: 'var(--sp-md)' }}>
          {testFiles.map((f) => (
            <div className="file-result" key={f.name}>
              <span>{f.name}</span>
              <span className="file-result__time">
                {f.error ? `error: ${f.error}` : fmtTime(f.modifiedTime)}
              </span>
            </div>
          ))}
        </div>
      )}

      {testError && (
        <p className="status-line status-line--error">{testError}</p>
      )}

      {status && (
        <div className="status-line">
          <div>
            Sync:{' '}
            {status.configured ? 'configured' : 'not configured'} · queue{' '}
            {status.queueLength}
          </div>
          <div>Last sync: {fmtSyncTime(status.lastSyncAt)}</div>
          {status.lastError && (
            <div className="status-line--error">
              Last error: {status.lastError}
            </div>
          )}
        </div>
      )}

      <div className="section-label">About</div>
      <p className="field__hint">FitAI v{__APP_VERSION__}</p>
    </div>
  );
}
