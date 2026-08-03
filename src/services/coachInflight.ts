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

import type { ChatAttachment, ChatMessage, ChatMode } from '../types';
import { isTransientClaudeError } from './claude';
import { sendCoachMessage } from './coach';
import { rehydrateAttachments } from './chatAttachments';
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

export interface SendFailed {
  status: 'failed';
  error: Error;
  transient: boolean;
  /** Ids of the turn that failed, so the UI can retry it exactly. */
  messageId?: string;
  attachmentIds?: string[];
}

export type SendOutcome = { status: 'ok' } | { status: 'busy' } | SendFailed;

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function makeMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Attachment options threaded through a send or a retry. */
export interface CoachSendOptions {
  attachments?: ChatAttachment[];
  /** Reuse an existing user-message id (a retry keeps the original turn's id). */
  messageId?: string;
  /**
   * This turn resumes a truncated reply. Recorded on the in-flight record so a
   * resume-retry re-sends it AS a continuation — replaying it as an ordinary
   * turn would make the model restart the answer it was meant to finish.
   */
  continuation?: boolean;
}

/**
 * Send a coach message with durability: the in-flight record is written before
 * the call and cleared on success. A non-transient failure (bad key, rate limit,
 * refusal) also clears it — those must not be retried automatically. A transient
 * failure keeps the record so the resume path can retry once.
 *
 * The user message's id is generated HERE, before the call, and handed to
 * sendCoachMessage. That is what lets the record identify the turn without
 * relying on its text (see hasAssistantReplyFor).
 */
export async function performCoachSend(
  mode: ChatMode,
  text: string,
  history: ChatMessage[],
  attempt = 1,
  opts: CoachSendOptions = {}
): Promise<SendOutcome> {
  if (running) return { status: 'busy' };
  running = true;
  const messageId = opts.messageId ?? makeMessageId();
  const attachments = opts.attachments ?? [];
  const attachmentIds = attachments.map((a) => a.id);
  const continuation = opts.continuation === true;
  await saveInflightSend({
    mode,
    text,
    startedAt: Date.now(),
    attempts: attempt,
    messageId,
    ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    ...(continuation ? { continuation: true } : {}),
  });
  try {
    await sendCoachMessage(mode, text, history, {
      attachments,
      messageId,
      ...(continuation ? { continuation: true } : {}),
    });
    await clearInflightSend();
    return { status: 'ok' };
  } catch (e) {
    const error = toError(e);
    const transient = isTransientClaudeError(error);
    if (!transient) await clearInflightSend();
    return {
      status: 'failed',
      error,
      transient,
      messageId,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    };
  } finally {
    running = false;
  }
}

/**
 * True when an assistant turn exists after the user turn we sent — i.e. the
 * request we thought died actually completed.
 *
 * Matching by id, not text: a photo-only message has EMPTY text, which would
 * match the wrong turn (or every other empty turn) and either skip a retry that
 * was needed or pay for one that was not. `messageId` is absent only on records
 * written by a previously-installed version, where the text comparison is still
 * the best available signal.
 */
export function hasAssistantReplyFor(
  thread: ChatMessage[],
  text: string,
  messageId?: string
): boolean {
  let lastUserIdx = -1;
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i];
    if (m.role !== 'user') continue;
    const hit = messageId ? m.id === messageId : m.text === text;
    if (hit) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return false;
  return thread.slice(lastUserIdx + 1).some((m) => m.role === 'assistant');
}

/**
 * Drop the trailing, unanswered user turn if it is the one we sent.
 * sendCoachMessage persists the user turn before calling the API, so an
 * interrupted send leaves an orphan at the end of the thread; re-sending would
 * otherwise duplicate it. Matched by id where available (legacy records fall
 * back to text) for the same reason as hasAssistantReplyFor.
 *
 * The message goes, the BLOBS STAY: the in-flight record still holds the
 * attachment ids and the retry rehydrates the images from them. Deleting them
 * here would turn a recoverable interruption into a silently photo-less retry.
 */
export function stripOrphanUserTurn(
  thread: ChatMessage[],
  text: string,
  messageId?: string
): ChatMessage[] {
  const last = thread[thread.length - 1];
  if (!last || last.role !== 'user') return thread;
  // Id first, then text — unlike hasAssistantReplyFor, the text fallback is safe
  // here because only the trailing, unanswered turn is ever a candidate. It is
  // suppressed for an empty text (a photo-only turn), which would otherwise
  // match any trailing photo-only message rather than specifically ours.
  const idHit = messageId !== undefined && last.id === messageId;
  const textHit = last.text === text && (text !== '' || messageId === undefined);
  return idHit || textHit ? thread.slice(0, -1) : thread;
}

export type RetryResult =
  | { status: 'ok' }
  | { status: 'busy' }
  | { status: 'already-complete' }
  | SendFailed;

/** What a retry needs to reproduce the original turn byte-for-byte. */
export interface RetryOptions {
  messageId?: string;
  /** Ids only — the images themselves are rehydrated from IndexedDB. */
  attachmentIds?: string[];
  /** Re-send as a continuation (see CoachSendOptions.continuation). */
  continuation?: boolean;
}

/**
 * Re-send an interrupted message. Skips the call entirely when the reply already
 * landed, rebuilds the thread so the retry does not duplicate the user turn, and
 * re-attaches the same images (rehydrated from the blobs the strip step kept).
 *
 * When the caller has no ids to hand (a plain "Retry" tap), the current in-flight
 * record for this mode supplies them.
 */
export async function retryCoachSend(
  mode: ChatMode,
  text: string,
  attempt: number,
  opts: RetryOptions = {}
): Promise<RetryResult> {
  if (running) return { status: 'busy' };

  let { messageId, attachmentIds, continuation } = opts;
  if (
    messageId === undefined ||
    attachmentIds === undefined ||
    continuation === undefined
  ) {
    const record = await getInflightSend();
    if (record && record.mode === mode) {
      messageId = messageId ?? record.messageId;
      attachmentIds = attachmentIds ?? record.attachmentIds;
      continuation = continuation ?? record.continuation;
    }
  }

  const thread = await getChatMessages(mode);
  if (hasAssistantReplyFor(thread, text, messageId)) {
    // The original request DID reach Claude — do not pay for it twice.
    await clearInflightSend();
    return { status: 'already-complete' };
  }

  const prior = stripOrphanUserTurn(thread, text, messageId);
  if (prior.length !== thread.length) {
    // Blobs are deliberately left in place — see stripOrphanUserTurn.
    await saveChatMessages(mode, prior);
  }

  const attachments =
    attachmentIds && attachmentIds.length > 0
      ? await rehydrateAttachments(attachmentIds)
      : [];
  return performCoachSend(mode, text, prior, attempt, {
    attachments,
    messageId,
    ...(continuation ? { continuation: true } : {}),
  });
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
  if (hasAssistantReplyFor(thread, record.text, record.messageId)) {
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
    record.attempts + 1,
    {
      messageId: record.messageId,
      attachmentIds: record.attachmentIds,
      continuation: record.continuation,
    }
  );
  return { status: 'retried', mode: record.mode, text: record.text, result };
}
