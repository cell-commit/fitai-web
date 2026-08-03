import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatAttachment, ChatMessage, ChatMode, ChatToolEvent } from '../types';
import { getChatMessages } from '../services/storage';
import {
  MAX_SEND_ATTEMPTS,
  clearInflightSend,
  getInflightSend,
  isSendRunning,
  performCoachSend,
  resumeInflightSend,
  retryCoachSend,
} from '../services/coachInflight';
import {
  MAX_CHAT_ATTACHMENTS,
  addChatAttachments,
  deleteChatAttachments,
  getAttachmentUrl,
  pruneOrphanAttachments,
  revokeAllAttachmentUrls,
} from '../services/chatAttachments';
import {
  getCoachContextStatus,
  isCoachContextStale,
  refreshCoachContext,
  type CoachContextStatus,
} from '../services/coachContext';
import { CONTINUE_TEXT } from '../services/coach';
import { acquireWakeLock } from '../utils/wakeLock';
import { ChatIcon } from '../components/icons';
import { Markdown } from '../components/Markdown';

// Chip glyph + fallback label per tool.
const TOOL_CHIP: Record<string, { icon: string; label: string }> = {
  update_weekly_program: { icon: '📅', label: 'Updated weekly program' },
  edit_training_status: { icon: '✏️', label: 'Edited training status' },
  read_history_log: { icon: '📖', label: 'Read history log' },
  append_history_log: { icon: '📝', label: 'Appended to history log' },
};

/** Shown for connectivity / suspension failures — the message is safe on device. */
const INTERRUPTED_COPY =
  'Reply interrupted — your phone may have slept. Your message was saved.';

/** After this long, suggest keeping the screen on (only if we hold no wake lock). */
const WAKE_HINT_AFTER_S = 20;

/** How long a "Training files updated" / "Already up to date" line lingers. */
const CONTEXT_NOTE_MS = 4000;

