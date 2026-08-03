import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoachPane } from '../CoachPane';
import { resetSendRunningForTests } from '../../services/coachInflight';
import { appendChatMessage } from '../../services/storage';
import type { ChatMessage, ChatMode } from '../../types';

vi.mock('../../services/coach', () => ({
  sendCoachMessage: vi.fn(),
  CONTINUE_TEXT: 'Continue',
}));

const ctx = vi.hoisted(() => ({
  stale: false,
  status: {
    configured: true,
    hasStatusFile: true,
    ageMs: 120_000 as number | null,
    error: null as string | null,
  },
  refresh: { ok: true, error: null as string | null, changed: false },
}));

vi.mock('../../services/coachContext', () => ({
  isCoachContextStale: vi.fn(async () => ctx.stale),
  getCoachContextStatus: vi.fn(async () => ({ ...ctx.status })),
  refreshCoachContext: vi.fn(async () => ({ ...ctx.refresh })),
}));

const { sendCoachMessage } = await import('../../services/coach');
const send = sendCoachMessage as unknown as Mock;
const { refreshCoachContext, isCoachContextStale } = await import(
  '../../services/coachContext'
);
const refresh = refreshCoachContext as unknown as Mock;
const stale = isCoachContextStale as unknown as Mock;

let seq = 0;
function msg(
  role: 'user' | 'assistant',
  text: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id: `m${++seq}`,
    mode: 'coach' as ChatMode,
    role,
    text,
    timestamp: seq,
    ...extra,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetSendRunningForTests();
  send.mockReset();
  refresh.mockClear();
  stale.mockClear();
  ctx.stale = false;
  ctx.status = {
    configured: true,
    hasStatusFile: true,
    ageMs: 120_000,
    error: null,
  };
  ctx.refresh = { ok: true, error: null, changed: false };
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

// ── Auto-refresh on a stale cache ─────────────────────────────

describe('CoachPane — background context refresh', () => {
  it('refreshes on mount when the Drive cache is stale', async () => {
    ctx.stale = true;
    render(<CoachPane />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('does NOT refresh on mount when the cache is fresh', async () => {
    ctx.stale = false;
    render(<CoachPane />);
    await screen.findByText(/Training files/);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes when the page becomes visible again with a stale cache', async () => {
    ctx.stale = false;
    render(<CoachPane />);
    await screen.findByText(/Training files/);

    ctx.stale = true;
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('never refreshes while a send is in flight (prompt caching stays intact)', async () => {
    ctx.stale = true;
    // A send that never resolves — the pane stays in the 'sending' phase.
    send.mockImplementation(() => new Promise(() => {}));
    render(<CoachPane />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    await userEvent.type(
      screen.getByPlaceholderText('Message your coach…'),
      'plan my week'
    );
    await userEvent.click(screen.getByLabelText('Send message'));
    await screen.findByText(/Coach is thinking/);

    // Coming back to the foreground mid-reply must not re-pull the files: the
    // system blocks were assembled at the start of this send.
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('says so when a refresh actually picked up new file content', async () => {
    ctx.refresh = { ok: true, error: null, changed: true };
    render(<CoachPane />);
    await screen.findByText(/Training files/);

    await userEvent.click(screen.getByLabelText('Refresh training files'));

    expect(await screen.findByText('Training files updated')).toBeInTheDocument();
  });

  it('distinguishes "refreshed, nothing new" from a real update', async () => {
    ctx.refresh = { ok: true, error: null, changed: false };
    render(<CoachPane />);
    await screen.findByText(/Training files/);

    await userEvent.click(screen.getByLabelText('Refresh training files'));

    expect(await screen.findByText('Already up to date')).toBeInTheDocument();
  });
});

// ── The three status states ───────────────────────────────────

describe('CoachPane — training-files status', () => {
  it('sits at the BOTTOM, in the input bar, not at the top of the thread', async () => {
    render(<CoachPane />);
    const line = await screen.findByText(/Training files/);
    // Scrolling a long conversation to reach Refresh was the complaint.
    expect(line.closest('.chat__inputbar')).not.toBeNull();
    expect(
      screen.getByLabelText('Refresh training files').closest('.chat__inputbar')
    ).not.toBeNull();
  });

  it('reports how recently the files were pulled when connected', async () => {
    ctx.status = {
      configured: true,
      hasStatusFile: true,
      ageMs: 3 * 60_000,
      error: null,
    };
    render(<CoachPane />);
    expect(await screen.findByText('Training files · updated 3m ago')).toBeInTheDocument();
  });

  it('says plainly when the files could not be reached, and offers Retry', async () => {
    // The state that did not exist before: still answering, but from a copy the
    // app could not verify. It must not read like a successful refresh.
    ctx.status = {
      configured: true,
      hasStatusFile: true,
      ageMs: 5 * 60 * 60_000,
      error: 'The connection dropped',
    };
    render(<CoachPane />);

    expect(
      await screen.findByText(/Couldn’t reach your training files — using a copy from 5h ago/)
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Refresh training files')).toHaveTextContent('Retry');
    expect(screen.queryByText(/Training files · updated/)).toBeNull();
  });

  it('still reports the not-connected case', async () => {
    ctx.status = {
      configured: false,
      hasStatusFile: false,
      ageMs: null,
      error: null,
    };
    render(<CoachPane />);
    expect(await screen.findByText('No training files connected')).toBeInTheDocument();
  });
});

// ── Continue after a truncated reply ──────────────────────────

describe('CoachPane — truncated reply', () => {
  it('renders the partial text with a working Continue button', async () => {
    const partial = 'Monday — Push:\n- Bench 4x6\n- Incline DB press 3x10';
    await appendChatMessage(msg('user', 'plan my week'));
    await appendChatMessage(msg('assistant', partial, { truncated: true }));

    send.mockImplementation(async () => ({
      assistantText: '- Cable fly 3x12',
      toolEvents: [],
      truncated: false,
    }));

    render(<CoachPane />);

    // The generated text is still on screen — not replaced by an apology.
    expect(await screen.findByText(/Incline DB press 3x10/)).toBeInTheDocument();
    expect(screen.getByText('Cut off at the length limit.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // Sent as a continuation, with the partial turn passed through as history.
    const [, text, history, opts] = send.mock.calls[0];
    expect(text).toBe('Continue');
    expect(opts.continuation).toBe(true);
    expect(history[history.length - 1]).toMatchObject({
      role: 'assistant',
      truncated: true,
    });
  });

  it('offers Continue only on the newest turn', async () => {
    await appendChatMessage(msg('assistant', 'cut off earlier', { truncated: true }));
    await appendChatMessage(msg('user', 'never mind'));
    await appendChatMessage(msg('assistant', 'All good.'));

    render(<CoachPane />);
    await screen.findByText('All good.');

    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('shows no Continue affordance on an ordinary reply', async () => {
    await appendChatMessage(msg('user', 'hi'));
    await appendChatMessage(msg('assistant', 'Hello.'));

    render(<CoachPane />);
    await screen.findByText('Hello.');

    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.queryByText('Cut off at the length limit.')).toBeNull();
  });
});
