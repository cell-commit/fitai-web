import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { LoggedExercise, LoggedSet } from '../types';
import {
  doneSetCount,
  isSetDone,
  placeholderForSet,
  previousLine,
} from '../services/sessionLog';
import { ExerciseImage } from './ExerciseImage';
import { ChevronRightIcon } from './icons';

/** Coach-prescribed guidance for one exercise (from the program day). */
export interface CoachTips {
  /** 4-digit tempo, e.g. "4030". */
  tempo?: string;
  /** ≤ 12-word technique cue. */
  notes?: string;
}

/**
 * Should advancing the active set also move keyboard focus into its weight box?
 *
 * Only on a fine pointer (i.e. a desktop browser, where focus costs nothing).
 * On the phone this is deliberately OFF: focusing a number input inside the ✓
 * tap gesture pops the iOS keyboard over the bottom half of the screen after
 * EVERY set — covering the rest pop-out and the row he just highlighted — and
 * he then has to dismiss it to see anything. The highlight plus the smooth
 * scroll carry the same "you're here now" message without hijacking the screen,
 * and one tap on the highlighted box still opens the keyboard when he wants it.
 */
function shouldFocusNextSet(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return !window.matchMedia('(pointer: coarse)').matches;
}

/**
 * ONE exercise, full screen: back to the index, the head (image / name / target
 * / last time), COACH TIPS, this exercise's set rows, "+ Add set", and the
 * comment box he types into at the end.
 *
 * Everything the old single-scroll card did is preserved — per-set ✓ commit,
 * placeholder materialisation, weight fill-forward, the active-row highlight
 * and the reps stepper. The rest timer is deliberately NOT here: it is mounted
 * above this navigation by SessionRunner so a running rest survives going back
 * to the index and into the next exercise.
 */
