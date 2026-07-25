import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatMode, ChatToolEvent } from '../types';
import { getChatMessages } from '../services/storage';
import { sendCoachMessage } from '../services/coach';
import {
  getCoachContextStatus,
  refreshCoachContext,
  type CoachContextStatus,
} from '../services/coachContext';
import { ChatIcon } from '../components/icons';
import { Markdown } from '../components/Markdown';

// Chip glyph + fallback label per tool.
const TOOL_CHIP: Record<string, { icon: string; label: string }> = {
  update_weekly_program: { icon: '📅', label: 'Updated weekly program' },
  edit_training_status: { icon: '✏️', label: 'Edited training status' },
  read_history_log: { icon: '📖', label: 'Read history log' },
  append_history_log: { icon: '📝', label: 'Appended to history log' },
};

export function CoachPane() {
  const [mode, setMode] = useState<ChatMode>('coach');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<CoachContextStatus | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    setError(null);
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

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setError(null);
    setSending(true);

    // Optimistic user bubble.
    const optimistic: ChatMessage = {
      id: `pending-${Date.now()}`,
      mode,
      role: 'user',
      text,
      timestamp: Date.now(),
    };
    const prior = messages;
    setMessages([...prior, optimistic]);
    setInput('');

    try {
      await sendCoachMessage(mode, text, prior);
      // Reconcile from storage (source of truth — persisted user + assistant).
      setMessages(await getChatMessages(mode));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Keep the optimistic user bubble so the text isn't lost visually; the
      // user turn was already persisted inside sendCoachMessage.
      setMessages(await getChatMessages(mode));
    } finally {
      setSending(false);
    }
  }

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

  const apiKeyIssue = error && /api key/i.test(error);

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

        {messages.map((m) => (
          <Bubble key={m.id} message={m} />
        ))}

        {sending && (
          <div className="bubble-row bubble-row--coach">
            <div className="bubble bubble--coach bubble--typing" aria-label="Coach is typing">
              <span className="typing__dot" />
              <span className="typing__dot" />
              <span className="typing__dot" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="banner banner--error chat__error">
          {error}
          {apiKeyIssue && !/in settings/i.test(error) && (
            <> Add your Anthropic API key in Settings.</>
          )}
        </div>
      )}

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

function Bubble({ message }: { message: ChatMessage }) {
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
