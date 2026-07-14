import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProgressPhoto } from '../types';
import { getPhotos } from '../services/storage';
import {
  addPhoto,
  deletePhoto,
  exportPhoto,
  getPhotoUrl,
  getThumbUrl,
  askCoachAboutPhotos,
  revokeAllUrls,
} from '../services/photos';
import { TrendingIcon } from '../components/icons';

const MAX_SELECT = 4;

type SortedPhotos = ProgressPhoto[]; // always newest-first

function byNewest(a: ProgressPhoto, b: ProgressPhoto): number {
  return b.takenAt - a.takenAt;
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

function longDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function PhotosSegment() {
  const [photos, setPhotos] = useState<SortedPhotos | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);

  // Ask-coach flow
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [askSubmitting, setAskSubmitting] = useState(false);
  const [askDone, setAskDone] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const list = (await getPhotos()).slice().sort(byNewest);
    setPhotos(list);
  }, []);

  useEffect(() => {
    void reload();
    void refreshEstimate();
    return () => revokeAllUrls();
  }, [reload]);

  async function refreshEstimate() {
    try {
      if (navigator.storage?.estimate) {
        setEstimate(await navigator.storage.estimate());
      }
    } catch {
      /* estimate is best-effort */
    }
  }

  // ── Add ──────────────────────────────────────────────────────

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      // eslint-disable-next-line no-alert
      const note = files.length === 1 ? window.prompt('Add a note (optional):') : null;
      for (const file of Array.from(files)) {
        await addPhoto(file, note ?? undefined);
      }
      await reload();
      await refreshEstimate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the photo.');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  // ── Selection ────────────────────────────────────────────────

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_SELECT) {
        next.add(id);
      }
      return next;
    });
  }

  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
    setAsking(false);
    setQuestion('');
    setAskDone(false);
  }

  function onThumbClick(photo: ProgressPhoto, index: number) {
    if (selectMode) {
      toggleSelect(photo.id);
    } else {
      setViewerIndex(index);
    }
  }

  // ── Ask coach ────────────────────────────────────────────────

  async function submitAsk() {
    if (selected.size === 0 || askSubmitting) return;
    setError(null);
    setAskSubmitting(true);
    try {
      await askCoachAboutPhotos(Array.from(selected), question.trim() || undefined);
      setAskDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The coach could not review those photos.');
    } finally {
      setAskSubmitting(false);
    }
  }

  // ── Delete (from viewer) ─────────────────────────────────────

  async function handleDelete(id: string) {
    setBusy(true);
    try {
      await deletePhoto(id);
      setViewerIndex(null);
      await reload();
      await refreshEstimate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the photo.');
    } finally {
      setBusy(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────

  if (photos === null) {
    return (
      <div className="generating">
        <div className="spinner" aria-hidden="true" />
      </div>
    );
  }

  const hasPhotos = photos.length > 0;

  return (
    <div className="photos">
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {/* Toolbar */}
      <div className="photos__toolbar">
        {!selectMode ? (
          <>
            <button
              className="btn btn--inline"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              {busy ? 'Working…' : '+ Add photo'}
            </button>
            {hasPhotos && (
              <button
                className="btn btn--ghost btn--inline"
                onClick={() => setSelectMode(true)}
              >
                Select
              </button>
            )}
          </>
        ) : (
          <>
            <span className="photos__selcount">
              {selected.size}/{MAX_SELECT} selected
            </span>
            <button className="btn btn--ghost btn--inline" onClick={exitSelect}>
              Cancel
            </button>
          </>
        )}
      </div>

      {error && <div className="banner banner--error">{error}</div>}

      {!hasPhotos ? (
        <div className="placeholder">
          <div className="placeholder__icon">
            <TrendingIcon />
          </div>
          <div className="placeholder__title">No progress photos yet</div>
          <p>
            Add a photo to start tracking changes over time. Select up to four and
            ask your coach for honest feedback.
          </p>
        </div>
      ) : (
        <PhotoGrid
          photos={photos}
          selectMode={selectMode}
          selected={selected}
          onThumbClick={onThumbClick}
        />
      )}

      {/* Ask-coach bar (select mode) */}
      {selectMode && selected.size > 0 && (
        <div className="photos__askbar">
          {askDone ? (
            <div className="photos__askdone">
              <span className="photos__askdone-check">✓</span>
              <div>
                <strong>Sent to your coach.</strong> Open the <em>Coach</em> tab to
                read the feedback.
              </div>
              <button className="btn btn--ghost btn--inline" onClick={exitSelect}>
                Done
              </button>
            </div>
          ) : !asking ? (
            <button className="btn" onClick={() => setAsking(true)}>
              Ask coach about {selected.size}{' '}
              {selected.size === 1 ? 'photo' : 'photos'}
            </button>
          ) : (
            <div className="photos__askform">
              <label className="field__label" htmlFor="photo-question">
                Anything specific to ask? (optional)
              </label>
              <textarea
                id="photo-question"
                className="input"
                rows={2}
                placeholder="e.g. how are my shoulders looking vs last month?"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <div className="photos__askform-actions">
                <button
                  className="btn btn--ghost btn--inline"
                  onClick={() => setAsking(false)}
                  disabled={askSubmitting}
                >
                  Back
                </button>
                <button
                  className="btn btn--inline"
                  onClick={() => void submitAsk()}
                  disabled={askSubmitting}
                >
                  {askSubmitting ? 'Asking coach…' : 'Send to coach'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Storage estimate */}
      {estimate?.usage != null && (
        <div className="photos__storage muted">
          Storage used: {formatBytes(estimate.usage)}
          {estimate.quota != null && estimate.quota > 0
            ? ` of ${formatBytes(estimate.quota)} (${(
                (estimate.usage / estimate.quota) *
                100
              ).toFixed(1)}%)`
            : ''}
        </div>
      )}

      {/* Full-screen viewer */}
      {viewerIndex !== null && photos[viewerIndex] && (
        <PhotoViewer
          photos={photos}
          index={viewerIndex}
          busy={busy}
          onIndex={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Grid (month-grouped, newest first)
// ─────────────────────────────────────────────────────────────

function PhotoGrid({
  photos,
  selectMode,
  selected,
  onThumbClick,
}: {
  photos: ProgressPhoto[];
  selectMode: boolean;
  selected: Set<string>;
  onThumbClick: (photo: ProgressPhoto, index: number) => void;
}) {
  // Group consecutive (already newest-first) photos by month.
  const groups: { key: string; label: string; items: { photo: ProgressPhoto; index: number }[] }[] =
    [];
  photos.forEach((photo, index) => {
    const key = monthKey(photo.takenAt);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: monthLabel(photo.takenAt), items: [] };
      groups.push(group);
    }
    group.items.push({ photo, index });
  });

  return (
    <div className="photos__groups">
      {groups.map((group) => (
        <div className="photos__group" key={group.key}>
          <div className="section-label photos__month">{group.label}</div>
          <div className="photos__grid">
            {group.items.map(({ photo, index }) => (
              <Thumb
                key={photo.id}
                photo={photo}
                selectMode={selectMode}
                isSelected={selected.has(photo.id)}
                onClick={() => onThumbClick(photo, index)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Thumb({
  photo,
  selectMode,
  isSelected,
  onClick,
}: {
  photo: ProgressPhoto;
  selectMode: boolean;
  isSelected: boolean;
  onClick: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getThumbUrl(photo.id).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [photo.id]);

  return (
    <button
      className={`photo-thumb${isSelected ? ' photo-thumb--selected' : ''}`}
      onClick={onClick}
      aria-pressed={selectMode ? isSelected : undefined}
      aria-label={`Progress photo from ${longDate(photo.takenAt)}`}
    >
      {url ? (
        <img src={url} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="photo-thumb__ph" aria-hidden="true" />
      )}
      {selectMode && (
        <span className={`photo-thumb__check${isSelected ? ' photo-thumb__check--on' : ''}`}>
          {isSelected ? '✓' : ''}
        </span>
      )}
      {photo.note && <span className="photo-thumb__note" aria-hidden="true" />}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// Full-screen viewer
// ─────────────────────────────────────────────────────────────

function PhotoViewer({
  photos,
  index,
  busy,
  onIndex,
  onClose,
  onDelete,
}: {
  photos: ProgressPhoto[];
  index: number;
  busy: boolean;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
}) {
  const photo = photos[index];
  const [url, setUrl] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const touchStartX = useRef<number | null>(null);

  const hasPrev = index > 0;
  const hasNext = index < photos.length - 1;

  const goPrev = useCallback(() => {
    if (index > 0) onIndex(index - 1);
  }, [index, onIndex]);
  const goNext = useCallback(() => {
    if (index < photos.length - 1) onIndex(index + 1);
  }, [index, photos.length, onIndex]);

  useEffect(() => {
    setConfirming(false);
    let live = true;
    setUrl(null);
    void getPhotoUrl(photo.id).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [photo.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, goPrev, goNext]);

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  }
  function onTouchEnd(e: React.TouchEvent) {
    const start = touchStartX.current;
    if (start == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? start) - start;
    if (Math.abs(dx) > 50) {
      if (dx > 0) goPrev();
      else goNext();
    }
    touchStartX.current = null;
  }

  return (
    <div className="photo-viewer" role="dialog" aria-modal="true">
      <div className="photo-viewer__bar">
        <button className="photo-viewer__close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <span className="photo-viewer__count">
          {index + 1} / {photos.length}
        </span>
        <button
          className="photo-viewer__export"
          onClick={() => void exportPhoto(photo.id)}
          aria-label="Download photo"
        >
          Export
        </button>
      </div>

      <div
        className="photo-viewer__stage"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {hasPrev && (
          <button
            className="photo-viewer__nav photo-viewer__nav--prev"
            onClick={goPrev}
            aria-label="Previous photo"
          >
            ‹
          </button>
        )}
        {url ? (
          <img className="photo-viewer__img" src={url} alt="" />
        ) : (
          <div className="spinner" aria-hidden="true" />
        )}
        {hasNext && (
          <button
            className="photo-viewer__nav photo-viewer__nav--next"
            onClick={goNext}
            aria-label="Next photo"
          >
            ›
          </button>
        )}
      </div>

      <div className="photo-viewer__meta">
        <div className="photo-viewer__date">{longDate(photo.takenAt)}</div>
        {photo.note && <div className="photo-viewer__note">{photo.note}</div>}
        {!confirming ? (
          <button
            className="photo-viewer__delete"
            onClick={() => setConfirming(true)}
            disabled={busy}
          >
            Delete
          </button>
        ) : (
          <div className="photo-viewer__confirm">
            <span>Delete this photo?</span>
            <button
              className="btn btn--ghost btn--inline"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              className="btn btn--inline photo-viewer__delete-confirm"
              onClick={() => onDelete(photo.id)}
              disabled={busy}
            >
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