export function ExercisePage({
  ex,
  previous,
  tips,
  index,
  total,
  activeSet,
  advanceToken,
  completing,
  onBack,
  onUpdateSet,
  onCommitSet,
  onFillForward,
  onAddSet,
  onRemoveSet,
  onNoteChange,
  onInteract,
}: {
  ex: LoggedExercise;
  previous: LoggedExercise | null;
  tips?: CoachTips;
  /** 0-based position in the day, for the "Exercise 2 of 4" line. */
  index: number;
  total: number;
  activeSet: number | null;
  advanceToken: number;
  /** True during the "exercise complete" beat before the auto-return. */
  completing: boolean;
  onBack: () => void;
  onUpdateSet: (setIdx: number, patch: Partial<LoggedSet>) => void;
  onCommitSet: (setIdx: number) => void;
  onFillForward: () => void;
  onAddSet: () => void;
  onRemoveSet: (setIdx: number) => void;
  onNoteChange: (note: string) => void;
  /**
   * Fired on ANY pointer or key interaction inside the page. The auto-return
   * hangs off this: touch anything during the beat and you stay put.
   */
  onInteract: () => void;
}) {
  const done = doneSetCount(ex.sets);
  const last = previousLine(previous);
  const hasTips = !!tips?.tempo?.trim() || !!tips?.notes?.trim();

  return (
    <div
      className="ex-page"
      onPointerDownCapture={onInteract}
      onKeyDownCapture={onInteract}
    >
      <div className="ex-page__nav">
        <button
          type="button"
          className="btn btn--ghost btn--inline ex-page__back"
          onClick={onBack}
          aria-label="Back to exercises"
        >
          <ChevronRightIcon
            style={{ width: 16, height: 16, transform: 'rotate(180deg)' }}
          />
          Exercises
        </button>
        <span className="ex-page__position">
          {index + 1} of {total}
        </span>
      </div>

      <div className="card ex-card">
        <div className="ex-card__head">
          <ExerciseImage slug={ex.slug} alt={ex.name} />
          <div className="exrow__body">
            <div className="exrow__name">{ex.name}</div>
            <div className="exrow__meta">
              {ex.targetSets} × {ex.targetRepRange}
            </div>
            {last && <div className="ex-card__last">{last}</div>}
          </div>
          <div className="ex-card__progress">
            {done}/{ex.sets.length}
          </div>
        </div>

        {/* COACH TIPS — what the coach prescribed for THIS movement. Rendered
            only when there is something to say; an empty labelled box would be
            worse than no box. */}
        {hasTips && (
          <div className="coach-tips">
            <div className="coach-tips__label">Coach tips</div>
            {tips?.tempo?.trim() && (
              <div className="coach-tips__row">
                <span className="coach-tips__key">Tempo</span>
                <span className="coach-tips__tempo">{tips.tempo.trim()}</span>
              </div>
            )}
            {tips?.notes?.trim() && (
              <div className="coach-tips__cue">{tips.notes.trim()}</div>
            )}
          </div>
        )}

        <div className="set-rows">
          <div className="set-row set-row--header">
            <span className="set-row__idx">Set</span>
            <span className="set-row__weight-label">kg</span>
            <span className="set-row__reps-label">Reps</span>
            <span className="set-row__remove-label" />
          </div>
          {ex.sets.map((set, i) => (
            <SetRow
              key={i}
              index={i}
              set={set}
              placeholder={placeholderForSet(previous, i)}
              done={isSetDone(set)}
              committed={set.done === true}
              active={activeSet === i}
              advanceToken={advanceToken}
              onChange={(patch) => onUpdateSet(i, patch)}
              onCommit={() => onCommitSet(i)}
              onWeightBlur={i === 0 ? onFillForward : undefined}
              onRemove={ex.sets.length > 1 ? () => onRemoveSet(i) : undefined}
            />
          ))}
        </div>

        <button
          type="button"
          className="btn btn--ghost btn--inline ex-card__add"
          onClick={onAddSet}
        >
          + Add set
        </button>
      </div>

      {/* His comment on the movement. This is not a scratchpad: it rides into
          the SessionLog, into the Drive history entry and into the coach's
          context, so "was easy, up the weight" changes next week's plan. */}
      <div className="card ex-comment">
        <label className="field__label" htmlFor={`ex-note-${index}`}>
          How did that feel?
        </label>
        <textarea
          id={`ex-note-${index}`}
          className="input ex-comment__textarea"
          rows={2}
          placeholder="e.g. easy — up the weight next time"
          value={ex.note ?? ''}
          onChange={(e) => onNoteChange(e.target.value)}
        />
        <p className="field__hint">Your coach reads this before writing next week.</p>
      </div>

      {/* The beat before the auto-return: long enough to add a set or start
          typing (either of which cancels it), short enough not to be a wait. */}
      {completing && (
        <div className="ex-page__complete" role="status">
          <span className="ex-page__complete-tick" aria-hidden="true">
            ✓
          </span>
          Exercise complete — back to the list
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Set row — swipe left to reveal the bin
// ─────────────────────────────────────────────────────────────

/** Horizontal travel that counts as a delete swipe (and back again to hide). */
const SWIPE_TRIGGER_PX = 28;
/** Movement before the gesture is judged horizontal-or-vertical. */
const AXIS_LOCK_PX = 8;
/** Press-and-hold alternative to the swipe (accessibility / mouse users). */
const LONG_PRESS_MS = 550;

interface DragState {
  x: number;
  y: number;
  /** null until the axis is locked, then true for a horizontal drag. */
  horizontal: boolean | null;
}

function SetRow({
  index,
  set,
  placeholder,
  done,
  committed,
  active,
  advanceToken,
  onChange,
  onCommit,
  onWeightBlur,
  onRemove,
}: {
  index: number;
  set: LoggedSet;
  /** Last session's numbers for this row — rendered as faint guidance only. */
  placeholder: { reps?: number; weightKg?: number };
  done: boolean;
  /** True when the ✓ was actually tapped (vs. done inferred from reps). */
  committed: boolean;
  /** This is the "do this next" row. */
  active: boolean;
  /** Changes when a ✓ moved the highlight; the newly active row scrolls in. */
  advanceToken: number;
  onChange: (patch: Partial<LoggedSet>) => void;
  onCommit: () => void;
  onWeightBlur?: () => void;
  /** Absent on the last remaining row — a set list can never be emptied. */
  onRemove?: () => void;
}) {
  const weightEmpty = set.weightKg === 0;
  const repsEmpty = set.reps === 0;
  const weightGhost = weightEmpty && placeholder.weightKg !== undefined;
  const repsGhost = repsEmpty && placeholder.reps !== undefined;

  const rowRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const weightRef = useRef<HTMLInputElement>(null);

  // WAS: a permanent × on the end of every row — a destructive control sat one
  // fat-thumb away from the reps stepper for the whole session. Now the bin is
  // behind the row and only a deliberate left swipe (or a long press, or
  // tabbing to it) brings it out.
  const [revealed, setRevealed] = useState(false);
  const drag = useRef<DragState | null>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearLongPress() {
    if (longPress.current !== null) {
      clearTimeout(longPress.current);
      longPress.current = null;
    }
  }

  useEffect(() => clearLongPress, []);

  // Anything tapped outside this row puts the bin away again — a revealed bin
  // is a loaded gun, and it should not survive him moving on to another row.
  useEffect(() => {
    if (!revealed) return;
    function onDocDown(e: Event) {
      if (!wrapRef.current?.contains(e.target as Node)) setRevealed(false);
    }
    document.addEventListener('pointerdown', onDocDown, true);
    return () => document.removeEventListener('pointerdown', onDocDown, true);
  }, [revealed]);

  // Keyed on the token alone: it changes exactly once per ✓-driven advance, so
  // this can't fire on mount, on a re-render or when he undoes a set. Only the
  // row that IS the new active one reacts. scrollIntoView is optional-called —
  // jsdom does not implement it.
  useEffect(() => {
    if (!active || advanceToken === 0) return;
    rowRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    if (shouldFocusNextSet()) weightRef.current?.focus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advanceToken]);

  function handlePointerDown(e: ReactPointerEvent) {
    if (!onRemove) return;
    // A tap on the row itself (not the bin) while the bin is out just closes it.
    if (revealed && !(e.target as HTMLElement).closest?.('.set-row__bin')) {
      setRevealed(false);
    }
    drag.current = { x: e.clientX, y: e.clientY, horizontal: null };
    clearLongPress();
    longPress.current = setTimeout(() => {
      longPress.current = null;
      drag.current = null;
      setRevealed(true);
    }, LONG_PRESS_MS);
  }

  function handlePointerMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d || !onRemove) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (d.horizontal === null) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      // Lock the axis once: a vertical drag is him scrolling the page, and must
      // never turn into a reveal (the row also carries touch-action: pan-y so
      // the browser keeps owning vertical scroll).
      d.horizontal = Math.abs(dx) > Math.abs(dy);
      clearLongPress();
      if (!d.horizontal) {
        drag.current = null;
        return;
      }
    }
    if (dx <= -SWIPE_TRIGGER_PX) setRevealed(true);
    else if (dx >= SWIPE_TRIGGER_PX) setRevealed(false);
  }

  function endDrag() {
    clearLongPress();
    drag.current = null;
  }

  return (
    <div
      ref={wrapRef}
      className={`set-row-wrap${revealed ? ' set-row-wrap--revealed' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {onRemove && (
        // A real button, always in the DOM and always focusable: tabbing to it
        // reveals it, so a row can be deleted with no gesture at all.
        <button
          type="button"
          className="set-row__bin"
          onClick={() => {
            setRevealed(false);
            onRemove();
          }}
          onFocus={() => setRevealed(true)}
          aria-label={`Remove set ${index + 1}`}
        >
          <span aria-hidden="true">🗑</span>
        </button>
      )}

      <div
        ref={rowRef}
        className={`set-row${done ? ' set-row--done' : ''}${
          committed ? ' set-row--committed' : ''
        }${active ? ' set-row--active' : ''}`}
      >
        <span className="set-row__idx">{index + 1}</span>

        <input
          ref={weightRef}
          className={`input set-row__weight${
            weightGhost ? ' set-row__input--ghost' : ''
          }`}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.5"
          value={weightEmpty ? '' : set.weightKg}
          placeholder={
            placeholder.weightKg !== undefined ? String(placeholder.weightKg) : '0'
          }
          onChange={(e) =>
            onChange({ weightKg: Math.max(0, Number(e.target.value) || 0) })
          }
          onBlur={onWeightBlur}
          aria-label={`Set ${index + 1} weight`}
        />

        <div className="stepper">
          <button
            type="button"
            className="stepper__btn"
            onClick={() => onChange({ reps: Math.max(0, set.reps - 1) })}
            aria-label="Decrease reps"
          >
            −
          </button>
          <input
            className={`stepper__input${repsGhost ? ' set-row__input--ghost' : ''}`}
            type="number"
            inputMode="numeric"
            min={0}
            value={repsEmpty ? '' : set.reps}
            placeholder={
              placeholder.reps !== undefined ? String(placeholder.reps) : '0'
            }
            onChange={(e) =>
              onChange({ reps: Math.max(0, Number(e.target.value) || 0) })
            }
            aria-label={`Set ${index + 1} reps`}
          />
          <button
            type="button"
            className="stepper__btn"
            onClick={() => onChange({ reps: set.reps + 1 })}
            aria-label="Increase reps"
          >
            +
          </button>
        </div>

        <button
          type="button"
          className={`set-row__tick${committed ? ' set-row__tick--on' : ''}`}
          onClick={onCommit}
          aria-pressed={committed}
          aria-label={
            committed ? `Undo set ${index + 1}` : `Mark set ${index + 1} done`
          }
        >
          ✓
        </button>
      </div>
    </div>
  );
}
