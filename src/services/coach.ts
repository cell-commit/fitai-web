// Coach chat engine (design doc §5B/§5F).
//
// sendCoachMessage() is the single entry point for both chat modes:
//   • coach mode      → runToolLoop with the four file/plan tools, the cached
//                        system prefix, and the volatile <context> block on the
//                        last user turn;
//   • nutrition mode  → a plain callClaude (no tools) with the light nutrition
//                        system and a condensed slice.
// It persists the user + assistant ChatMessages to the correct thread (capped)
// and returns the assistant text plus tool-event chips derived from the tools
// that actually ran this turn.
//
// Tool handlers (all strict, additionalProperties:false, full required arrays):
//   update_weekly_program { week }   → validate + reconcile (done days kept) + persist
//   edit_training_status { old_str, new_str } → exact-1-match str-replace on the
//                        cached status file, optimistic cache update + queued write;
//                        is_error tool_result on 0 or >1 matches so Claude retries
//   append_history_log { markdown }  → queued append to the history log
//   read_history_log {}              → cached history log (fetch if empty+configured)

import type { ChatMessage, ChatMode, ChatToolEvent } from '../types';
import {
  MODELS,
  callClaude,
  runToolLoop,
  guardStopReason,
  firstText,
  type ClaudeMessage,
  type ClaudeTool,
  type ToolHandler,
} from './claude';
import {
  PROGRAM_SCHEMA,
  applyProgramReplacement,
} from './program';
import {
  buildCoachSystem,
  buildContextBlock,
  buildNutritionSystem,
  loadCoachSystemData,
  loadCoachContextData,
  loadNutritionSystemData,
} from './coachContext';
import {
  getCached,
  fetchFile,
  setCachedContent,
  queueWrite,
  isConfigured,
} from './driveSync';
import { appendChatMessage } from './storage';

const HISTORY_LIMIT = 30;

// ─────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────

