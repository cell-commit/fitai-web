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
  refreshCoachContext,
  type CoachContextStatus,
} from '../services/coachContext';
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

  const sending = phase !== 'idle';
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Guards the resume path against overlapping runs (mount + visibilitychange,
  // or StrictMode's double effect invocation).
  const resumingRef = useRef(false);

  // Pull the latest Drive files once on mount so the coach context is fresh, and
  // load the connection status for the context line. Refresh is NOT per-message
  // (keeps system bytes stable within the session — design §2.3).
  useEffect(() => {
    void (async () => {
      await refreshCoachContext();
      setStatus(await getCoachContextStatus());
    })();
  }, []);

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

  async function handleRefresh() {
    await refreshCoachContext();
    setStatus(await getCoachContextStatus());
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

      {mode === 'coach' && (
        <div className="chat__context">
          <span className={status?.hasStatusFile ? 'dot dot--ok' : 'dot dot--off'} />
          <span className="chat__context-text">
            {status == null
              ? 'Checking training files…'
              : status.hasStatusFile
                ? 'Training files connected'
                : status.configured
                  ? 'Sync on — training files still loading'
                  : 'No training files connected'}
          </span>
          <button
            className="chat__context-refresh"
            onClick={handleRefresh}
            aria-label="Refresh training context"
          >
            Refresh
          </button>
        </div>
      )}

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

function Bubble({
  message,
  failure,
  onRetry,
  onDismiss,
  onOpenAttachment,
}: {
  message: ChatMessage;
  failure?: SendFailure | null;
  onRetry?: (failure: SendFailure) => Promise<void>;
  onDismiss?: () => Promise<void>;
  onOpenAttachment?: (a: ChatAttachment) => void;
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
