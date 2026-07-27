import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatMode, ChatToolEvent } from '../types';
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

  const sending = phase !== 'idle';
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
        | { status: 'failed'; error: Error; transient: boolean }
      >,
      target: { mode: ChatMode; text: string }
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

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    // Optimistic user bubble.
    const optimistic: ChatMessage = {
      id: `pending-${Date.now()}`,
      mode,
      role: 'user',
      text,
      timestamp: Date.now(),
    };
    const prior = messages;
    const sendMode = mode;
    setMessages([...prior, optimistic]);
    setInput('');

    await runWithWakeLock(
      'sending',
      () => performCoachSend(sendMode, text, prior),
      { mode: sendMode, text }
    );
  }

  const handleRetry = useCallback(
    async (target: SendFailure) => {
      if (sending) return;
      await runWithWakeLock(
        'reconnecting',
        () => retryCoachSend(target.mode, target.text, MAX_SEND_ATTEMPTS),
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
  // Attach the failed state to the user's own bubble where we can find it.
  let failedIndex = -1;
  if (activeFailure) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && m.text === activeFailure.text) {
        failedIndex = i;
        break;
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
          disabled={sending || input.trim().length === 0}
          aria-label="Send message"
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );
}

function Bubble({
  message,
  failure,
  onRetry,
  onDismiss,
}: {
  message: ChatMessage;
  failure?: SendFailure | null;
  onRetry?: (failure: SendFailure) => Promise<void>;
  onDismiss?: () => Promise<void>;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={`bubble-row bubble-row--${isUser ? 'user' : 'coach'}`}>
      <div className={`bubble bubble--${isUser ? 'user' : 'coach'}`}>
        {isUser ? message.text : <Markdown text={message.text} />}
      </div>
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
