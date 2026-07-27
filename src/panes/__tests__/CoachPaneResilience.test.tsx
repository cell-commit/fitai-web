import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoachPane } from '../CoachPane';
import { ClaudeRequestError } from '../../services/claude';
import { resetSendRunningForTests } from '../../services/coachInflight';
import {
  appendChatMessage,
  getChatMessages,
  getInflightSend,
  saveInflightSend,
} from '../../services/storage';
import type { ChatMessage, ChatMode } from '../../types';

vi.mock('../../services/coach', () => ({ sendCoachMessage: vi.fn() }));
vi.mock('../../services/coachContext', () => ({
  refreshCoachContext: vi.fn(async () => {}),
  getCoachContextStatus: vi.fn(async () => ({
    configured: true,
    hasStatusFile: true,
  })),
}));

const { sendCoachMessage } = await import('../../services/coach');
const send = sendCoachMessage as unknown as Mock;

let seq = 0;
function msg(
  role: 'user' | 'assistant',
  text: string,
  mode: ChatMode = 'coach'
): ChatMessage {
  return { id: `m${++seq}`, mode, role, text, timestamp: seq };
}

/** Persists the user turn (as the real service does) then dies mid-reply. */
function interruptedSend() {
  return async (mode: ChatMode, text: string) => {
    await appendChatMessage(msg('user', text, mode));
    throw new ClaudeRequestError('network', 'Load failed');
  };
}

function successfulSend(reply: string) {
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
  resetSendRunningForTests();
  send.mockReset();
  // jsdom has no scrollIntoView; the pane scrolls to a bottom sentinel.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

async function typeAndSend(text: string) {
  await userEvent.type(screen.getByPlaceholderText('Message your coach…'), text);
  await userEvent.click(screen.getByLabelText('Send message'));
}

describe('CoachPane — interrupted reply', () => {
  it('shows an honest failed state on the user bubble instead of a bare error', async () => {
    send.mockImplementation(interruptedSend());
    render(<CoachPane />);

    await typeAndSend('drop RDLs');

    expect(
      await screen.findByText(/Reply interrupted — your phone may have slept/)
    ).toBeInTheDocument();
    // The user's text is still on screen and still persisted.
    expect(screen.getByText('drop RDLs')).toBeInTheDocument();
    expect((await getChatMessages('coach')).map((m) => m.text)).toEqual(['drop RDLs']);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('Retry re-sends the exact same message and does not duplicate it', async () => {
    send.mockImplementation(interruptedSend());
    render(<CoachPane />);
    await typeAndSend('drop RDLs');
    await screen.findByText(/Reply interrupted/);

    send.mockImplementation(successfulSend('Dropped them for this week.'));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Dropped them for this week.')).toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toBe('drop RDLs');
    // One user bubble, not two.
    expect(screen.getAllByText('drop RDLs')).toHaveLength(1);
    expect(screen.queryByText(/Reply interrupted/)).toBeNull();
    expect(await getInflightSend()).toBeNull();
  });

  it('Dismiss clears the notice and the in-flight record', async () => {
    send.mockImplementation(interruptedSend());
    render(<CoachPane />);
    await typeAndSend('drop RDLs');
    await screen.findByText(/Reply interrupted/);
    expect(await getInflightSend()).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(async () => expect(await getInflightSend()).toBeNull());
    expect(screen.queryByText(/Reply interrupted/)).toBeNull();
    // The message itself is kept.
    expect(screen.getByText('drop RDLs')).toBeInTheDocument();
  });

  it('keeps a real API error message and does not blame the phone', async () => {
    send.mockRejectedValue(
      new Error('Rate limit reached. Please wait a moment and try again.')
    );
    render(<CoachPane />);

    await typeAndSend('hello');

    expect(
      await screen.findByText(/Rate limit reached\. Please wait a moment/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/may have slept/)).toBeNull();
    // Non-transient: nothing is left behind to auto-retry.
    expect(await getInflightSend()).toBeNull();
  });
});

describe('CoachPane — waiting feedback', () => {
  it('shows elapsed-time feedback while the coach is thinking', async () => {
    let release: () => void = () => {};
    send.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(undefined)))
    );
    render(<CoachPane />);

    await typeAndSend('long question');

    expect(await screen.findByText(/Coach is thinking… \d+s/)).toBeInTheDocument();
    release();
  });
});

describe('CoachPane — resume after suspension', () => {
  it('auto-retries once on mount when a send was interrupted', async () => {
    // What an iOS suspension leaves behind: the user turn and the record.
    await appendChatMessage(msg('user', 'drop RDLs'));
    await saveInflightSend({
      mode: 'coach',
      text: 'drop RDLs',
      startedAt: Date.now() - 45_000,
      attempts: 1,
    });
    send.mockImplementation(successfulSend('Dropped them.'));

    render(<CoachPane />);

    expect(await screen.findByText('Dropped them.')).toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('drop RDLs')).toHaveLength(1);
    expect(await getInflightSend()).toBeNull();
  });

  it('skips the retry when the reply already landed before the page resumed', async () => {
    await appendChatMessage(msg('user', 'drop RDLs'));
    await appendChatMessage(msg('assistant', 'Already answered.'));
    await saveInflightSend({
      mode: 'coach',
      text: 'drop RDLs',
      startedAt: Date.now() - 45_000,
      attempts: 1,
    });

    render(<CoachPane />);

    expect(await screen.findByText('Already answered.')).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
    await waitFor(async () => expect(await getInflightSend()).toBeNull());
  });

  it('falls back to the recoverable failed state when the retry budget is spent', async () => {
    await appendChatMessage(msg('user', 'drop RDLs'));
    await saveInflightSend({
      mode: 'coach',
      text: 'drop RDLs',
      startedAt: Date.now() - 45_000,
      attempts: 2,
    });

    render(<CoachPane />);

    expect(await screen.findByText(/Reply interrupted/)).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('retries when the page becomes visible again', async () => {
    render(<CoachPane />);
    await screen.findByText('Talk to your coach');

    await appendChatMessage(msg('user', 'why so sore'));
    await saveInflightSend({
      mode: 'coach',
      text: 'why so sore',
      startedAt: Date.now() - 45_000,
      attempts: 1,
    });
    send.mockImplementation(successfulSend('Deload week.'));

    document.dispatchEvent(new Event('visibilitychange'));

    expect(await screen.findByText('Deload week.')).toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
