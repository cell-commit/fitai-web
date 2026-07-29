import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { REPLAY_ATTACHMENT_TURNS, sendCoachMessage } from '../coach';
import {
  saveSettings,
  saveWeeklyProgram,
  getWeeklyProgram,
  getPendingProgram,
  getChatMessages,
} from '../storage';
import { getWeekStart } from '../../utils/date';
import { weekDates } from '../program';
import type { ClaudeResponse, ClaudeContentBlock } from '../claude';
import type {
  ChatAttachment,
  ChatMessage,
  WeeklyProgram,
  DayFocus,
} from '../../types';

// ── Mock the IndexedDB blob store (chat attachments read through it) ──

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

/** Store a fake already-resized attachment blob and return its metadata. */
function attachment(id: string): ChatAttachment {
  blobs.map.set(`chat/${id}`, new Blob([new Uint8Array([9, 9, 9])], {
    type: 'image/jpeg',
  }));
  return { id, blobKey: `chat/${id}`, mediaType: 'image/jpeg' };
}

// ── Mock driveSync (stateful cache + captured writes) ─────────

const drive = vi.hoisted(() => ({
  cache: new Map<string, { content: string; modifiedTime: string }>(),
  writes: [] as Array<{
    file: string;
    op: string;
    content: string;
    baseModifiedTime?: string;
  }>,
}));

vi.mock('../driveSync', () => ({
  getCached: vi.fn(async (name: string) => {
    const e = drive.cache.get(name);
    return e
      ? { name, content: e.content, modifiedTime: e.modifiedTime, fetchedAt: 0 }
      : null;
  }),
  setCachedContent: vi.fn(async (name: string, content: string) => {
    const e = drive.cache.get(name);
    drive.cache.set(name, {
      content,
      modifiedTime: e?.modifiedTime ?? '2026-07-01T00:00:00.000Z',
    });
  }),
  fetchFile: vi.fn(async (name: string) => {
    const e = drive.cache.get(name);
    if (!e) throw new Error('not found');
    return { name, content: e.content, modifiedTime: e.modifiedTime, fetchedAt: 0 };
  }),
  queueWrite: vi.fn(async (w: (typeof drive.writes)[number]) => {
    drive.writes.push(w);
  }),
  isConfigured: vi.fn(async () => true),
  refreshAll: vi.fn(async () => {}),
}));

// ── Claude API response builders ──────────────────────────────

