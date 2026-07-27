// In-flight coach send: durability + one automatic retry on resume.
//
// THE PROBLEM: a coach reply takes 30–60s. If the iPhone screen turns off or
// Jason switches apps, iOS suspends the page and the in-flight fetch dies. The
// old behaviour was a bare red "Load failed" banner and a message that looked
// lost.
//
// WHAT IS AND IS NOT POSSIBLE: a PWA cannot keep a fetch running while the page
// is suspended — there is no honest way to fake background execution. So instead
// this module makes the interruption survivable:
//   • the send is recorded in storage the instant it starts (so it outlives the
//     page being frozen or killed);
//   • the user turn is already persisted by sendCoachMessage, so the text is
//     never lost;
//   • when the page comes back and no request is actually running, we retry the
//     recorded send ONCE;
//   • before retrying we re-read the thread — if an assistant reply for that
//     exact user turn already landed, the original call DID reach Claude and the
//     retry is skipped (retrying costs money and could duplicate a program
//     change);
//   • a module-level flag makes a resume-retry a no-op while a real request is
//     still running in this tab, so nothing double-sends.

import type { ChatMessage, ChatMode } from '../types';
import { isTransientClaudeError } from './claude';
import { sendCoachMessage } from './coach';
import {
  clearInflightSend,
  getChatMessages,
  getInflightSend,
  saveChatMessages,
  saveInflightSend,
  type InflightCoachSend,
} from './storage';

export type { InflightCoachSend };
export { clearInflightSend, getInflightSend };

/** Original send + one automatic retry. */
export const MAX_SEND_ATTEMPTS = 2;

// Module-level so it is shared by the pane, the mount check and the
// visibilitychange handler — a retry can never race a live request.
let running = false;

/** True while a coach request is actually in flight in this tab. */
export function isSendRunning(): boolean {
  return running;
}

/** Test-only reset of the module-level flag. */
export function resetSendRunningForTests(): void {
  running = false;
}

export type SendOutcome =
  | { status: 'ok' }
  | { status: 'busy' }
  | { status: 'failed'; error: Error; transient: boolean };

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Send a coach message with durability: the in-flight record is written before
 * the call and cleared on success. A non-transient failure (bad key, rate limit,
 * refusal) also clears it — those must not be retried automatically. A transient
 * failure keeps the record so the resume path can retry once.
 */
export async function performCoachSend(
  mode: ChatMode,
  text: string,
  history: ChatMessage[],
  attempt = 1
): Promise<SendOutcome> {
  if (running) return { status: 'busy' };
  running = true;
  await saveInflightSend({ mode, text, startedAt: Date.now(), attempts: attempt });
  try {
    await sendCoachMessage(mode, text, history);
    await clearInflightSend();
    return { status: 'ok' };
  } catch (e) {
    const error = toError(e);
    const transient = isTransientClaudeError(error);
    if (!transient) await clearInflightSend();
    return { status: 'failed', error, transient };
  } finally {
    running = false;
  }
}

/**
 * True when an assistant turn exists after the last user turn with this text —
 * i.e. the request we thought died actually completed.
 */
export function hasAssistantReplyFor(
  thread: ChatMessage[],
  text: string
): boolean {
  let lastUserIdx = -1;
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (m.role === 'user' && m.text === text) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return false;
  return thread.slice(lastUserIdx + 1).some((m) => m.role === 'assistant');
}

/**
 * Drop the trailing, unanswered user turn for `text` if present. sendCoachMessage
 * persists the user turn before calling the API, so an interrupted send leaves an
 * orphan at the end of the thread; re-sending would otherwise duplicate it.
 */
export function stripOrphanUserTurn(
  thread: ChatMessage[],
  text: string
): ChatMessage[] {
  const last = thread[thread.length - 1];
  if (last && last.role === 'user' && last.text === text) {
    return thread.slice(0, -1);
  }
  return thread;
}

export type RetryResult =
  | { status: 'ok' }
  | { status: 'busy' }
  | { status: 'already-complete' }
  | { status: 'failed'; error: Error; transient: boolean };

/**
 * Re-send an interrupted message. Skips the call entirely when the reply already
 * landed, and rebuilds the thread so the retry does not duplicate the user turn.
 */
export async function retryCoachSend(
  mode: ChatMode,
  text: string,
  attempt: number
): Promise<RetryResult> {
  if (running) return { status: 'busy' };

  const thread = await getChatMessages(mode);
  if (hasAssistantReplyFor(thread, text)) {
    // The original request DID reach Claude — do not pay for it twice.
    await clearInflightSend();
    return { status: 'already-complete' };
  }

  const prior = stripOrphanUserTurn(thread, text);
  if (prior.length !== thread.length) {
    await saveChatMessages(mode, prior);
  }
  return performCoachSend(mode, text, prior, attempt);
}

export type ResumeOutcome =
  | { status: 'none' }
  | { status: 'busy' }
  | { status: 'already-complete'; mode: ChatMode; text: string }
  | { status: 'exhausted'; mode: ChatMode; text: string }
  | { status: 'retried'; mode: ChatMode; text: string; result: RetryResult };

/**
 * Called on CoachPane mount and whenever the page becomes visible again. If a
 * send was recorded and nothing is running, we were suspended mid-flight: retry
 * once, or report that the retry budget is spent so the UI can show an honest,
 * recoverable failed state.
 */
export async function resumeInflightSend(): Promise<ResumeOutcome> {
  if (running) return { status: 'busy' };

  const record = await getInflightSend();
  if (!record) return { status: 'none' };

  const thread = await getChatMessages(record.mode);
  if (hasAssistantReplyFor(thread, record.text)) {
    await clearInflightSend();
    return {
      status: 'already-complete',
      mode: record.mode,
      text: record.text,
    };
  }

  if (record.attempts >= MAX_SEND_ATTEMPTS) {
    return { status: 'exhausted', mode: record.mode, text: record.text };
  }

  const result = await retryCoachSend(
    record.mode,
    record.text,
    record.attempts + 1
  );
  return { status: 'retried', mode: record.mode, text: record.text, result };
}