const COACH_TOOLS: ClaudeTool[] = [
  {
    name: 'update_weekly_program',
    description:
      "Replace Jason's weekly program with a full 7-day week (Monday→Sunday, correct ISO dates, matching the current weekStart). Use when the actual plan changes. Days already marked 'done' are preserved automatically — copy them back unchanged. Use conventional gym exercise names so the app can match images.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: { week: PROGRAM_SCHEMA },
      required: ['week'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_training_status',
    description:
      'Make a targeted, exact-string edit to training-status.md. old_str MUST appear exactly once in the current file; include enough surrounding context to be unique. Prefer several small edits over one large one. Never blindly overwrite the whole file.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        old_str: {
          type: 'string',
          description: 'Exact text to replace; must match exactly once.',
        },
        new_str: { type: 'string', description: 'Replacement text.' },
      },
      required: ['old_str', 'new_str'],
      additionalProperties: false,
    },
  },
  {
    name: 'append_history_log',
    description:
      'Append a markdown entry to training-history-log.md (append-only — this never conflicts). Use for notable events worth recording in the long-term log.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        markdown: { type: 'string', description: 'Markdown to append.' },
      },
      required: ['markdown'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_history_log',
    description:
      'Read the full training-history-log.md. Use only when you need past session detail that is not already in the context block.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────

/** Count non-overlapping occurrences of needle in haystack. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

async function readHistoryLog(): Promise<string> {
  let cached = await getCached('training-history-log.md');
  if (!cached && (await isConfigured())) {
    try {
      cached = await fetchFile('training-history-log.md');
    } catch {
      // fall through to the not-available error below
    }
  }
  if (!cached) {
    throw new Error(
      'The training history log is not available (connect Drive sync in Settings).'
    );
  }
  return cached.content;
}

/**
 * Build the coach tool handlers. Successful executions push a chip event into
 * `events`; failed exact-match / availability cases return is_error tool_results
 * (and push no chip) so the tool loop continues and Claude can retry differently.
 */
function makeHandlers(events: ChatToolEvent[]): Record<string, ToolHandler> {
  return {
    update_weekly_program: async (input) => {
      const res = await applyProgramReplacement(input.week);
      events.push({ tool: 'update_weekly_program', summary: res.summary });
      return { content: res.summary };
    },

    edit_training_status: async (input) => {
      const oldStr = typeof input.old_str === 'string' ? input.old_str : '';
      const newStr = typeof input.new_str === 'string' ? input.new_str : '';

      const cached = await getCached('training-status.md');
      if (!cached) {
        return {
          content:
            'training-status.md is not connected, so it cannot be edited. Ask Jason to connect Drive sync in Settings.',
          isError: true,
        };
      }

      const count = countOccurrences(cached.content, oldStr);
      if (count !== 1) {
        const why =
          count === 0
            ? 'was not found'
            : `matched ${count} times (it must match exactly once)`;
        return {
          content: `old_str ${why} in training-status.md. Include more surrounding context so it is unique, then try again.`,
          isError: true,
        };
      }

      const next = cached.content.replace(oldStr, newStr);
      await setCachedContent('training-status.md', next);
      await queueWrite({
        file: 'training-status.md',
        op: 'write',
        content: next,
        baseModifiedTime: cached.modifiedTime,
      });
      events.push({ tool: 'edit_training_status', summary: 'Edited training status' });
      return {
        content: 'Applied the edit to training-status.md and queued the write to Drive.',
      };
    },

    append_history_log: async (input) => {
      const markdown = typeof input.markdown === 'string' ? input.markdown : '';
      if (!markdown.trim()) {
        return { content: 'markdown was empty; nothing appended.', isError: true };
      }
      await queueWrite({
        file: 'training-history-log.md',
        op: 'append',
        content: markdown,
      });
      events.push({ tool: 'append_history_log', summary: 'Appended to history log' });
      return { content: 'Appended the entry to training-history-log.md.' };
    },

    read_history_log: async () => {
      const content = await readHistoryLog();
      events.push({ tool: 'read_history_log', summary: 'Read history log' });
      return { content };
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Message assembly
// ─────────────────────────────────────────────────────────────

/** Map persisted chat history (trimmed to the last 30) to wire messages. */
function historyToMessages(history: ChatMessage[]): ClaudeMessage[] {
  return history
    .slice(-HISTORY_LIMIT)
    .map((m) => ({ role: m.role, content: m.text }));
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────

export interface SendCoachResult {
  assistantText: string;
  toolEvents: ChatToolEvent[];
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

/**
 * Send a chat message. Persists the user turn first (so it survives a failed
 * call), runs the mode-appropriate engine, persists the assistant turn, and
 * returns both messages plus the tool-event chips. `history` is the prior thread
 * (excluding this user turn); it is trimmed to the last 30 for the API call.
 */
export async function sendCoachMessage(
  mode: ChatMode,
  userText: string,
  history: ChatMessage[]
): Promise<SendCoachResult> {
  const userMessage: ChatMessage = {
    id: makeId(),
    mode,
    role: 'user',
    text: userText,
    timestamp: Date.now(),
  };
  await appendChatMessage(userMessage);

  let assistantText: string;
  let toolEvents: ChatToolEvent[] = [];

  if (mode === 'nutrition') {
    assistantText = await runNutrition(userText, history);
  } else {
    const res = await runCoach(userText, history);
    assistantText = res.assistantText;
    toolEvents = res.toolEvents;
  }

  const assistantMessage: ChatMessage = {
    id: makeId(),
    mode,
    role: 'assistant',
    text: assistantText,
    toolEvents: toolEvents.length > 0 ? toolEvents : undefined,
    timestamp: Date.now(),
  };
  await appendChatMessage(assistantMessage);

  return { assistantText, toolEvents, userMessage, assistantMessage };
}

// ── Coach mode ────────────────────────────────────────────────

async function runCoach(
  userText: string,
  history: ChatMessage[]
): Promise<{ assistantText: string; toolEvents: ChatToolEvent[] }> {
  const [systemData, contextData] = await Promise.all([
    loadCoachSystemData(),
    loadCoachContextData(),
  ]);
  const system = buildCoachSystem(systemData);
  const contextBlock = buildContextBlock(contextData);

  const messages: ClaudeMessage[] = historyToMessages(history);
  messages.push({ role: 'user', content: `${contextBlock}\n\n${userText}` });

  const events: ChatToolEvent[] = [];
  const result = await runToolLoop(
    {
      model: MODELS.coach,
      system,
      messages,
      tools: COACH_TOOLS,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      maxTokens: 4096,
    },
    makeHandlers(events)
  );

  let assistantText = firstText(result.response);
  if (result.truncated && !assistantText) {
    assistantText =
      'I ran out of room finishing that — could you nudge me to continue?';
  }
  if (!assistantText && events.length > 0) {
    // Tools ran but the model returned no closing text (rare) — synthesize one.
    assistantText = events.map((e) => e.summary).join(' · ');
  }
  return { assistantText, toolEvents: events };
}

// ── Nutrition mode ────────────────────────────────────────────

async function runNutrition(
  userText: string,
  history: ChatMessage[]
): Promise<string> {
  const data = await loadNutritionSystemData();
  const system = buildNutritionSystem(data);

  const messages: ClaudeMessage[] = historyToMessages(history);
  messages.push({ role: 'user', content: userText });

  const response = await callClaude({
    model: MODELS.coach,
    system,
    messages,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    maxTokens: 4096,
  });
  guardStopReason(response);
  return firstText(response);
}
