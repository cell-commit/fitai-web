import type { LoggedExercise } from '../types';
import { doneSetCount, previousLine } from '../services/sessionLog';
import { ExerciseImage } from './ExerciseImage';
import { ChevronRightIcon } from './icons';

/**
 * The in-gym session INDEX: one tappable row per exercise, modelled on the
 * commercial lifting apps.
 *
 * WAS: the whole session was one long scroll — every exercise card with all its
 * set rows stacked, so finding the movement he is actually on meant scrolling
 * past the ones he had finished. Now this list is the session's home screen and
 * each row opens that exercise's own page; the sticky "Finish session" footer,
 * the readiness card and the Watch bar stay here with it.
 *
 * Each row states the target (3 × 8-10) and the live progress (2/3 sets), and a
 * finished exercise is ticked off outright — the whole point of an index is
 * being able to see, in one glance from the rack, what is left.
 */
export function SessionIndex({
  exercises,
  previous,
  onOpen,
}: {
  exercises: LoggedExercise[];
  previous: (LoggedExercise | null)[];
  onOpen: (exIdx: number) => void;
}) {
  return (
    <ul className="session-index">
      {exercises.map((ex, i) => {
        const done = doneSetCount(ex.sets);
        const total = ex.sets.length;
        const complete = total > 0 && done >= total;
        const last = previousLine(previous[i] ?? null);
        return (
          <li key={`${ex.name}-${i}`}>
            <button
              type="button"
              className={`exindex-row${complete ? ' exindex-row--done' : ''}`}
              onClick={() => onOpen(i)}
            >
              <ExerciseImage slug={ex.slug} alt={ex.name} />
              <span className="exrow__body">
                <span className="exrow__name">{ex.name}</span>
                <span className="exrow__meta">
                  {ex.targetSets} × {ex.targetRepRange}
                </span>
                {last && <span className="ex-card__last">{last}</span>}
              </span>
              <span className="exindex-row__progress">
                {complete && (
                  <span className="exindex-row__tick" aria-hidden="true">
                    ✓
                  </span>
                )}
                <span className="exindex-row__count">
                  {done}/{total} sets
                </span>
              </span>
              <ChevronRightIcon className="row__chevron" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
