import { useEffect, useState } from 'react';
import type { SessionLog } from '../types';
import { listSessionLogs, formatDisplayDate } from '../services/storage';
import { formatSetsSummary } from '../services/sessionLog';
import { ExerciseImage } from '../components/ExerciseImage';
import { PhotosSegment } from './PhotosSegment';
import { FOCUS_LABELS } from './focus';

type Segment = 'photos' | 'history';

export function ProgressPane() {
  const [segment, setSegment] = useState<Segment>('history');

  return (
    <div className="pane">
      <div className="segmented" role="tablist" aria-label="Progress view">
        <button
          className={`segmented__btn${segment === 'photos' ? ' segmented__btn--active' : ''}`}
          role="tab"
          aria-selected={segment === 'photos'}
          onClick={() => setSegment('photos')}
        >
          Photos
        </button>
        <button
          className={`segmented__btn${segment === 'history' ? ' segmented__btn--active' : ''}`}
          role="tab"
          aria-selected={segment === 'history'}
          onClick={() => setSegment('history')}
        >
          History
        </button>
      </div>

      {segment === 'photos' ? <PhotosSegment /> : <History />}
    </div>
  );
}

function History() {
  const [logs, setLogs] = useState<SessionLog[] | null>(null);

  useEffect(() => {
    void listSessionLogs().then(setLogs);
  }, []);

  if (logs === null) {
    return (
      <div className="generating">
        <div className="spinner" aria-hidden="true" />
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="placeholder">
        <div className="placeholder__title">No sessions yet</div>
        <p>Finish a session in Today and it will show up here.</p>
      </div>
    );
  }

  return (
    <div className="history-list">
      {logs.map((log) => (
        <HistoryRow key={log.id} log={log} />
      ))}
    </div>
  );
}

function HistoryRow({ log }: { log: SessionLog }) {
  const [open, setOpen] = useState(false);
  const loggedCount = log.exercises.filter(
    (ex) => formatSetsSummary(ex.sets) !== ''
  ).length;

  return (
    <div className="card history-card">
      <button
        className="history-card__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div>
          <div className="history-card__date">{formatDisplayDate(log.date)}</div>
          <div className="history-card__meta">
            {loggedCount} {loggedCount === 1 ? 'exercise' : 'exercises'}
          </div>
        </div>
        <span className={`chip chip--${log.focus}`}>{FOCUS_LABELS[log.focus]}</span>
      </button>

      {open && (
        <div className="history-card__body">
          {log.exercises.map((ex, i) => {
            const summary = formatSetsSummary(ex.sets);
            return (
              <div className="summary-row" key={`${ex.name}-${i}`}>
                <ExerciseImage slug={ex.slug} alt={ex.name} />
                <div className="exrow__body">
                  <div className="exrow__name">{ex.name}</div>
                  <div className="exrow__meta">
                    {summary || 'not logged'}{' '}
                    <span className="muted">
                      (target {ex.targetSets}×{ex.targetRepRange})
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
          {log.feedback && (
            <div className="coachnote">Note: {log.feedback}</div>
          )}
        </div>
      )}
    </div>
  );
}