function textResponse(text: string): ClaudeResponse {
  return {
    id: 'msg',
    model: 'claude-opus-4-8',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function toolUseResponse(
  name: string,
  input: Record<string, unknown>,
  id = 'tool_1'
): ClaudeResponse {
  return {
    id: 'msg',
    model: 'claude-opus-4-8',
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function fetchReturning(obj: ClaudeResponse) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(obj),
    json: async () => obj,
  };
}

// ── Program fixtures (staple names resolve locally, no Haiku fetch) ──

const WEEK_START = getWeekStart('2026-07-13');
const DATES = weekDates(WEEK_START);

function modelDay(date: string, focus: DayFocus, title: string, names: string[]) {
  return {
    date,
    focus,
    title,
    coachNotes: null,
    exercises: names.map((name) => ({
      name,
      sets: 3,
      repRange: '10-12',
      targetWeight: null,
      notes: null,
    })),
  };
}

function modelWeek(mondayNames: string[]) {
  return {
    weekStart: WEEK_START,
    rationale: 'Adjusted per feedback.',
    days: [
      modelDay(DATES[0], 'push', 'Push', mondayNames),
      modelDay(DATES[1], 'rest', 'Rest', []),
      modelDay(DATES[2], 'pull', 'Pull', ['Romanian Deadlift', 'Face Pull']),
      modelDay(DATES[3], 'cardio', 'Zone 2', []),
      modelDay(DATES[4], 'fullbody', 'Full Body', ['Barbell Bench Press', 'Ab Wheel']),
      modelDay(DATES[5], 'rest', 'Rest', []),
      modelDay(DATES[6], 'cardio', 'Cardio', []),
    ],
  };
}

let mockFetch: Mock;

beforeEach(async () => {
  localStorage.clear();
  drive.cache.clear();
  drive.writes.length = 0;
  blobs.map.clear();
  await saveSettings({
    calorieTarget: 2000,
    proteinTarget: 150,
    name: 'Jason',
    anthropicApiKey: 'test-key',
  });
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

// ── edit_training_status ──────────────────────────────────────

describe('edit_training_status', () => {
  it('applies an exact-match edit → queued write + tool event', async () => {
    drive.cache.set('training-status.md', {
      content: '# Status\n\nLower back: fine.\n',
      modifiedTime: '2026-07-10T00:00:00.000Z',
    });

    mockFetch
      .mockResolvedValueOnce(
        fetchReturning(
          toolUseResponse('edit_training_status', {
            old_str: 'Lower back: fine.',
            new_str: 'Lower back: a little tight — easing off RDLs.',
          })
        )
      )
      .mockResolvedValueOnce(fetchReturning(textResponse('Done — noted and adjusted.')));

    const res = await sendCoachMessage('coach', 'my lower back is a bit tight', []);

    expect(res.assistantText).toBe('Done — noted and adjusted.');
    expect(res.toolEvents).toEqual([
      { tool: 'edit_training_status', summary: 'Edited training status' },
    ]);

    // A single write was queued with the new content + the cached baseModifiedTime.
    expect(drive.writes).toHaveLength(1);
    expect(drive.writes[0]).toMatchObject({
      file: 'training-status.md',
      op: 'write',
      baseModifiedTime: '2026-07-10T00:00:00.000Z',
    });
    expect(drive.writes[0].content).toContain('a little tight');

    // The optimistic cache update landed too.
    expect(drive.cache.get('training-status.md')?.content).toContain('a little tight');
  });

  it('returns an is_error tool_result on a non-matching old_str and still finishes', async () => {
    drive.cache.set('training-status.md', {
      content: '# Status\n\nLower back: fine.\n',
      modifiedTime: '2026-07-10T00:00:00.000Z',
    });

    mockFetch
      .mockResolvedValueOnce(
        fetchReturning(
          toolUseResponse('edit_training_status', {
            old_str: 'this text is not in the file',
            new_str: 'whatever',
          })
        )
      )
      .mockResolvedValueOnce(
        fetchReturning(textResponse('I could not find that line — could you clarify?'))
      );

    const res = await sendCoachMessage('coach', 'update my status', []);

    expect(res.assistantText).toMatch(/could not find that line/i);
    expect(res.toolEvents).toEqual([]); // no chip for a failed edit
    expect(drive.writes).toHaveLength(0); // nothing queued

    // The second API call carried an is_error tool_result back to the model.
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const lastMsg = secondBody.messages[secondBody.messages.length - 1];
    const toolResult = (lastMsg.content as ClaudeContentBlock[]).find(
      (b) => b.type === 'tool_result'
    );
    expect(toolResult?.is_error).toBe(true);
  });
});

// ── update_weekly_program → stages a pending proposal ─────────

function verdictResponse(): ClaudeResponse {
  return textResponse(
    JSON.stringify({ approved: true, summary: 'Sensible week.', concerns: [] })
  );
}

describe('update_weekly_program', () => {
  it('STAGES the change for approval and does NOT modify the active weekly program', async () => {
    const current: WeeklyProgram = {
      weekStart: WEEK_START,
      generatedAt: 0,
      revision: 1,
      days: [
        {
          date: DATES[0],
          focus: 'push',
          title: 'Push',
          status: 'done',
          exercises: [
            { name: 'Leg Press', sets: 3, repRange: '10-12', slug: 'Leg_Press' },
            { name: 'Hip Thrust', sets: 3, repRange: '10-12' },
          ],
        },
      ],
    };
    await saveWeeklyProgram(current);

    mockFetch
      // 1. coach calls the tool
      .mockResolvedValueOnce(
        fetchReturning(
          toolUseResponse('update_weekly_program', { week: modelWeek(['Barbell Bench Press']) })
        )
      )
      // 2. independent safety review (inside the tool handler)
      .mockResolvedValueOnce(fetchReturning(verdictResponse()))
      // 3. coach's closing text
      .mockResolvedValueOnce(fetchReturning(textResponse('Staged it for your approval.')));

    const res = await sendCoachMessage('coach', 'drop RDLs, back is sore', []);

    // Chip reflects the awaiting-approval state.
    expect(res.toolEvents[0].tool).toBe('update_weekly_program');
    expect(res.toolEvents[0].summary).toBe('🛡️ Reviewed — awaiting your approval');

    // The ACTIVE weekly program is UNCHANGED — nothing applied.
    const stored = await getWeeklyProgram();
    expect(stored?.revision).toBe(1);
    expect(stored?.days).toHaveLength(1);
    expect(stored?.days.find((d) => d.date === DATES[0])?.status).toBe('done');

    // A pending proposal was staged instead, preserving the done Monday.
    const pending = await getPendingProgram();
    expect(pending).not.toBeNull();
    expect(pending?.source).toBe('coach');
    expect(pending?.program.days.find((d) => d.date === DATES[0])?.status).toBe('done');
    expect(pending?.program.days.find((d) => d.date === DATES[2])?.focus).toBe('pull');

    // The tool_result told the model the plan is awaiting approval, not applied.
    const finalBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    const toolMsg = finalBody.messages.find(
      (m: { role: string; content: unknown }) =>
        Array.isArray(m.content) &&
        (m.content as ClaudeContentBlock[]).some((b) => b.type === 'tool_result')
    );
    const toolResult = (toolMsg.content as ClaudeContentBlock[]).find(
      (b) => b.type === 'tool_result'
    );
    expect(String(toolResult?.content)).toMatch(/awaiting Jason's approval/i);
  });
});

// ── nutrition mode ────────────────────────────────────────────

describe('nutrition mode', () => {
  it('sends no tools and uses the nutrition system', async () => {
    mockFetch.mockResolvedValueOnce(
      fetchReturning(textResponse('Grab Greek yoghurt and berries for ~30g protein.'))
    );

    const res = await sendCoachMessage('nutrition', 'quick high-protein snack?', []);

    expect(res.assistantText).toMatch(/greek yoghurt/i);
    expect(res.toolEvents).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.system[0].text).toContain('2000 kcal');
  });
});

// ── history trimming ──────────────────────────────────────────

describe('history trimming', () => {
  it('trims prior history to the last 30 turns (+ the current user turn)', async () => {
    const history: ChatMessage[] = Array.from({ length: 35 }, (_, i) => ({
      id: `h${i}`,
      mode: 'coach' as const,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `message ${i}`,
      timestamp: i,
    }));

    mockFetch.mockResolvedValueOnce(fetchReturning(textResponse('Got it.')));

    await sendCoachMessage('coach', 'latest question', history);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // 30 trimmed history messages + 1 current user turn.
    expect(body.messages).toHaveLength(31);
    // Oldest kept is message 5 (35 - 30), newest before the current turn is 34.
    expect(body.messages[0].content).toBe('message 5');
    expect(body.messages[30].content).toContain('latest question');
  });
});

// ── Photo attachments ─────────────────────────────────────────

describe('chat photo attachments', () => {
  it('sends image blocks FIRST and exactly one text block holding the context', async () => {
    mockFetch.mockResolvedValueOnce(fetchReturning(textResponse('Elbows are flaring.')));

    const atts = [attachment('a1'), attachment('a2')];
    const res = await sendCoachMessage('coach', 'how is my bench form?', [], {
      attachments: atts,
    });

    expect(res.assistantText).toBe('Elbows are flaring.');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const content = body.messages[body.messages.length - 1]
      .content as ClaudeContentBlock[];

    expect(content.map((b) => b.type)).toEqual(['image', 'image', 'text']);
    expect(content[0].source).toMatchObject({
      type: 'base64',
      media_type: 'image/jpeg',
    });
    // The <context> block stays INSIDE the single text block, after the images.
    expect(content[2].text).toContain('<context>');
    expect(content[2].text).toContain('how is my bench form?');
    expect(content[2].text?.indexOf('<context>')).toBeLessThan(
      content[2].text?.indexOf('how is my bench form?') ?? 0
    );

    // The attachments are persisted on the user turn (thumbnails in the bubble).
    const thread = await getChatMessages('coach');
    expect(thread[0].attachments?.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('does NOT replay images from history — the turn becomes a text note', async () => {
    const history: ChatMessage[] = [
      {
        id: 'h1',
        mode: 'coach',
        role: 'user',
        text: 'check my form',
        timestamp: 1,
        attachments: [attachment('old1')],
      },
      {
        id: 'h2',
        mode: 'coach',
        role: 'assistant',
        text: 'Elbows were flaring.',
        timestamp: 2,
      },
    ];
    mockFetch.mockResolvedValueOnce(fetchReturning(textResponse('Yes.')));

    await sendCoachMessage('coach', 'better now?', history);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // A 1024px image is ~1.5k input tokens; replaying it across the 30-turn
    // window would silently multiply the cost of every later message.
    expect(REPLAY_ATTACHMENT_TURNS).toBe(0);
    expect(body.messages[0].content).toBe('check my form [1 photo — not re-sent]');
    expect(JSON.stringify(body.messages.slice(0, -1))).not.toContain('base64');
    // The current turn has no images either, so it stays a plain string.
    expect(typeof body.messages[body.messages.length - 1].content).toBe('string');
  });

  it('synthesizes text for a photo-only send instead of an empty text block', async () => {
    mockFetch.mockResolvedValueOnce(fetchReturning(textResponse('Looking leaner.')));

    await sendCoachMessage('coach', '', [], {
      attachments: [attachment('p1'), attachment('p2')],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const content = body.messages[body.messages.length - 1]
      .content as ClaudeContentBlock[];
    const text = content[content.length - 1];

    expect(text.type).toBe('text');
    expect(text.text).toContain('(sent 2 photos)');
    expect(text.text?.trim().length).toBeGreaterThan(0);

    // The stored message keeps its empty text — the bubble shows the photos.
    const thread = await getChatMessages('coach');
    expect(thread[0].text).toBe('');
    expect(thread[0].attachments).toHaveLength(2);
  });

  it('attaches images in nutrition mode too (a photo of a meal)', async () => {
    mockFetch.mockResolvedValueOnce(fetchReturning(textResponse('~40g protein.')));

    await sendCoachMessage('nutrition', '', [], {
      attachments: [attachment('meal')],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const content = body.messages[0].content as ClaudeContentBlock[];
    expect(content.map((b) => b.type)).toEqual(['image', 'text']);
    expect(content[1].text).toBe('(sent 1 photo)');
  });

  it('honours a caller-supplied message id (durability matches on it)', async () => {
    mockFetch.mockResolvedValueOnce(fetchReturning(textResponse('ok')));

    const res = await sendCoachMessage('coach', 'hi', [], { messageId: 'fixed-id' });

    expect(res.userMessage.id).toBe('fixed-id');
    expect((await getChatMessages('coach'))[0].id).toBe('fixed-id');
  });
});