/** Compact relative age for the context line ("2m", "3h", "5d"). */
function ageLabel(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface SendFailure {
  mode: ChatMode;
  text: string;
  message: string;
  /** Connectivity/abort (retry is likely to work) vs a real API verdict. */
  transient: boolean;
  /** Identify the failed turn without its text — a photo-only send has none. */
  messageId?: string;
  /** So Retry re-attaches the same images (blobs are kept for exactly this). */
  attachmentIds?: string[];
}

type Phase = 'idle' | 'sending' | 'reconnecting';

export function CoachPane() {
  const [mode, setMode] = useState<ChatMode>('coach');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [failure, setFailure] = useState<SendFailure | null>(null);
  const [status, setStatus] = useState<CoachContextStatus | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [screenHeldAwake, setScreenHeldAwake] = useState(false);
  const [pending, setPending] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ChatAttachment | null>(null);
  const [contextNote, setContextNote] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const sending = phase !== 'idle';
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Guards the resume path against overlapping runs (mount + visibilitychange,
  // or StrictMode's double effect invocation).
  const resumingRef = useRef(false);
  // Guards the context refresh the same way, and lets the async body read the
  // live sending state without re-creating the callback on every phase change.
  const refreshingRef = useRef(false);
  const sendingRef = useRef(sending);
  sendingRef.current = sending;

  /**
   * Pull the Drive files into the cache and report honestly on the result.
   *
   * Refresh happens BETWEEN turns only, never mid-send: the system blocks are
   * assembled once at the start of a send, so re-pulling underneath it would
   * change the cached prefix for the next turn and could swap the training
   * status out from under a reply already in progress. `auto` runs are also
   * skipped entirely unless the cache is actually stale, so returning to the
   * foreground mid-conversation does not churn the prompt cache.
   */
  const syncContext = useCallback(async (opts: { auto: boolean }) => {
    if (refreshingRef.current) return;
    if (opts.auto) {
      if (sendingRef.current || isSendRunning()) return;
      if (!(await isCoachContextStale())) {
        setStatus(await getCoachContextStatus());
        return;
      }
      // Re-check after the await — a send may have started in the meantime.
      if (sendingRef.current || isSendRunning()) return;
    }
    refreshingRef.current = true;
    if (!opts.auto) setRefreshing(true);
    try {
      const result = await refreshCoachContext();
      setStatus(await getCoachContextStatus());
      if (!result.ok) {
        // Never silent: the status line below switches to the failed state.
        setContextNote(null);
      } else if (result.changed) {
        setContextNote('Training files updated');
      } else if (!opts.auto) {
        setContextNote('Already up to date');
      }
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, []);

  // Mount + every return to the foreground: refresh the coach context when the
  // cached copy has gone stale. Refresh is NOT per-message (keeps system bytes
  // stable within a send — design §2.3).
  useEffect(() => {
    void (async () => {
      setStatus(await getCoachContextStatus());
      await syncContext({ auto: true });
    })();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void syncContext({ auto: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [syncContext]);

  // The "updated" / "up to date" line is transient feedback, not a status.
  useEffect(() => {
    if (!contextNote) return;
    const id = setTimeout(() => setContextNote(null), CONTEXT_NOTE_MS);
    return () => clearTimeout(id);
  }, [contextNote]);

  // Reclaim blobs whose message was evicted by the 200-message cap. Strictly
  // fire-and-forget: it must never be awaited on the way to a first paint, and a
  // failure here is a storage-space problem, not a chat problem.
  useEffect(() => {
    void pruneOrphanAttachments().catch(() => {});
  }, []);

  // Object URLs are cached for the pane's lifetime (thumbnails re-render often);
  // release them all when it goes away.
  useEffect(() => revokeAllAttachmentUrls, []);

  // Load the thread for the active mode (separate coach / nutrition threads).
  useEffect(() => {
    let live = true;
    void getChatMessages(mode).then((m) => {
      if (live) setMessages(m);
    });
    return () => {
      live = false;
    };
  }, [mode]);

  // Auto-scroll to the newest message / typing indicator. A bottom sentinel is
  // used so it works whichever ancestor is the scroll container.
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, sending]);

  function autosize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  useEffect(autosize, [input]);

  // Elapsed counter so a 60s wait reads as progress, not a hang.
  useEffect(() => {
    if (!sending) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000
    );
    return () => clearInterval(id);
  }, [sending]);

  /**
   * Run a send (or a retry) with the screen held awake for its duration. The
   * wake lock only makes iOS suspension less likely — it cannot prevent an app
   * switch — so the in-flight record inside performCoachSend/retryCoachSend is
   * what actually makes an interruption recoverable.
   */
  const runWithWakeLock = useCallback(
    async (
      nextPhase: Phase,
      run: () => Promise<
        | { status: 'ok' }
        | { status: 'busy' }
        | { status: 'already-complete' }
        | {
            status: 'failed';
            error: Error;
            transient: boolean;
            messageId?: string;
            attachmentIds?: string[];
          }
      >,
      target: { mode: ChatMode; text: string; attachmentIds?: string[] }
    ) => {
      setFailure(null);
      setPhase(nextPhase);
      const lock = await acquireWakeLock();
      setScreenHeldAwake(lock.granted);
      try {
        const outcome = await run();
        if (outcome.status === 'failed') {
          setFailure({
            mode: target.mode,
            text: target.text,
            message: outcome.transient ? INTERRUPTED_COPY : outcome.error.message,
            transient: outcome.transient,
            messageId: outcome.messageId,
            attachmentIds: outcome.attachmentIds ?? target.attachmentIds,
          });
        }
      } finally {
        await lock.release();
        setScreenHeldAwake(false);
        setPhase('idle');
        if (modeRef.current === target.mode) {
          setMessages(await getChatMessages(target.mode));
        }
      }
    },
    []
  );

  // ── Attachments ─────────────────────────────────────────────

  async function handleFiles(list: FileList | null) {
    const picked = Array.from(list ?? []);
    if (fileInputRef.current) fileInputRef.current.value = ''; // allow re-picking
    if (picked.length === 0) return;

    const room = MAX_CHAT_ATTACHMENTS - pending.length;
    if (room <= 0) {
      setAttachError(`You can attach up to ${MAX_CHAT_ATTACHMENTS} photos.`);
      return;
    }
    setAttachError(
      picked.length > room ? `Only ${MAX_CHAT_ATTACHMENTS} photos per message.` : null
    );
    try {
      const added = await addChatAttachments(picked.slice(0, room));
      setPending((prev) => [...prev, ...added]);
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : 'Could not attach that photo.');
    }
  }

  async function removePending(id: string) {
    setPending((prev) => prev.filter((a) => a.id !== id));
    setAttachError(null);
    // Never sent, so nothing references it — delete the blob straight away.
    await deleteChatAttachments([id]);
  }

  async function handleSend() {
    const text = input.trim();
    const attachments = pending;
    if ((!text && attachments.length === 0) || sending) return;

    // Optimistic user bubble.
    const optimistic: ChatMessage = {
      id: `pending-${Date.now()}`,
      mode,
      role: 'user',
      text,
      timestamp: Date.now(),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    const prior = messages;
    const sendMode = mode;
    setMessages([...prior, optimistic]);
    setInput('');
    setPending([]);
    setAttachError(null);

    await runWithWakeLock(
      'sending',
      () => performCoachSend(sendMode, text, prior, 1, { attachments }),
      {
        mode: sendMode,
        text,
        attachmentIds: attachments.map((a) => a.id),
      }
    );
  }

  const handleRetry = useCallback(
    async (target: SendFailure) => {
      if (sending) return;
      await runWithWakeLock(
        'reconnecting',
        () =>
          retryCoachSend(target.mode, target.text, MAX_SEND_ATTEMPTS, {
            messageId: target.messageId,
            attachmentIds: target.attachmentIds,
          }),
        target
      );
    },
    [runWithWakeLock, sending]
  );

  const handleDismiss = useCallback(async () => {
    await clearInflightSend();
    setFailure(null);
  }, []);

  /**
   * If a send was recorded but nothing is running, the page was suspended
   * mid-flight: retry once (showing "Reconnecting…"), or surface the honest
   * failed state when that single retry is already spent.
   */
  const resume = useCallback(async () => {
    if (resumingRef.current || isSendRunning()) return;
    const record = await getInflightSend();
    if (!record) return;

    resumingRef.current = true;
    try {
      if (record.attempts >= MAX_SEND_ATTEMPTS) {
        const outcome = await resumeInflightSend();
        if (modeRef.current === record.mode) {
          setMessages(await getChatMessages(record.mode));
        }
        if (outcome.status === 'exhausted') {
          setFailure({
            mode: record.mode,
            text: record.text,
            message: INTERRUPTED_COPY,
            transient: true,
            messageId: record.messageId,
            attachmentIds: record.attachmentIds,
          });
        } else if (outcome.status === 'already-complete') {
          setFailure(null);
        }
        return;
      }

      setFailure(null);
      setPhase('reconnecting');
      const lock = await acquireWakeLock();
      setScreenHeldAwake(lock.granted);
      try {
        const outcome = await resumeInflightSend();
        if (outcome.status === 'retried' && outcome.result.status === 'failed') {
          setFailure({
            mode: record.mode,
            text: record.text,
            message: outcome.result.transient
              ? INTERRUPTED_COPY
              : outcome.result.error.message,
            transient: outcome.result.transient,
            messageId: outcome.result.messageId ?? record.messageId,
            attachmentIds: outcome.result.attachmentIds ?? record.attachmentIds,
          });
        }
      } finally {
        await lock.release();
        setScreenHeldAwake(false);
        setPhase('idle');
        if (modeRef.current === record.mode) {
          setMessages(await getChatMessages(record.mode));
        }
      }
    } finally {
      resumingRef.current = false;
    }
  }, []);

  // Mount + every return to the foreground.
  useEffect(() => {
    void resume();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [resume]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  /**
   * Resume a reply that hit the output cap. The partial assistant turn is
   * already persisted and is passed through as history, so the model continues
   * from where it stopped instead of regenerating the same oversized answer.
   */
  async function handleContinue() {
    if (sending) return;
    const prior = messages;
    const sendMode = mode;
    const optimistic: ChatMessage = {
      id: `pending-${Date.now()}`,
      mode: sendMode,
      role: 'user',
      text: CONTINUE_TEXT,
      timestamp: Date.now(),
    };
    setMessages([...prior, optimistic]);

    await runWithWakeLock(
      'sending',
      () =>
        performCoachSend(sendMode, CONTINUE_TEXT, prior, 1, { continuation: true }),
      { mode: sendMode, text: CONTINUE_TEXT }
    );
  }

  const activeFailure = failure && failure.mode === mode ? failure : null;
  // Attach the failed state to the user's own bubble where we can find it. By id
  // when we have one — a photo-only message has no text to match on.
  let failedIndex = -1;
  if (activeFailure) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      const hit = activeFailure.messageId
        ? m.id === activeFailure.messageId
        : m.text === activeFailure.text;
      if (hit) {
        failedIndex = i;
        break;
      }
    }
    // The optimistic bubble carries a local id, so fall back to the text match
    // before giving up and rendering the standalone notice.
    if (failedIndex === -1 && activeFailure.text) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user' && m.text === activeFailure.text) {
          failedIndex = i;
          break;
        }
      }
    }
  }
  const showWakeHint =
    sending && elapsed >= WAKE_HINT_AFTER_S && !screenHeldAwake;

  return (
    <div className="chat">
      <div className="segmented" role="tablist" aria-label="Chat mode">
        <button
          className={`segmented__btn${mode === 'coach' ? ' segmented__btn--active' : ''}`}
          role="tab"
          aria-selected={mode === 'coach'}
          onClick={() => setMode('coach')}
        >
          Coach
        </button>
        <button
          className={`segmented__btn${mode === 'nutrition' ? ' segmented__btn--active' : ''}`}
          role="tab"
          aria-selected={mode === 'nutrition'}
          onClick={() => setMode('nutrition')}
        >
          Nutrition
        </button>
      </div>

      <div className="chat__messages">
        {messages.length === 0 && !sending && (
          <div className="chat__empty">
            <div className="chat__empty-icon">
              <ChatIcon />
            </div>
            <div className="chat__empty-title">
              {mode === 'coach' ? 'Talk to your coach' : 'Nutrition guidance'}
            </div>
            <p>
              {mode === 'coach'
                ? 'Ask about your plan or flag how you feel — “lower back’s sore, drop RDLs this week”. The coach replies and updates your program and training files.'
                : 'Ask what to eat around training to hit your calorie and protein targets.'}
            </p>
          </div>
        )}

        {messages.map((m, i) => (
          <Bubble
            key={m.id}
            message={m}
            failure={i === failedIndex ? activeFailure : null}
            onRetry={handleRetry}
            onDismiss={handleDismiss}
            onOpenAttachment={setViewer}
            // Only the newest turn can be continued — resuming an older
            // truncated reply would append to the wrong end of the thread.
            onContinue={
              i === messages.length - 1 && !sending ? handleContinue : undefined
            }
          />
        ))}

        {/* Failure whose message isn't in the visible thread (rare) — never
            leave the user without an explanation and a way out. */}
        {activeFailure && failedIndex === -1 && (
          <div className="bubble-row bubble-row--user">
            <FailedNotice
              failure={activeFailure}
              onRetry={handleRetry}
              onDismiss={handleDismiss}
            />
          </div>
        )}

        {sending && (
          <div className="bubble-row bubble-row--coach">
            <div
              className="bubble bubble--coach bubble--typing"
              aria-label={phase === 'reconnecting' ? 'Reconnecting' : 'Coach is typing'}
            >
              <span className="typing__dot" />
              <span className="typing__dot" />
              <span className="typing__dot" />
            </div>
            <div className="chat__waiting" aria-live="polite">
              {phase === 'reconnecting'
                ? 'Reconnecting…'
                : `Coach is thinking… ${elapsed}s`}
            </div>
            {showWakeHint && (
              <div className="chat__waiting-hint">
                Keeping the screen on helps long replies finish.
              </div>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat__inputbar">
        {/* No capture="environment": he needs the photo library, not a forced
            camera. Otherwise identical to the PhotosSegment picker. */}
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          multiple
          data-testid="chat-file-input"
          onChange={(e) => void handleFiles(e.target.files)}
        />

        {/* Training-files status + Refresh, directly above the input row.
            It used to live at the top of the thread, which meant scrolling a
            long conversation to reach it. This is the only always-visible strip
            on the screen (the bar is fixed), and the input bar is already a
            column stacking errors and thumbnails, so it fits without touching
            the 📎 / textarea / send row. */}
        {mode === 'coach' && (
          <ContextLine
            status={status}
            note={contextNote}
            busy={refreshing}
            onRefresh={() => void syncContext({ auto: false })}
          />
        )}

        {attachError && <div className="chat__attach-error">{attachError}</div>}

        {pending.length > 0 && (
          <div className="chat__pending" aria-label="Attached photos">
            {pending.map((a) => (
              <div className="chat__chip" key={a.id}>
                <AttachmentImage
                  attachment={a}
                  className="chat__chip-img"
                  alt="Attached photo"
                />
                <button
                  className="chat__chip-x"
                  onClick={() => void removePending(a.id)}
                  aria-label="Remove photo"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="chat__inputrow">
          <button
            className="chat__attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || pending.length >= MAX_CHAT_ATTACHMENTS}
            aria-label="Attach photo"
          >
            📎
          </button>
          <textarea
            ref={textareaRef}
            className="chat__textarea"
            rows={1}
            placeholder={
              mode === 'coach' ? 'Message your coach…' : 'Ask about food…'
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={sending}
          />
          <button
            className="chat__send"
            onClick={() => void handleSend()}
            disabled={sending || (input.trim().length === 0 && pending.length === 0)}
            aria-label="Send message"
          >
            <SendIcon />
          </button>
        </div>
      </div>

      {viewer && (
        <div
          className="chat-att-viewer"
          role="dialog"
          aria-label="Photo"
          onClick={() => setViewer(null)}
        >
          <button className="chat-att-viewer__close" aria-label="Close photo">
            ×
          </button>
          <AttachmentImage
            attachment={viewer}
            className="chat-att-viewer__img"
            alt="Attached photo"
          />
        </div>
      )}
    </div>
  );
}

/**
 * An attachment rendered from its IndexedDB blob. The object URL is cached in
 * chatAttachments for the pane's lifetime, so re-renders do not re-create it.
 */
function AttachmentImage({
  attachment,
  className,
  alt,
  onClick,
}: {
  attachment: ChatAttachment;
  className: string;
  alt: string;
  onClick?: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getAttachmentUrl(attachment).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [attachment]);

  if (!url) return <span className={`${className} ${className}--empty`} />;
  return <img className={className} src={url} alt={alt} onClick={onClick} />;
}

/**
 * Training-files status, rendered just above the input.
 *
 * Three genuinely different states, because collapsing them is what hid the
 * bug: connected-and-fresh (with how recently), connected-but-the-last-refresh-
 * FAILED (still answering, but from an unverified copy), and not-configured.
 * A failed refresh must never read the same as a successful one.
 */
function ContextLine({
  status,
  note,
  busy,
  onRefresh,
}: {
  status: CoachContextStatus | null;
  note: string | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  const failed = !!status?.error;
  const age = status?.ageMs != null ? ageLabel(status.ageMs) : null;

  let tone = 'dot dot--off';
  let text: string;
  if (status == null) {
    text = 'Checking training files…';
  } else if (failed) {
    tone = 'dot dot--warn';
    text = age
      ? `Couldn’t reach your training files — using a copy from ${age}`
      : 'Couldn’t reach your training files';
  } else if (status.hasStatusFile) {
    tone = 'dot dot--ok';
    text = age ? `Training files · updated ${age}` : 'Training files connected';
  } else if (status.configured) {
    tone = 'dot dot--warn';
    text = 'Sync on — training files not loaded yet';
  } else {
    text = 'No training files connected';
  }

  return (
    <div
      className={`chat__context${failed ? ' chat__context--failed' : ''}`}
      role="status"
    >
      <span className={tone} />
      <span className="chat__context-text">
        {busy ? 'Refreshing…' : (note ?? text)}
      </span>
      <button
        className="chat__context-refresh"
        onClick={onRefresh}
        disabled={busy}
        aria-label="Refresh training files"
      >
        {failed ? 'Retry' : 'Refresh'}
      </button>
    </div>
  );
}

function Bubble({
  message,
  failure,
  onRetry,
  onDismiss,
  onOpenAttachment,
  onContinue,
}: {
  message: ChatMessage;
  failure?: SendFailure | null;
  onRetry?: (failure: SendFailure) => Promise<void>;
  onDismiss?: () => Promise<void>;
  onOpenAttachment?: (a: ChatAttachment) => void;
  onContinue?: () => Promise<void>;
}) {
  const isUser = message.role === 'user';
  const attachments = message.attachments ?? [];
  return (
    <div className={`bubble-row bubble-row--${isUser ? 'user' : 'coach'}`}>
      {attachments.length > 0 && (
        <div className="bubble-atts">
          {attachments.map((a) => (
            <AttachmentImage
              key={a.id}
              attachment={a}
              className="bubble-att"
              alt="Attached photo"
              onClick={() => onOpenAttachment?.(a)}
            />
          ))}
        </div>
      )}
      {(message.text || attachments.length === 0) && (
        <div className={`bubble bubble--${isUser ? 'user' : 'coach'}`}>
          {isUser ? message.text : <Markdown text={message.text} />}
        </div>
      )}
      {!isUser && message.toolEvents && message.toolEvents.length > 0 && (
        <div className="tool-chips">
          {message.toolEvents.map((ev, i) => (
            <ToolChip key={i} event={ev} />
          ))}
        </div>
      )}
      {/* The reply hit the output cap. Its text is kept in full above — this
          resumes it rather than making him type "Continue" and get the same
          oversized answer regenerated from scratch. */}
      {!isUser && message.truncated && onContinue && (
        <div className="bubble-cut" role="status">
          <span className="bubble-cut__text">Cut off at the length limit.</span>
          <button className="bubble-cut__btn" onClick={() => void onContinue()}>
            Continue
          </button>
        </div>
      )}
      {failure && onRetry && onDismiss && (
        <FailedNotice failure={failure} onRetry={onRetry} onDismiss={onDismiss} />
      )}
    </div>
  );
}

/**
 * Honest, recoverable failed state. The user's text stays on screen and is
 * already persisted, so Retry re-sends exactly that message. Real API verdicts
 * (bad key, rate limit) keep their own wording instead of blaming the phone.
 */
function FailedNotice({
  failure,
  onRetry,
  onDismiss,
}: {
  failure: SendFailure;
  onRetry: (failure: SendFailure) => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const needsKey = /api key/i.test(failure.message);
  return (
    <div className="msg-failed" role="status">
      <div className="msg-failed__text">
        {failure.message}
        {needsKey && !/in settings/i.test(failure.message) && (
          <> Add your Anthropic API key in Settings.</>
        )}
      </div>
      <div className="msg-failed__actions">
        <button
          className="msg-failed__btn msg-failed__btn--primary"
          onClick={() => void onRetry(failure)}
        >
          Retry
        </button>
        <button className="msg-failed__btn" onClick={() => void onDismiss()}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function ToolChip({ event }: { event: ChatToolEvent }) {
  const meta = TOOL_CHIP[event.tool] ?? { icon: '🛠️', label: event.tool };
  return (
    <span className="tool-chip">
      <span className="tool-chip__icon" aria-hidden="true">
        {meta.icon}
      </span>
      {event.summary || meta.label}
    </span>
  );
}

function SendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={20}
      height={20}
    >
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7z" />
    </svg>
  );
}
