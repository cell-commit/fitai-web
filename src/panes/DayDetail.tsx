import type { ProgramDay } from '../types';
import { ExerciseImage } from '../components/ExerciseImage';
import { ChevronRightIcon } from '../components/icons';
import { formatDisplayDate } from '../services/storage';
import { FOCUS_LABELS } from './focus';

interface DayDetailProps {
  day: ProgramDay;
  onClose: () => void;
}

/** Slide-over detail view for a single program day. */
export function DayDetail({ day, onClose }: DayDetailProps) {
  const isRest = day.focus === 'rest';

  return (
    <div className="slideover" role="dialog" aria-label={`${day.title} details`}>
      <div className="slideover__header">
        <button
          className="btn btn--ghost btn--inline"
          onClick={onClose}
          aria-label="Back to week"
        >
          <ChevronRightIcon
            style={{ width: 16, height: 16, transform: 'rotate(180deg)' }}
          />
          Week
        </button>
      </div>

      <div className="pane">
        <div className="daydetail__title-row">
          <span className={`chip chip--${day.focus}`}>
            {FOCUS_LABELS[day.focus]}
          </span>
          <span className={`chip chip--status-${day.status}`}>{day.status}</span>
        </div>
        <h2 className="daydetail__title">{day.title}</h2>
        <p className="pane__subtitle">{formatDisplayDate(day.date)}</p>

        {day.coachNotes && <div className="coachnote">{day.coachNotes}</div>}

        {isRest && day.exercises.length === 0 ? (
          <div className="daydetail__rest">
            {day.focus === 'rest' ? 'Rest day — recover well.' : 'Easy day.'}
          </div>
        ) : (
          <div className="exlist">
            {day.exercises.map((ex, i) => (
              <div className="exrow" key={`${ex.name}-${i}`}>
                <ExerciseImage slug={ex.slug} alt={ex.name} />
                <div className="exrow__body">
                  <div className="exrow__name">{ex.name}</div>
                  <div className="exrow__meta">
                    {ex.sets} × {ex.repRange}
                    {ex.targetWeight ? ` · ${ex.targetWeight}` : ''}
                  </div>
                  {ex.notes && <div className="exrow__notes">{ex.notes}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
