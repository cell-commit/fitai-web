import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  MAX_SEND_ATTEMPTS,
  hasAssistantReplyFor,
  performCoachSend,
  resetSendRunningForTests,
  resumeInflightSend,
  retryCoachSend,
  stripOrphanUserTurn,
} from '../coachInflight';
import { ClaudeRequestError } from '../claude';
import {
  appendChatMessage,
  getChatMessages,
  getInflightSend,
  saveInflightSend,
} from '../storage';
import type { ChatMessage, ChatMode } from '../../types';

// The blob store backs attachment rehydration on retry.
const blobs = vi.hoisted(() => ({ map: new Map<string, Blob>() }));

vi.mock('../blobStore', () => ({
  put: vi.fn(async (key: string, blob: Blob) => {
    blobs.map.set(key, blob);
  }),
  get: vi.fn(async (key: string) => blobs.map.get(key) ?? null),
  del: vi.fn(async (key: string) => {
    blobs.map.delete(key);
  }),
  list: vi.fn(async () => Array.from(blobs.map.keys())),
}));

vi.mock('../coach', () => ({ sendCoachMessage: vi.fn() }));
const { sendCoachMessage } = await import('../coach');
const send = sendCoachMessage as unknown as Mock;

let seq = 0;
function msg(
  role: 'user' | 'assistant',
  text: string,
  mode: ChatMode = 'coach'
): ChatMessage {
  return { id: `m${++seq}`, mode, role, text, timestamp: seq };
}

/** A send that persists the user turn (like the real one) then dies mid-reply. */
function interruptedSend() {
  return async (mode: ChatMode, text: string) => {
    await appendChatMessage(msg('user', text, mode));
    throw new ClaudeRequestError('network', 'The connection dropped before the coach replied.');
  };
}

/** A send that persists both turns and succeeds. */
function successfulSend(reply = 'Here you go') {
  return async (mode: ChatMode, text: string) => {
    await appendChatMessage(msg('user', text, mode));
    await appendChatMessage(msg('assistant', reply, mode));
    return {
      assistantText: reply,
      toolEvents: [],
      userMessage: msg('user', text, mode),
      assistantMessage: msg('assistant', reply, mode),
    };
  };
}

beforeEach(() => {
  localStorage.clear();
  blobs.map.clear();
  resetSendRunningForTests();
  send.mockReset();
});

describe('performCoachSend — in-flight persistence', () => {
  it('writes the record before the call and clears it on success', async () => {
    let recordDuringCall: unknown = null;
    send.mockImplementation(async (mode: ChatMode, text: string) => {
      recordDuringCall = await getInflightSend();
      return successfulSend()(mode, text);
    });

    const outcome = await performCoachSend('coach', 'how is my week', []);

    expect(outcome).toEqual({ status: 'ok' });
    expect(recordDuringCall).toMatchObject({
      mode: 'coach',
      text: 'how is my week',
      attempts: 1,
    });
    expect(await getInflightSend()).toBeNull();
  });

  it('keeps the record after a transient failure so a resume can retry', async () => {
    send.mockImplementation(interruptedSend());

    const outcome = await performCoachSend('coach', 'drop RDLs', []);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.transient).toBe(true);
    expect(await getInflightSend()).toMatchObject({ text: 'drop RDLs', attempts: 1 });
    // The user's text is never lost — it is already in the thread.
    expect((await getChatMessages('coach')).map((m) => m.text)).toEqual(['drop RDLs']);
  });

  it('clears the record on a real API error so nothing auto-retries', async () => {
    send.mockRejectedValue(
      new Error('Invalid API key. Check the Anthropic API key in Settings.')
    );

    const outcome = await performCoachSend('coach', 'hello', []);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.transient).toBe(false);
    expect(await getInflightSend()).toBeNull();
  });

  it('refuses to start a second send while one is running (double-send guard)', async () => {
    let release: () => void = () => {};
    send.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(undefined)))
    );

    const first = performCoachSend('coach', 'one', []);
    await Promise.resolve();

    expect(await performCoachSend('coach', 'one', [])).toEqual({ status: 'busy' });
    expect(await resumeInflightSend()).toEqual({ status: 'busy' });
    expect(send).toHaveBeenCalledTimes(1);

    release();
    await first;
  });
});

