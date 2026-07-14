import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  runToolLoop,
  callClaudeStructured,
  MODELS,
  type ClaudeResponse,
  type ClaudeMessage,
} from '../claude';
import { saveSettings } from '../storage';

/** Build a fetch Response-like object wrapping a parsed Claude response. */
function jsonResponse(obj: ClaudeResponse) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(obj),
    json: async () => obj,
  };
}

function baseResponse(partial: Partial<ClaudeResponse>): ClaudeResponse {
  return {
    id: 'msg_1',
    model: MODELS.coach,
    content: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 0, output_tokens: 0 },
    ...partial,
  };
}

let mockFetch: Mock;

beforeEach(async () => {
  localStorage.clear();
  // Web port: the API key is read from Settings storage, not process.env.
  await saveSettings({
    calorieTarget: 2000,
    proteinTarget: 150,
    name: '',
    anthropicApiKey: 'test-key',
  });
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

/** Parse the messages array sent on the Nth (0-based) fetch call. */
function messagesOnCall(call: number): ClaudeMessage[] {
  const body = JSON.parse(mockFetch.mock.calls[call][1].body);
  return body.messages as ClaudeMessage[];
}

describe('runToolLoop', () => {
  it('executes all tool_use blocks and returns one user message with all tool_results', async () => {
    // Turn 1: two parallel tool calls.
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        baseResponse({
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool_use', id: 't1', name: 'foo', input: { a: 1 } },
            { type: 'tool_use', id: 't2', name: 'bar', input: { b: 2 } },
          ],
        })
      )
    );
    // Turn 2: final answer.
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        baseResponse({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'done' }],
        })
      )
    );

    const calls: string[] = [];
    const result = await runToolLoop(
      {
        model: MODELS.coach,
        messages: [{ role: 'user', content: 'hello' }],
        thinking: { type: 'adaptive' },
      },
      {
        foo: (input) => {
          calls.push(`foo:${JSON.stringify(input)}`);
          return { content: 'RESA' };
        },
        bar: (input) => {
          calls.push(`bar:${JSON.stringify(input)}`);
          return { content: 'RESB' };
        },
      }
    );

    // Both handlers ran with their inputs.
    expect(calls).toEqual(['foo:{"a":1}', 'bar:{"b":2}']);
    expect(result.executions.map((e) => e.name)).toEqual(['foo', 'bar']);
    expect(result.truncated).toBe(false);

    // Second request's messages: original user + assistant tool_use turn +
    // ONE user message containing BOTH tool_result blocks.
    const secondMessages = messagesOnCall(1);
    expect(secondMessages).toHaveLength(3);
    expect(secondMessages[1].role).toBe('assistant');
    const userTurn = secondMessages[2];
    expect(userTurn.role).toBe('user');
    const resultBlocks = userTurn.content as Array<Record<string, unknown>>;
    expect(resultBlocks).toHaveLength(2);
    expect(resultBlocks.map((b) => b.tool_use_id)).toEqual(['t1', 't2']);
    expect(resultBlocks.map((b) => b.type)).toEqual([
      'tool_result',
      'tool_result',
    ]);
    expect(resultBlocks.map((b) => b.content)).toEqual(['RESA', 'RESB']);
  });

  it('re-sends on pause_turn with the assistant turn appended', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        baseResponse({
          stop_reason: 'pause_turn',
          content: [{ type: 'text', text: 'thinking…' }],
        })
      )
    );
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        baseResponse({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'resumed answer' }],
        })
      )
    );

    const result = await runToolLoop(
      { model: MODELS.coach, messages: [{ role: 'user', content: 'go' }] },
      {}
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The re-sent request carries the paused assistant turn.
    const secondMessages = messagesOnCall(1);
    expect(secondMessages).toHaveLength(2);
    expect(secondMessages[1].role).toBe('assistant');
    expect(result.response.stop_reason).toBe('end_turn');
  });

  it('marks the result truncated on max_tokens', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        baseResponse({
          stop_reason: 'max_tokens',
          content: [{ type: 'text', text: 'partial…' }],
        })
      )
    );
    const result = await runToolLoop(
      { model: MODELS.coach, messages: [{ role: 'user', content: 'go' }] },
      {}
    );
    expect(result.truncated).toBe(true);
  });
});

describe('callClaudeStructured', () => {
  it('sets json_schema format and parses the first text block', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        baseResponse({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"mealName":"Eggs","calories":220}' }],
        })
      )
    );

    const schema = {
      type: 'object',
      properties: {
        mealName: { type: 'string' },
        calories: { type: 'number' },
      },
      required: ['mealName', 'calories'],
      additionalProperties: false,
    };

    const parsed = await callClaudeStructured<{
      mealName: string;
      calories: number;
    }>(
      { model: MODELS.cheap, messages: [{ role: 'user', content: 'x' }] },
      schema
    );

    expect(parsed).toEqual({ mealName: 'Eggs', calories: 220 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema).toEqual(schema);
  });

  it('sends the browser-access header', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        baseResponse({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"mealName":"x","calories":1}' }],
        })
      )
    );
    await callClaudeStructured(
      { model: MODELS.cheap, messages: [{ role: 'user', content: 'x' }] },
      {
        type: 'object',
        properties: { mealName: { type: 'string' }, calories: { type: 'number' } },
        required: ['mealName', 'calories'],
        additionalProperties: false,
      }
    );
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });
});
