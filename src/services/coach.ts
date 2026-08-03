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

import type {
  ChatAttachment,
  ChatMessage,
  ChatMode,
  ChatToolEvent,
} from '../types';
import {
  MODELS,
  callClaude,
  runToolLoop,
  guardRefusal,
  firstText,
  type ClaudeMessage,
  type ClaudeContentBlock,
  type ClaudeTool,
  type ToolHandler,
} from './claude';
import { attachmentsToBlocks } from './chatAttachments';
import {
  PROGRAM_SCHEMA,
  stageProgramReplacement,
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

/**
 * Output-token cap for both chat modes.
 *
 * ⚠️ THINKING TOKENS COME OUT OF THIS SAME BUDGET. Both modes run
 * `thinking: { type: 'adaptive' }`, and on Opus 4.x the adaptive reasoning is
 * billed against max_tokens before a single character of the visible reply is
 * written. The old value here was 4096, which a whole-week plan plus an "open
 * items" list blew through routinely: the answer truncated, the partial text
 * was thrown away, and "Continue" just regenerated the same oversized reply.
 *
 * 16384 is the ceiling, not a target — the model still stops when it is done.
 * The model itself allows up to 128K output tokens, but these are NON-STREAMING
 * fetches behind DEFAULT_REQUEST_TIMEOUT_MS (180s), and ~16K is the largest
 * budget that reliably finishes inside that window. Going higher means moving
 * the chat to streaming first.
 *
 * DO NOT LOWER THIS to "save tokens": max_tokens is a cap, not a spend, so a
 * short answer costs exactly the same at 16384 as it did at 4096.
 */
const MAX_OUTPUT_TOKENS = 16384;

/**
 * Appended to a truncated assistant turn when it is replayed as history, so a
 * later turn reads the abrupt ending as "this was cut off" rather than as the
 * coach's considered final word (and does not imitate the style).
 */
const TRUNCATION_NOTE = '[This reply was cut off by the output limit.]';

/**
 * Instruction added to the WIRE text of a continuation send. The partial
 * assistant turn is already in the messages array as history; this tells the
 * model to resume it. An assistant prefill would be the obvious mechanism, but
 * Opus 4.x rejects a trailing assistant turn with a 400 — continuation has to
 * ride on a user turn.
 */
const CONTINUE_INSTRUCTION =
  'Your previous reply was cut off by the output limit. Continue it from exactly where it stopped — pick up mid-sentence if that is where it ended. Do not restart, do not re-summarise what you already wrote, and do not apologise.';

// ─────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────

/** Exported for tests (copy-limit regression guard); not used elsewhere. */
export const COACH_TOOLS: ClaudeTool[] = [
  {
    name: 'update_weekly_program',
    description:
      "Replace Jason's weekly program with a full 7-day week (Monday→Sunday, correct ISO dates, matching the current weekStart). WHEN TO CALL — only when Jason has ASKED for a plan or a change to one, or has clearly accepted a proposal you put to him. Do NOT stage a change he did not ask for: a question about what you can see, what you know, or what you would do is answered in words, never with a staged week. Do NOT call this to pre-empt a decision that contradicts what he said he expects (holding back a reintroduction, extending a restriction, cutting work he asked for) while that question is still open — put the recommendation to him in the reply and offer to build the week instead. Days already marked 'done' are preserved automatically — copy them back unchanged. Use conventional gym exercise names so the app can match images. VARIETY (Jason asked for this explicitly — range of motion and hitting the target area from different angles): do NOT repeat the same exercise on more than one day of the week unless there is a specific reason (rehab/corrective work, or a movement his training status pins). Rotate variations instead — different row types (chest-supported, one-arm dumbbell, seated cable, inverted), different press angles and grips, machine vs free-weight — and cover each muscle group with at least 2 distinct movements when its weekly volume is meaningful (roughly 8+ sets). Correctives explicitly prescribed in his training status are exempt: keep them as prescribed. Variety must come from genuinely different movements, never invented names. Keep plan copy terse — it is read on a phone mid-workout: day title ≤ 4 words with no parentheticals, coachNotes ≤ 30 words as an imperative cue, exercise notes ≤ 12 words. Your reasoning and caveats belong in your chat reply, never in the plan.",
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
function makeHandlers(
  events: ChatToolEvent[],
  reason: string
): Record<string, ToolHandler> {
  return {
    update_weekly_program: async (input) => {
      // Route through the safety-review gate: the change is STAGED for Jason's
      // approval, never applied silently. Tell the model so its reply reflects
      // that the plan is pending rather than already in effect.
      const pending = await stageProgramReplacement(input.week, reason);
      events.push({
        tool: 'update_weekly_program',
        summary: '🛡️ Reviewed — awaiting your approval',
      });
      const reviewSummary =
        'status' in pending.review
          ? 'The independent safety review was unavailable, so it is staged UNREVIEWED — flag that Jason should check it himself.'
          : pending.review.summary;
      return {
        content: `The updated plan has been staged and is awaiting Jason's approval in the Week tab — it has NOT been applied yet. Independent review: ${reviewSummary} In your reply, tell Jason the plan is ready for him to approve or discard; do NOT claim it is already in effect.`,
      };
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

/**
 * How many past turns replay their images to the API. Deliberately ZERO.
 *
 * A 1024px photo costs roughly 1.5k input tokens. The history window is 30
 * turns, so replaying attachments would re-upload every photo he has ever sent
 * on EVERY later message — the cost of a one-word follow-up would quietly scale
 * with how many pictures are still in the window, and the model would keep
 * re-reading stale images as if they were current. Instead an attachment-bearing
 * history turn is summarised in text (see historyText) and the coach's own
 * earlier reply carries the memory of what was in the picture.
 *
 * Consequence accepted: "and the other shoulder?" cannot re-examine the photo.
 * Raising this above 0 means budgeting the token cost first.
 */
export const REPLAY_ATTACHMENT_TURNS = 0;

/**
 * History rendering for a turn that carried images — text, never the bytes.
 * A truncated assistant turn is replayed with an explicit note: without it the
 * model reads a reply that stops mid-sentence as a stylistic choice, and a
 * later unrelated turn can start imitating the abrupt ending.
 */
function historyText(m: ChatMessage): string {
  const n = m.attachments?.length ?? 0;
  let text = m.text;
  if (n > 0) {
    const note = `[${n} photo${n === 1 ? '' : 's'} — not re-sent]`;
    text = text ? `${text} ${note}` : note;
  }
  if (m.role === 'assistant' && m.truncated) {
    text = text ? `${text}\n\n${TRUNCATION_NOTE}` : TRUNCATION_NOTE;
  }
  return text;
}

/** Map persisted chat history (trimmed to the last 30) to wire messages. */
function historyToMessages(history: ChatMessage[]): ClaudeMessage[] {
  return history
    .slice(-HISTORY_LIMIT)
    .map((m) => ({ role: m.role, content: historyText(m) }));
}

/**
 * The text that goes on the wire for this turn. A photo-only send must never
 * produce an empty text block (or a turn of images with no text at all) — the
 * API rejects it and the model has nothing to answer.
 */
function wireText(userText: string, imageCount: number): string {
  const trimmed = userText.trim();
  if (trimmed) return userText;
  if (imageCount === 0) return userText;
  return `(sent ${imageCount} photo${imageCount === 1 ? '' : 's'})`;
}

/**
 * Build the final user turn: images first, then exactly ONE text block. The
 * <context> block belongs INSIDE that text block, after the images — putting it
 * in a block of its own before them would split the turn's instructions across
 * two places and read as if the context described the pictures.
 */
function userTurn(
  text: string,
  imageBlocks: ClaudeContentBlock[]
): ClaudeMessage {
  if (imageBlocks.length === 0) return { role: 'user', content: text };
  return { role: 'user', content: [...imageBlocks, { type: 'text', text }] };
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
  /** True when the reply hit the output cap — its text is partial, not final. */
  truncated: boolean;
}

/** The user-visible text of the turn the "Continue" affordance sends. */
export const CONTINUE_TEXT = 'Continue';

/**
 * Options bag (not extra positional args) so every existing call site and test
 * that passes three arguments keeps working untouched.
 */
export interface SendCoachOptions {
  /** Images to attach to this turn; already resized and stored by attach time. */
  attachments?: ChatAttachment[];
  /**
   * Force the persisted user message's id. coachInflight generates it up front
   * so the durability record can match the turn by id instead of by text — a
   * photo-only send has no text to match on.
   */
  messageId?: string;
  /**
   * This send resumes a reply that hit the output cap. The partial assistant
   * turn is already carried in `history`; this appends the resume instruction
   * to the WIRE text only, so the chat still shows a plain "Continue" bubble.
   */
  continuation?: boolean;
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
  history: ChatMessage[],
  opts: SendCoachOptions = {}
): Promise<SendCoachResult> {
  const attachments = opts.attachments ?? [];
  const userMessage: ChatMessage = {
    id: opts.messageId ?? makeId(),
    mode,
    role: 'user',
    text: userText,
    timestamp: Date.now(),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
  await appendChatMessage(userMessage);

  // Encode once, here, so a mode branch cannot forget to do it.
  const imageBlocks =
    attachments.length > 0 ? await attachmentsToBlocks(attachments) : [];
  const base = wireText(userText, imageBlocks.length);
  const text = opts.continuation ? `${base}\n\n${CONTINUE_INSTRUCTION}` : base;

  let assistantText: string;
  let truncated: boolean;
  let toolEvents: ChatToolEvent[] = [];

  if (mode === 'nutrition') {
    const res = await runNutrition(text, history, imageBlocks);
    assistantText = res.assistantText;
    truncated = res.truncated;
  } else {
    const res = await runCoach(text, history, imageBlocks);
    assistantText = res.assistantText;
    truncated = res.truncated;
    toolEvents = res.toolEvents;
  }

  const assistantMessage: ChatMessage = {
    id: makeId(),
    mode,
    role: 'assistant',
    text: assistantText,
    toolEvents: toolEvents.length > 0 ? toolEvents : undefined,
    timestamp: Date.now(),
    ...(truncated ? { truncated: true } : {}),
  };
  await appendChatMessage(assistantMessage);

  return { assistantText, toolEvents, userMessage, assistantMessage, truncated };
}

// ── Coach mode ────────────────────────────────────────────────

async function runCoach(
  userText: string,
  history: ChatMessage[],
  imageBlocks: ClaudeContentBlock[] = []
): Promise<{
  assistantText: string;
  toolEvents: ChatToolEvent[];
  truncated: boolean;
}> {
  const [systemData, contextData] = await Promise.all([
    loadCoachSystemData(),
    loadCoachContextData(),
  ]);
  const system = buildCoachSystem(systemData);
  const contextBlock = buildContextBlock(contextData);

  const messages: ClaudeMessage[] = historyToMessages(history);
  messages.push(userTurn(`${contextBlock}\n\n${userText}`, imageBlocks));

  const events: ChatToolEvent[] = [];
  const result = await runToolLoop(
    {
      model: MODELS.coach,
      system,
      messages,
      tools: COACH_TOOLS,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      // Thinking tokens share this budget — see MAX_OUTPUT_TOKENS.
      maxTokens: MAX_OUTPUT_TOKENS,
    },
    makeHandlers(events, userText)
  );

  // NEVER discard a partial answer. On truncation the generated text is kept
  // exactly as written and the turn is FLAGGED instead; the pane renders it with
  // a Continue button. The fallback line below is only for the genuinely-empty
  // case (the response ended on a thinking or tool_use block with no text at
  // all) — replacing real content with an apology is what caused the loop.
  let assistantText = firstText(result.response);
  if (!assistantText && events.length > 0) {
    // Tools ran but the model returned no closing text (rare) — synthesize one.
    assistantText = events.map((e) => e.summary).join(' · ');
  }
  if (!assistantText && result.truncated) {
    assistantText =
      'I ran out of room before writing anything — tap Continue and I’ll pick it up.';
  }
  return { assistantText, toolEvents: events, truncated: result.truncated };
}

// ── Nutrition mode ────────────────────────────────────────────

async function runNutrition(
  userText: string,
  history: ChatMessage[],
  imageBlocks: ClaudeContentBlock[] = []
): Promise<{ assistantText: string; truncated: boolean }> {
  const data = await loadNutritionSystemData();
  const system = buildNutritionSystem(data);

  const messages: ClaudeMessage[] = historyToMessages(history);
  messages.push(userTurn(userText, imageBlocks));

  const response = await callClaude({
    model: MODELS.coach,
    system,
    messages,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    // Thinking tokens share this budget — see MAX_OUTPUT_TOKENS.
    maxTokens: MAX_OUTPUT_TOKENS,
  });
  // guardRefusal, NOT guardStopReason: a refusal is a hard error, but hitting
  // the token cap must not throw away the food advice already written. Same
  // keep-the-partial treatment as coach mode.
  guardRefusal(response);
  const truncated = response.stop_reason === 'max_tokens';
  let assistantText = firstText(response);
  if (!assistantText && truncated) {
    assistantText =
      'I ran out of room before writing anything — tap Continue and I’ll pick it up.';
  }
  return { assistantText, truncated };
}