describe('resumeInflightSend — suspended mid-flight', () => {
  it('retries exactly once and does not duplicate the user turn', async () => {
    // Simulate the interrupted send: user turn persisted, no reply, record left.
    await appendChatMessage(msg('user', 'drop RDLs'));
    await saveInflightSend({
      mode: 'coach',
      text: 'drop RDLs',
      startedAt: Date.now() - 60_000,
      attempts: 1,
    });
    send.mockImplementation(successfulSend('Dropped them.'));

    const outcome = await resumeInflightSend();

    expect(outcome.status).toBe('retried');
    expect(outcome.status === 'retried' && outcome.result.status).toBe('ok');
    expect(send).toHaveBeenCalledTimes(1);
    // The retry was handed the thread WITHOUT the orphan user turn.
    expect(send.mock.calls[0][2]).toEqual([]);
    // Exactly one user turn survives, followed by the reply.
    const thread = await getChatMessages('coach');
    expect(thread.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:drop RDLs',
      'assistant:Dropped them.',
    ]);
    expect(await getInflightSend()).toBeNull();
  });

  it('SKIPS the retry when an assistant reply for that message already landed', async () => {
    // The original request did reach Claude before the page was suspended.
    await appendChatMessage(msg('user', 'drop RDLs'));
    await appendChatMessage(msg('assistant', 'Done — RDLs are out.'));
    await saveInflightSend({
      mode: 'coach',
      text: 'drop RDLs',
      startedAt: Date.now() - 60_000,
      attempts: 1,
    });

    const outcome = await resumeInflightSend();

    expect(outcome).toEqual({
      status: 'already-complete',
      mode: 'coach',
      text: 'drop RDLs',
    });
    // No second API call — that would cost money and could re-apply a change.
    expect(send).not.toHaveBeenCalled();
    expect(await getInflightSend()).toBeNull();
    expect(await getChatMessages('coach')).toHaveLength(2);
  });

  it('reports exhausted once the single retry is spent', async () => {
    await appendChatMessage(msg('user', 'drop RDLs'));
    await saveInflightSend({
      mode: 'coach',
      text: 'drop RDLs',
      startedAt: Date.now(),
      attempts: MAX_SEND_ATTEMPTS,
    });

    const outcome = await resumeInflightSend();

    expect(outcome).toEqual({
      status: 'exhausted',
      mode: 'coach',
      text: 'drop RDLs',
    });
    expect(send).not.toHaveBeenCalled();
    // The record stays until the user retries or dismisses.
    expect(await getInflightSend()).not.toBeNull();
  });

  it('does nothing when no send was in flight', async () => {
    expect(await resumeInflightSend()).toEqual({ status: 'none' });
    expect(send).not.toHaveBeenCalled();
  });

  it('bumps the attempt count on the retry record', async () => {
    await appendChatMessage(msg('user', 'hi'));
    await saveInflightSend({
      mode: 'coach',
      text: 'hi',
      startedAt: Date.now(),
      attempts: 1,
    });
    let attemptsDuringRetry = 0;
    send.mockImplementation(async () => {
      attemptsDuringRetry = (await getInflightSend())?.attempts ?? 0;
      throw new ClaudeRequestError('network', 'dropped again');
    });

    await resumeInflightSend();

    expect(attemptsDuringRetry).toBe(2);
    // A second resume no longer retries — one automatic retry only.
    const again = await resumeInflightSend();
    expect(again.status).toBe('exhausted');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries the nutrition thread when that is where the send died', async () => {
    await appendChatMessage(msg('user', 'what should I eat', 'nutrition'));
    await saveInflightSend({
      mode: 'nutrition',
      text: 'what should I eat',
      startedAt: Date.now(),
      attempts: 1,
    });
    send.mockImplementation(successfulSend('Eggs.'));

    const outcome = await resumeInflightSend();

    expect(outcome.status).toBe('retried');
    expect(send.mock.calls[0][0]).toBe('nutrition');
    expect(await getChatMessages('nutrition')).toHaveLength(2);
  });
});

