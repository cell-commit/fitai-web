import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import {
  callClaude,
  runToolLoop,
  ClaudeRequestError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  isTransientClaudeError,
  MODELS,
  type ClaudeResponse,
} from '../claude';
import { saveSettings } from '../storage';

function jsonResponse(obj: ClaudeResponse) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(obj),
    json: async () => obj,
  };
}

const OK_RESPONSE: ClaudeResponse = {
  id: 'msg_1',
  model: MODELS.coach,
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 0, output_tokens: 0 },
};

let mockFetch: Mock;

beforeEach(async () => {
  localStorage.clear();
  await saveSettings({
    calorieTarget: 2000,
    proteinTarget: 150,
    name: '',
    anthropicApiKey: 'test-key',
  });
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('callClaude — timeout', () => {
  it('aborts cleanly when the request never settles', async () => {
    vi.useFakeTimers();
    // A fetch that never resolves and ignores the signal — exactly what a
    // suspended page leaves behind.
    mockFetch.mockReturnValue(new Promise(() => {}));

    const promise = callClaude({
      model: MODELS.coach,
      messages: [{ role: 'user', content: 'hello' }],
      timeoutMs: 1000,
    }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1000);
    const err = await promise;

    expect(err).toBeInstanceOf(ClaudeRequestError);
    expect((err as ClaudeRequestError).kind).toBe('timeout');
    expect((err as Error).message).toMatch(/did not reply within 1s/);
    expect(isTransientClaudeError(err)).toBe(true);
  });

  it('does not fire before the timeout elapses', async () => {
    vi.useFakeTimers();
    mockFetch.mockReturnValue(new Promise(() => {}));

    let settled = false;
    void callClaude({
      model: MODELS.coach,
      messages: [{ role: 'user', content: 'hello' }],
      timeoutMs: 5000,
    }).catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('defaults to the generous 180s budget so existing call sites are unchanged', async () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(180_000);

    vi.useFakeTimers();
    mockFetch.mockReturnValue(new Promise(() => {}));

    let settled = false;
    void callClaude({
      model: MODELS.coach,
      messages: [{ role: 'user', content: 'hello' }],
    }).catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('leaves a successful call untouched and passes a signal to fetch', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(OK_RESPONSE));

    const res = await callClaude({
      model: MODELS.coach,
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(res.stop_reason).toBe('end_turn');
    const init = mockFetch.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });
});

describe('callClaude — caller abort', () => {
  it('rejects with an abort error when the caller aborts mid-flight', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();

    const promise = callClaude({
      model: MODELS.coach,
      messages: [{ role: 'user', content: 'hello' }],
      signal: controller.signal,
    }).catch((e: unknown) => e);

    // Let the key lookup + fetch kick off, then cancel.
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    const err = await promise;
    expect(err).toBeInstanceOf(ClaudeRequestError);
    expect((err as ClaudeRequestError).kind).toBe('abort');
  });

  it('rejects immediately when handed an already-aborted signal', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    controller.abort();

    await expect(
      callClaude({
        model: MODELS.coach,
        messages: [{ role: 'user', content: 'x' }],
        signal: controller.signal,
      })
    ).rejects.toBeInstanceOf(ClaudeRequestError);
  });

  it('forwards signal and timeout to every call in a tool loop', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        ...OK_RESPONSE,
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }],
      })
    );
    mockFetch.mockResolvedValueOnce(jsonResponse(OK_RESPONSE));

    const controller = new AbortController();
    await runToolLoop(
      {
        model: MODELS.coach,
        messages: [{ role: 'user', content: 'go' }],
        signal: controller.signal,
        timeoutMs: 60_000,
      },
      { noop: () => ({ content: 'ok' }) }
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const call of mockFetch.mock.calls) {
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
    // timeoutMs/signal must not leak into the request body.
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.timeoutMs).toBeUndefined();
    expect(body.signal).toBeUndefined();
  });
});

describe('failure classification', () => {
  it('treats a dropped connection as transient', async () => {
    // Safari's message when the page is suspended mid-request.
    mockFetch.mockRejectedValueOnce(new TypeError('Load failed'));

    const err = await callClaude({
      model: MODELS.coach,
      messages: [{ role: 'user', content: 'x' }],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClaudeRequestError);
    expect((err as ClaudeRequestError).kind).toBe('network');
    expect(isTransientClaudeError(err)).toBe(true);
  });

  it('keeps real API verdicts non-transient with their own message', async () => {
    for (const [status, pattern] of [
      [401, /Invalid API key/],
      [429, /Rate limit reached/],
      [400, /API error \(400\)/],
    ] as const) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status,
        text: async () => 'nope',
        json: async () => ({}),
      });
      const err = await callClaude({
        model: MODELS.coach,
        messages: [{ role: 'user', content: 'x' }],
      }).catch((e: unknown) => e);

      expect((err as Error).message).toMatch(pattern);
      expect(isTransientClaudeError(err)).toBe(false);
    }
  });

  it('does not classify a missing API key as transient', () => {
    expect(
      isTransientClaudeError(
        new Error('No API key configured. Add your Anthropic API key in Settings.')
      )
    ).toBe(false);
  });
});
