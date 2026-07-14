import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { sendCoachMessage } from '../coach';
import { saveSettings, saveWeeklyProgram, getWeeklyProgram } from '../storage';
import { getWeekStart } from '../../utils/date';
import { weekDates } from '../program';
import type { ClaudeResponse, ClaudeContentBlock } from '../claude';
import type { ChatMessage, WeeklyProgram, DayFocus } from '../../types';

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

// ── update_weekly_program ─────────────────────────────────────

describe('update_weekly_program', () => {
  it('persists the new week while preserving days already marked done', async () => {
    const current: WeeklyProgram = {
      weekStart: WEEK_START,
      generatedAt: 0,
      revision: 1,
      days: [
        {
          date: DATES[0],
          focus: 'push',
          title: 'Push',
          status: 'done', // must survive the coach's replacement
          exercises: [
            { name: 'Leg Press', sets: 3, repRange: '10-12', slug: 'Leg_Press' },
            { name: 'Hip Thrust', sets: 3, repRange: '10-12' },
          ],
        },
      ],
    };
    await saveWeeklyProgram(current);

    mockFetch
      .mockResolvedValueOnce(
        fetchReturning(
          // Coach proposes a different Monday, but Monday is done → preserved.
          toolUseResponse('update_weekly_program', { week: modelWeek(['Barbell Bench Press']) })
        )
      )
      .mockResolvedValueOnce(fetchReturning(textResponse('Reworked the rest of your week.')));

    const res = await sendCoachMessage('coach', 'drop RDLs, back is sore', []);

    expect(res.toolEvents[0].tool).toBe('update_weekly_program');

    const stored = await getWeeklyProgram();
    const monday = stored?.days.find((d) => d.date === DATES[0]);
    expect(monday?.status).toBe('done');
    expect(monday?.exercises.map((e) => e.name)).toEqual(['Leg Press', 'Hip Thrust']);

    // Remaining days were adopted (Wednesday pull present).
    expect(stored?.days.find((d) => d.date === DATES[2])?.focus).toBe('pull');
    expect(stored?.revision).toBe(2);
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