describe('retryCoachSend', () => {
  it('re-sends the exact same text', async () => {
    await appendChatMessage(msg('user', 'exact text'));
    send.mockImplementation(successfulSend());

    const result = await retryCoachSend('coach', 'exact text', 2);

    expect(result).toEqual({ status: 'ok' });
    expect(send.mock.calls[0][1]).toBe('exact text');
  });
});

describe('thread helpers', () => {
  it('detects an assistant reply only after the matching user turn', () => {
    const thread = [
      msg('user', 'older'),
      msg('assistant', 'answer to older'),
      msg('user', 'newest'),
    ];
    expect(hasAssistantReplyFor(thread, 'older')).toBe(true);
    expect(hasAssistantReplyFor(thread, 'newest')).toBe(false);
    expect(hasAssistantReplyFor(thread, 'never sent')).toBe(false);
  });

  it('strips only a trailing unanswered user turn', () => {
    const answered = [msg('user', 'a'), msg('assistant', 'b')];
    expect(stripOrphanUserTurn(answered, 'a')).toHaveLength(2);

    const orphaned = [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')];
    expect(stripOrphanUserTurn(orphaned, 'c')).toHaveLength(2);
    expect(stripOrphanUserTurn(orphaned, 'a')).toHaveLength(3);
  });
});

// ── Photo attachments on an interrupted send ──────────────────

/** Put an already-resized attachment blob in the store, as attach time would. */
function storeAttachment(id: string): void {
  blobs.map.set(`chat/${id}`, new Blob([new Uint8Array([7, 7])], {
    type: 'image/jpeg',
  }));
}

/** A user turn carrying attachments, persisted by the send before it died. */
function photoMsg(id: string, text: string, attIds: string[]): ChatMessage {
  return {
    id,
    mode: 'coach',
    role: 'user',
    text,
    timestamp: ++seq,
    attachments: attIds.map((a) => ({
      id: a,
      blobKey: `chat/${a}`,
      mediaType: 'image/jpeg',
    })),
  };
}

describe('attachments survive an interrupted send', () => {
  it('records the attachment ids and the message id when the send starts', async () => {
    storeAttachment('a1');
    send.mockImplementation(interruptedSend());

    const outcome = await performCoachSend('coach', 'form check', [], 1, {
      attachments: [{ id: 'a1', blobKey: 'chat/a1', mediaType: 'image/jpeg' }],
    });

    expect(outcome.status).toBe('failed');
    const record = await getInflightSend();
    expect(record?.attachmentIds).toEqual(['a1']);
    expect(record?.messageId).toBeTruthy();
    // The id on the record is the id the send used for the user turn.
    expect(send.mock.calls[0][3].messageId).toBe(record?.messageId);
  });

  it('re-attaches the SAME images on retry, and keeps the blobs while doing it', async () => {
    storeAttachment('a1');
    storeAttachment('a2');
    // What the interruption left behind: the user turn and the record.
    await appendChatMessage(photoMsg('u1', 'form check', ['a1', 'a2']));
    await saveInflightSend({
      mode: 'coach',
      text: 'form check',
      startedAt: Date.now() - 60_000,
      attempts: 1,
      messageId: 'u1',
      attachmentIds: ['a1', 'a2'],
    });
    send.mockImplementation(successfulSend('Elbows are flaring.'));

    const outcome = await resumeInflightSend();

    expect(outcome.status).toBe('retried');
    // Same two images, in order, rehydrated from IndexedDB — not re-encoded.
    const opts = send.mock.calls[0][3];
    expect(opts.attachments.map((a: { id: string }) => a.id)).toEqual(['a1', 'a2']);
    expect(opts.attachments[0].blobKey).toBe('chat/a1');
    expect(opts.messageId).toBe('u1');
    // stripOrphanUserTurn dropped the message but NOT the blobs.
    expect(blobs.map.has('chat/a1')).toBe(true);
    expect(blobs.map.has('chat/a2')).toBe(true);
    // The orphan was not duplicated.
    expect(send.mock.calls[0][2]).toEqual([]);
  });

  it('drops an attachment whose blob has been evicted rather than failing', async () => {
    storeAttachment('a1'); // a2 is gone
    await appendChatMessage(photoMsg('u1', 'form check', ['a1', 'a2']));
    await saveInflightSend({
      mode: 'coach',
      text: 'form check',
      startedAt: Date.now(),
      attempts: 1,
      messageId: 'u1',
      attachmentIds: ['a1', 'a2'],
    });
    send.mockImplementation(successfulSend('ok'));

    await resumeInflightSend();

    expect(send.mock.calls[0][3].attachments.map((a: { id: string }) => a.id)).toEqual([
      'a1',
    ]);
  });

  it('matches by id, so a photo-only send is not mistaken for one already answered', async () => {
    // An EARLIER photo-only turn (empty text) that did get a reply…
    await appendChatMessage(photoMsg('u1', '', ['a1']));
    await appendChatMessage(msg('assistant', 'Looking leaner.'));
    // …and a new photo-only send that died before its turn was even persisted.
    storeAttachment('a2');
    await saveInflightSend({
      mode: 'coach',
      text: '',
      startedAt: Date.now(),
      attempts: 1,
      messageId: 'u2',
      attachmentIds: ['a2'],
    });
    send.mockImplementation(successfulSend('And now?'));

    const outcome = await resumeInflightSend();

    // Matching on the empty text would have found u1's reply and dropped this
    // message silently. Matching on the id retries it.
    expect(outcome.status).toBe('retried');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][3].attachments).toHaveLength(1);
  });

  it('still resumes a legacy record written with no messageId', async () => {
    // Written by the previously-installed version: text only, no ids.
    await appendChatMessage(msg('user', 'drop RDLs'));
    await saveInflightSend({
      mode: 'coach',
      text: 'drop RDLs',
      startedAt: Date.now() - 60_000,
      attempts: 1,
    });
    send.mockImplementation(successfulSend('Dropped them.'));

    const outcome = await resumeInflightSend();

    expect(outcome.status).toBe('retried');
    expect(send.mock.calls[0][1]).toBe('drop RDLs');
    expect(send.mock.calls[0][3].attachments).toEqual([]);
    // Text fallback still strips the orphan → one user turn, one reply.
    expect((await getChatMessages('coach')).map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('skips the retry when a legacy record already has its reply (text fallback)', async () => {
    await appendChatMessage(msg('user', 'drop RDLs'));
    await appendChatMessage(msg('assistant', 'Done.'));
    await saveInflightSend({
      mode: 'coach',
      text: 'drop RDLs',
      startedAt: Date.now(),
      attempts: 1,
    });

    expect((await resumeInflightSend()).status).toBe('already-complete');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('thread helpers — id matching', () => {
  it('hasAssistantReplyFor uses the id when one is given', () => {
    const thread = [photoMsg('u1', '', ['a1']), msg('assistant', 'nice')];
    expect(hasAssistantReplyFor(thread, '', 'u1')).toBe(true);
    expect(hasAssistantReplyFor(thread, '', 'u2')).toBe(false);
    // Legacy (no id) falls back to the text.
    expect(hasAssistantReplyFor(thread, '')).toBe(true);
  });

  it('stripOrphanUserTurn drops the turn by id and never touches blobs', () => {
    storeAttachment('a1');
    const thread = [msg('assistant', 'earlier'), photoMsg('u9', '', ['a1'])];

    expect(stripOrphanUserTurn(thread, '', 'u9')).toHaveLength(1);
    expect(stripOrphanUserTurn(thread, '', 'other')).toHaveLength(2);
    expect(blobs.map.has('chat/a1')).toBe(true);
  });
});
