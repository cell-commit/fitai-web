import { useEffect, useRef, useState } from 'react';
import type { HealthImportSummary } from '../types';
import {
  getHealthSummaries,
  deleteHealthSummary,
} from '../services/storage';
import { importHealthFile, computeStats } from '../services/healthImport';

function fmtRange(s: HealthImportSummary): string {
  const { from, to } = s.dateRange;
  if (!from && !to) return '—';
  return from === to ? from : `${from} → ${to}`;
}

function fmtImportedAt(ms: number): string {
  const d = new Date(ms);
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function fmt1(n: number | null): string {
  return n === null ? '—' : (Math.round(n * 10) / 10).toString();
}

export function HealthImportPane() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [summaries, setSummaries] = useState<HealthImportSummary[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justImported, setJustImported] = useState<HealthImportSummary | null>(
    null
  );

  useEffect(() => {
    void getHealthSummaries().then(setSummaries);
  }, []);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so re-picking the same file fires change again.
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;

    setImporting(true);
    setError(null);
    setJustImported(null);
    try {
      const saved = await importHealthFile(file);
      setJustImported(saved);
      setSummaries(await getHealthSummaries());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  async function handleDelete(id: string) {
    await deleteHealthSummary(id);
    setSummaries(await getHealthSummaries());
    if (justImported?.id === id) setJustImported(null);
  }

  return (
    <div className="pane">
      <div className="card">
        <div className="card__title">Import Apple Health</div>
        <p className="field__hint" style={{ marginBottom: 'var(--sp-sm)' }}>
          Install <strong>Health Auto Export</strong> on your iPhone, export your
          data as <strong>JSON</strong> or <strong>CSV</strong> (sleep, steps,
          active energy, resting heart rate, workouts), and share the file here.
        </p>
        <p className="field__hint" style={{ marginBottom: 'var(--sp-md)' }}>
          Apple's built-in <code>export.xml</code> is not supported — it's
          routinely hundreds of MB and too large to process in the browser.
        </p>

        <input
          ref={inputRef}
          type="file"
          accept=".json,.csv,application/json,text/csv"
          onChange={handleFile}
          style={{ display: 'none' }}
        />
        <button
          className="btn"
          onClick={() => inputRef.current?.click()}
          disabled={importing}
        >
          {importing ? 'Importing…' : 'Choose file'}
        </button>

        <p className="field__hint" style={{ marginTop: 'var(--sp-md)' }}>
          Your coach automatically sees the latest import summary in chat — no
          extra step needed.
        </p>
      </div>

      {error && <p className="status-line status-line--error">{error}</p>}

      {importing && (
        <div className="generating">
          <div className="spinner" aria-hidden="true" />
        </div>
      )}

      {justImported && (
        <>
          <div className="section-label">Latest import</div>
          <ResultCard summary={justImported} />
        </>
      )}

      <div className="section-label">Previous imports</div>
      <PreviousList
        summaries={summaries}
        highlightId={justImported?.id}
        onDelete={handleDelete}
      />
    </div>
  );
}

function ResultCard({ summary }: { summary: HealthImportSummary }) {
  const stats = computeStats(summary);
  return (
    <div className="card health-result">
      <div className="health-stats">
        <Stat label="Days" value={String(stats.days)} />
        <Stat label="Range" value={fmtRange(summary)} />
        <Stat label="Avg sleep" value={`${fmt1(stats.avgSleep)} h`} />
        <Stat label="Workouts" value={String(stats.workoutCount)} />
      </div>
      <p className="health-summary-text">{summary.summaryText}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="health-stat">
      <div className="health-stat__value">{value}</div>
      <div className="health-stat__label">{label}</div>
    </div>
  );
}

function PreviousList({
  summaries,
  highlightId,
  onDelete,
}: {
  summaries: HealthImportSummary[] | null;
  highlightId?: string;
  onDelete: (id: string) => void;
}) {
  if (summaries === null) {
    return (
      <div className="generating">
        <div className="spinner" aria-hidden="true" />
      </div>
    );
  }
  if (summaries.length === 0) {
    return (
      <div className="placeholder">
        <div className="placeholder__title">No imports yet</div>
        <p>Imported health files will be listed here (up to 6 kept).</p>
      </div>
    );
  }
  return (
    <div className="health-list">
      {summaries.map((s) => (
        <div
          className={`card health-row${s.id === highlightId ? ' health-row--current' : ''}`}
          key={s.id}
        >
          <div className="health-row__body">
            <div className="health-row__range">{fmtRange(s)}</div>
            <div className="health-row__meta">
              {s.days.length} day{s.days.length === 1 ? '' : 's'} ·{' '}
              {s.source === 'health-auto-export-csv' ? 'CSV' : 'JSON'} ·{' '}
              {fmtImportedAt(s.importedAt)}
            </div>
          </div>
          <button
            className="btn btn--ghost btn--inline health-row__delete"
            onClick={() => onDelete(s.id)}
            aria-label="Delete import"
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
