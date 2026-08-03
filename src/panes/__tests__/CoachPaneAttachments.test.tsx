import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoachPane } from '../CoachPane';
import { resetSendRunningForTests } from '../../services/coachInflight';
import { __setImageOps, type ResizeFn } from '../../utils/imageOps';
import { appendChatMessage, getChatMessages } from '../../services/storage';
import type { ChatMessage, ChatMode } from '../../types';

// ── Mocks ─────────────────────────────────────────────────────

const blobs = vi.hoisted(() => ({ map: new Map<string, Blob>() }));

vi.mock('../../services/blobStore', () => ({
  put: vi.fn(async (key: string, blob: Blob) => {
    blobs.map.set(key, blob);
  }),
  get: vi.fn(async (key: string) => blobs.map.get(key) ?? null),
  del: vi.fn(async (key: string) => {
    blobs.map.delete(key);
  }),
  list: vi.fn(async () => Array.from(blobs.map.keys())),
}));

vi.mock('../../services/coach', () => ({
  sendCoachMessage: vi.fn(),
  CONTINUE_TEXT: 'Continue',
}));
vi.mock('../../services/coachContext', () => ({
  refreshCoachContext: vi.fn(async () => ({
    ok: true,
    error: null,
    changed: false,
  })),
  getCoachContextStatus: vi.fn(async () => ({
    configured: true,
    hasStatusFile: true,
    ageMs: 1000,
    error: null,
  })),
  isCoachContextStale: vi.fn(async () => false),
}));

const { sendCoachMessage } = await import('../../services/coach');
const send = sendCoachMessage as unknown as Mock;

/** No canvas in jsdom — echo the bytes back as a JPEG blob. */
const echoResize: ResizeFn = async (input) =>
  new Blob([await input.arrayBuffer()], { type: 'image/jpeg' });

function jpegFile(name = 'form.jpg'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
}

let seq = 0;
function msg(role: 'user' | 'assistant', text: string, mode: ChatMode = 'coach'): ChatMessage {
  return { id: `m${++seq}`, mode, role, text, timestamp: seq };
}

function successfulSend(reply: string) {
  return async (
    mode: ChatMode,
    text: string,
    _history: ChatMessage[],
    opts?: { attachments?: ChatMessage['attachments']; messageId?: string }
  ) => {
    await appendChatMessage({
      ...msg('user', text, mode),
      ...(opts?.messageId ? { id: opts.messageId } : {}),
      ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
    });
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
  __setImageOps({ resize: echoResize });
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  __setImageOps({});
});

function fileInput(): HTMLInputElement {
  return screen.getByTestId('chat-file-input') as HTMLInputElement;
}

describe('CoachPane — photo attachments', () => {
  it('attaches a photo, shows a removable chip, and clears it on send', async () => {
    send.mockImplementation(successfulSend('Elbows are flaring.'));
    render(<CoachPane />);
    await screen.findByText('Talk to your coach');

    await userEvent.upload(fileInput(), jpegFile());

    // The chip renders from the stored blob.
    const chip = await screen.findByAltText('Attached photo');
    expect(chip).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove photo' })).toBeInTheDocument();
    expect(blobs.map.size).toBe(1);

    await userEvent.type(
      screen.getByPlaceholderText('Message your coach…'),
      'how is my bench'
    );
    await userEvent.click(screen.getByLabelText('Send message'));

    expect(await screen.findByText('Elbows are flaring.')).toBeInTheDocument();
    // The composer chip is gone; the blob is not — the sent bubble shows it.
    expect(screen.queryByRole('button', { name: 'Remove photo' })).toBeNull();
    expect(blobs.map.size).toBe(1);

    const opts = send.mock.calls[0][3];
    expect(opts.attachments).toHaveLength(1);
    expect(opts.attachments[0].blobKey).toMatch(/^chat\//);
    const thread = await getChatMessages('coach');
    expect(thread[0].attachments).toHaveLength(1);
  });

  it('allows a photo-only send (no text) and enables the send button for it', async () => {
    send.mockImplementation(successfulSend('Looking leaner.'));
    render(<CoachPane />);
    await screen.findByText('Talk to your coach');

    const sendBtn = screen.getByLabelText('Send message');
    expect(sendBtn).toBeDisabled();

    await userEvent.upload(fileInput(), jpegFile());
    await screen.findByAltText('Attached photo');
    expect(sendBtn).toBeEnabled();

    await userEvent.click(sendBtn);

    expect(await screen.findByText('Looking leaner.')).toBeInTheDocument();
    expect(send.mock.calls[0][1]).toBe(''); // no text — the images are the message
    expect(send.mock.calls[0][3].attachments).toHaveLength(1);
  });

  it('removing a chip deletes its blob and re-disables an empty send', async () => {
    render(<CoachPane />);
    await screen.findByText('Talk to your coach');

    await userEvent.upload(fileInput(), jpegFile());
    await screen.findByAltText('Attached photo');

    await userEvent.click(screen.getByRole('button', { name: 'Remove photo' }));

    await waitFor(() => expect(blobs.map.size).toBe(0));
    expect(screen.queryByAltText('Attached photo')).toBeNull();
    expect(screen.getByLabelText('Send message')).toBeDisabled();
    expect(send).not.toHaveBeenCalled();
  });

  it('renders thumbnails on a stored user bubble and opens the viewer on tap', async () => {
    await appendChatMessage({
      id: 'u1',
      mode: 'coach',
      role: 'user',
      text: '',
      timestamp: 1,
      attachments: [{ id: 'a1', blobKey: 'chat/a1', mediaType: 'image/jpeg' }],
    });
    blobs.map.set('chat/a1', new Blob([new Uint8Array([1])], { type: 'image/jpeg' }));

    render(<CoachPane />);

    const thumb = await screen.findByAltText('Attached photo');
    await userEvent.click(thumb);

    expect(await screen.findByRole('dialog', { name: 'Photo' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('dialog', { name: 'Photo' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Photo' })).toBeNull()
    );
  });

  it('prunes blobs left behind by messages the 200-cap evicted', async () => {
    // No message references this blob any more.
    blobs.map.set('chat/orphan', new Blob(['x'], { type: 'image/jpeg' }));
    blobs.map.set('photo/keepme', new Blob(['x'], { type: 'image/jpeg' }));

    render(<CoachPane />);
    await screen.findByText('Talk to your coach');

    await waitFor(() => expect(blobs.map.has('chat/orphan')).toBe(false));
    expect(blobs.map.has('photo/keepme')).toBe(true); // progress photos untouched
  });
});
