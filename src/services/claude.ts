// Claude API service (design doc §2).
//
// Web port of the React Native raw-fetch service. Two web-specific changes vs
// the RN original:
//   (a) the fetch sends 'anthropic-dangerous-direct-browser-access': 'true' so
//       the browser CORS gate lets the call through (design §Risks 2);
//   (b) the API key comes from Settings storage (getSettings().anthropicApiKey),
//       entered once on-device — never bundled — instead of expo-constants/.env.
// analyzeFoodPhoto takes a base64 string + media type (the caller reads the
// File via FileReader/canvas) instead of a filesystem URI.

import type { CheckIn, Workout, DayData, Settings } from '../types';
import { getSettings } from './storage';

// ─────────────────────────────────────────────────────────────
// Model map (design doc §2.1)
// ─────────────────────────────────────────────────────────────
export const MODELS = {
  coach: 'claude-opus-4-8', // coach chat, weekly program, photo vision
  cheap: 'claude-haiku-4-5', // food estimates, name mapping, health summary
} as const;

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

async function getApiKey(): Promise<string> {
  const settings = await getSettings();
  return settings.anthropicApiKey?.trim() ?? '';
}

// ─────────────────────────────────────────────────────────────
// Wire types
// ─────────────────────────────────────────────────────────────
export interface ClaudeContentBlock {
  type: string;
  text?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // image / other
  source?: { type: 'base64'; media_type: string; data: string };
  [key: string]: unknown;
}

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface OutputConfig {
  effort?: Effort;
  format?: { type: 'json_schema'; schema: Record<string, unknown> };
}

export interface ThinkingConfig {
  type: 'adaptive' | 'disabled';
  display?: 'summarized' | 'omitted';
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeResponse {
  id: string;
  model: string;
  content: ClaudeContentBlock[];
  stop_reason:
    | 'end_turn'
    | 'max_tokens'
    | 'tool_use'
    | 'pause_turn'
    | 'refusal'
    | 'stop_sequence'
    | null;
  stop_details?: { category?: string; explanation?: string } | null;
  usage: ClaudeUsage;
}

export interface CallClaudeOptions {
  model: string;
  messages: ClaudeMessage[];
  system?: string | SystemBlock[];
  tools?: ClaudeTool[];
  tool_choice?: Record<string, unknown>;
  output_config?: OutputConfig;
  thinking?: ThinkingConfig;
  maxTokens?: number;
  /** Caller-owned cancellation (e.g. leaving a screen). Optional. */
  signal?: AbortSignal;
  /**
   * Per-request wall-clock budget. Defaults to DEFAULT_REQUEST_TIMEOUT_MS so no
   * request can hang forever; existing call sites keep their behaviour and just
   * gain the generous ceiling. In runToolLoop this applies to EACH API call, not
   * the whole loop.
   */
  timeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────
// Request durability (coach-chat resilience)
//
// Every call gets an AbortSignal and a timeout so a request that is never going
// to complete — hung socket, or a fetch torn down because iOS suspended the page
// — fails as a recognisable, retryable error instead of hanging or surfacing
// Safari's bare "Load failed".
// ─────────────────────────────────────────────────────────────
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

export type ClaudeRequestFailureKind = 'timeout' | 'abort' | 'network';

/** A request that never reached a verdict — safe to retry (see isTransientClaudeError). */
export class ClaudeRequestError extends Error {
  readonly kind: ClaudeRequestFailureKind;
  constructor(kind: ClaudeRequestFailureKind, message: string) {
    super(message);
    this.name = 'ClaudeRequestError';
    this.kind = kind;
  }
}

// Safari says "Load failed"; Chrome "Failed to fetch"; Firefox "NetworkError…".
const TRANSIENT_MESSAGE =
  /load failed|failed to fetch|network\s?error|network request failed|connection appears to be offline|aborted/i;

/**
 * True for connectivity / cancellation / timeout failures — the ones worth a
 * silent retry. Real API verdicts (401 bad key, 429 rate limit, 400) are NOT
 * transient: retrying them costs money and repeats the same answer.
 */
export function isTransientClaudeError(e: unknown): boolean {
  if (e instanceof ClaudeRequestError) return true;
  if (e instanceof Error) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
    // Anything we mapped to an explicit API error keeps its own message.
    if (e.message.startsWith('API error (')) return false;
    return TRANSIENT_MESSAGE.test(e.message);
  }
  return false;
}

/** A promise that rejects as soon as `signal` aborts (never resolves). */
function rejectOnAbort(
  signal: AbortSignal,
  makeError: () => Error
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(makeError());
      return;
    }
    signal.addEventListener('abort', () => reject(makeError()), { once: true });
  });
}

// ─────────────────────────────────────────────────────────────
// Core call — returns the full parsed response (content blocks +
// stop_reason + usage). Raw-fetch style, per design doc §2.2.
//
// CRITICAL (Opus 4.8): never send temperature/top_p/top_k or
// budget_tokens — all 400. Coach-tier callers pass
// thinking:{type:'adaptive'}. Haiku sends no thinking config.
// ─────────────────────────────────────────────────────────────
export async function callClaude(
  opts: CallClaudeOptions
): Promise<ClaudeResponse> {
  const apiKey = await getApiKey();
  if (!apiKey || apiKey === 'your_api_key_here') {
    throw new Error(
      'No API key configured. Add your Anthropic API key in Settings.'
    );
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    messages: opts.messages,
  };

  if (opts.system !== undefined) body.system = opts.system;
  if (opts.tools) body.tools = opts.tools;
  if (opts.tool_choice) body.tool_choice = opts.tool_choice;
  if (opts.output_config) body.output_config = opts.output_config;
  if (opts.thinking) body.thinking = opts.thinking;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', onCallerAbort, { once: true });

  let response: Response;
  try {
    // The abort promise is raced against the fetch so the timeout holds even if
    // the platform's fetch ignores the signal (or the page was suspended and the
    // request will never settle either way).
    response = await Promise.race([
      fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          // Web port: required for direct browser-to-API calls (design §Risks 2).
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      rejectOnAbort(controller.signal, () =>
        timedOut
          ? new ClaudeRequestError(
              'timeout',
              `The coach did not reply within ${Math.round(timeoutMs / 1000)}s. Nothing was lost — you can try again.`
            )
          : new ClaudeRequestError('abort', 'The request was cancelled.')
      ),
    ]);
  } catch (e) {
    if (e instanceof ClaudeRequestError) throw e;
    if (e instanceof Error && e.name === 'AbortError') {
      throw new ClaudeRequestError(
        timedOut ? 'timeout' : 'abort',
        timedOut
          ? `The coach did not reply within ${Math.round(timeoutMs / 1000)}s. Nothing was lost — you can try again.`
          : 'The request was cancelled.'
      );
    }
    // fetch() rejects with a bare TypeError ("Load failed" on Safari) when the
    // connection drops — including when iOS suspends the page mid-request.
    throw new ClaudeRequestError(
      'network',
      'The connection dropped before the coach replied.'
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 401)
      throw new Error('Invalid API key. Check the Anthropic API key in Settings.');
    if (response.status === 429)
      throw new Error('Rate limit reached. Please wait a moment and try again.');
    throw new Error(`API error (${response.status}): ${errorText}`);
  }

  try {
    return (await response.json()) as ClaudeResponse;
  } catch {
    throw new ClaudeRequestError(
      'network',
      'The reply was cut off before it finished downloading.'
    );
  }
}

/** First text block of a response, or ''. */
export function firstText(response: ClaudeResponse): string {
  const block = response.content?.find((b) => b.type === 'text');
  return (block?.text as string) ?? '';
}

/**
 * Thin text-only convenience wrapper for callers that just want a string
 * (e.g. legacy generateWorkout). Handles refusal / truncation.
 */
export async function callClaudeText(opts: CallClaudeOptions): Promise<string> {
  const response = await callClaude(opts);
  guardStopReason(response);
  return firstText(response);
}

/**
 * Throw only on an explicit refusal. Split out of guardStopReason so callers
 * that want to KEEP a truncated partial answer (the coach and nutrition chats)
 * can reject a refusal without also throwing away everything the model wrote
 * before it hit max_tokens.
 */
export function guardRefusal(response: ClaudeResponse): void {
  if (response.stop_reason === 'refusal') {
    throw new Error(
      response.stop_details?.explanation ??
        'The coach declined to respond to that request.'
    );
  }
}

/**
 * Refusal + truncation guard, for callers whose result is only usable complete
 * (structured JSON, the safety reviewer's verdict). Chat callers should use
 * guardRefusal and handle `stop_reason === 'max_tokens'` themselves.
 */
export function guardStopReason(response: ClaudeResponse): void {
  guardRefusal(response);
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      'The response was cut off (hit the token limit). Please try again or simplify the request.'
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Structured output (design doc §2.2) — replaces regex parseJSON
// on new code paths. Schema MUST have additionalProperties:false
// and a `required` array.
// ─────────────────────────────────────────────────────────────
export async function callClaudeStructured<T>(
  opts: CallClaudeOptions,
  schema: Record<string, unknown>
): Promise<T> {
  const output_config: OutputConfig = {
    ...(opts.output_config ?? {}),
    format: { type: 'json_schema', schema },
  };
  const response = await callClaude({ ...opts, output_config });
  guardStopReason(response);
  const text = firstText(response);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Could not parse structured response from Claude.');
  }
}

// ─────────────────────────────────────────────────────────────
// Manual agentic tool loop (design doc §2.2)
//
// While stop_reason === 'tool_use': execute ALL tool_use blocks via
// handlers, append the assistant content + ONE user message containing
// all tool_result blocks, then re-call. Cap 5 iterations. Re-send on
// 'pause_turn'. Throw a friendly error on 'refusal'. Surface 'max_tokens'.
//
// opts.signal / opts.timeoutMs are forwarded to every API call in the loop (the
// timeout is per call, not per loop), so a caller can cancel the whole loop with
// one signal and no iteration can hang forever.
// ─────────────────────────────────────────────────────────────
export interface ToolHandlerResult {
  content: string;
  isError?: boolean;
}

export type ToolHandler = (
  input: Record<string, unknown>
) => Promise<ToolHandlerResult> | ToolHandlerResult;

export interface ToolExecution {
  name: string;
  input: Record<string, unknown>;
  result: ToolHandlerResult;
}

export interface ToolLoopResult {
  response: ClaudeResponse;
  messages: ClaudeMessage[];
  executions: ToolExecution[];
  truncated: boolean;
}

const MAX_TOOL_ITERATIONS = 5;

export async function runToolLoop(
  opts: CallClaudeOptions,
  handlers: Record<string, ToolHandler>
): Promise<ToolLoopResult> {
  const messages: ClaudeMessage[] = [...opts.messages];
  const executions: ToolExecution[] = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await callClaude({ ...opts, messages });

    if (response.stop_reason === 'refusal') {
      throw new Error(
        response.stop_details?.explanation ??
          'The coach declined to respond to that request.'
      );
    }

    if (response.stop_reason === 'pause_turn') {
      // Server paused (e.g. long server-tool run). Re-send with the
      // assistant turn appended; the server resumes automatically.
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (b) => b.type === 'tool_use'
      );
      // Append the assistant turn (must include the tool_use blocks).
      messages.push({ role: 'assistant', content: response.content });

      // Execute ALL tool_use blocks, collect results into ONE user message.
      const toolResults: ClaudeContentBlock[] = [];
      for (const block of toolUseBlocks) {
        const name = block.name ?? '';
        const input = (block.input ?? {}) as Record<string, unknown>;
        const handler = handlers[name];
        let result: ToolHandlerResult;
        if (!handler) {
          result = {
            content: `No handler registered for tool "${name}".`,
            isError: true,
          };
        } else {
          try {
            result = await handler(input);
          } catch (e) {
            result = {
              content: e instanceof Error ? e.message : 'Tool execution failed.',
              isError: true,
            };
          }
        }
        executions.push({ name, input, result });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Terminal states.
    if (response.stop_reason === 'max_tokens') {
      return { response, messages, executions, truncated: true };
    }
    // end_turn / stop_sequence
    return { response, messages, executions, truncated: false };
  }

  // Exhausted the iteration cap while still calling tools.
  const finalResponse = await callClaude({ ...opts, messages });
  return {
    response: finalResponse,
    messages,
    executions,
    truncated: finalResponse.stop_reason === 'tool_use',
  };
}

// ─────────────────────────────────────────────────────────────
// Food analysis — MODELS.cheap + structured output.
// (design doc §2.2: delete regex parseJSON on new paths.)
// ─────────────────────────────────────────────────────────────
interface FoodAnalysis {
  mealName: string;
  calories: number;
  protein: number;
  description?: string;
}

const FOOD_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    mealName: { type: 'string' },
    calories: { type: 'number' },
    protein: { type: 'number' },
    description: { type: 'string' },
  },
  required: ['mealName', 'calories', 'protein', 'description'],
  additionalProperties: false,
};

/**
 * Analyze a food photo. Web port: the caller reads the File (via FileReader or
 * a canvas resize) and passes the raw base64 payload plus its media type,
 * instead of a filesystem URI.
 */
export async function analyzeFoodPhoto(
  base64: string,
  mediaType: string = 'image/jpeg'
): Promise<FoodAnalysis> {
  const messages: ClaudeMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: 'Analyze this food image and estimate its nutritional content. Consider typical restaurant/home portions. Set mealName to a descriptive name, calories to the estimated kcal, protein to the estimated grams, and description to a brief note on what you see and how you estimated.',
        },
      ],
    },
  ];

  return callClaudeStructured<FoodAnalysis>(
    { model: MODELS.cheap, messages, maxTokens: 1024 },
    FOOD_SCHEMA
  );
}

export async function analyzeFoodDescription(
  description: string
): Promise<FoodAnalysis> {
  const messages: ClaudeMessage[] = [
    {
      role: 'user',
      content: `Estimate the nutritional content of this meal description: "${description}". Consider typical portion sizes. Set mealName to a concise name, calories to estimated kcal, protein to estimated grams, and description to a brief note on your estimation.`,
    },
  ];

  return callClaudeStructured<FoodAnalysis>(
    { model: MODELS.cheap, messages, maxTokens: 1024 },
    FOOD_SCHEMA
  );
}

// ─────────────────────────────────────────────────────────────
// Legacy workout generation — kept functional for now (retired in
// W2/W3). Points at MODELS.cheap so no code references the old
// sonnet model string. Still uses the text + parseJSON path.
// ─────────────────────────────────────────────────────────────
function parseJSON<T>(text: string): T {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse AI response. Please try again.');
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    throw new Error('Invalid JSON in AI response. Please try again.');
  }
}

export async function generateWorkout(
  todayCheckIn: CheckIn,
  recentHistory: DayData[],
  settings: Settings
): Promise<Workout> {
  const historyText =
    recentHistory.length > 0
      ? recentHistory
          .map((day) => {
            const lines: string[] = [`Date: ${day.date}`];
            if (day.checkIn) {
              lines.push(
                `  Check-in — Soreness: ${day.checkIn.soreness}/5, Energy: ${day.checkIn.energy}/5, Sleep: ${day.checkIn.sleep}/5`
              );
              if (day.checkIn.notes) lines.push(`  Notes: "${day.checkIn.notes}"`);
            }
            if (day.workout?.exercises?.length) {
              const exList = day.workout.exercises
                .slice(0, 5)
                .map((e) => `${e.name} ${e.sets}×${e.reps}`)
                .join(', ');
              lines.push(
                `  Workout: ${exList}${day.workout.exercises.length > 5 ? ', ...' : ''}`
              );
            }
            if (day.foodEntries.length > 0) {
              const totalCals = day.foodEntries.reduce((sum, f) => sum + f.calories, 0);
              const totalProt = day.foodEntries.reduce((sum, f) => sum + f.protein, 0);
              lines.push(`  Nutrition: ${totalCals} kcal, ${totalProt}g protein`);
            }
            return lines.join('\n');
          })
          .join('\n\n')
      : 'No recent history available — this appears to be an early session.';

  const athleteName = settings.name || 'the athlete';
  const soreness = todayCheckIn.soreness;
  const energy = todayCheckIn.energy;
  const sleep = todayCheckIn.sleep;

  const systemPrompt = `You are an expert personal trainer and strength & conditioning coach. You design personalized gym workouts based on daily athlete readiness data. Your workouts are gym/weight training focused. Always respond with valid JSON only — no extra text.`;

  const userPrompt = `Design a gym workout for ${athleteName} based on today's readiness check-in.

TODAY'S CHECK-IN:
- Muscle Soreness/Pain: ${soreness}/5 (1 = no soreness, 5 = very sore/painful)
- Energy Level: ${energy}/5 (1 = exhausted, 5 = excellent energy)
- Sleep Quality: ${sleep}/5 (1 = terrible sleep, 5 = great sleep)
${todayCheckIn.notes ? `- Athlete notes: "${todayCheckIn.notes}"` : ''}

RECENT TRAINING HISTORY (last 7 days):
${historyText}

INSTRUCTIONS:
- Adjust intensity to match today's readiness (high soreness/low energy = lighter session or deload)
- Avoid overtraining muscle groups that were worked heavily in the last 2 days
- If soreness is 4-5, prioritize active recovery, mobility, or upper/lower split away from sore areas
- Include 3-7 exercises for a typical session
- Provide realistic set/rep schemes and optional weight guidance

Respond with ONLY this JSON structure:
{
  "exercises": [
    {
      "name": "Exercise name",
      "sets": 3,
      "reps": "8-10",
      "weight": "70-80% 1RM or specific guidance",
      "notes": "Optional technique cue"
    }
  ],
  "warmup": ["Warmup item 1", "Warmup item 2"],
  "cooldown": ["Cooldown item 1"],
  "coachingNotes": "2-3 sentences of coaching context for today's session"
}`;

  const responseText = await callClaudeText({
    model: MODELS.cheap,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 2048,
  });

  interface WorkoutResponse {
    exercises: Workout['exercises'];
    warmup?: string[];
    cooldown?: string[];
    coachingNotes?: string;
  }

  const data = parseJSON<WorkoutResponse>(responseText);

  if (!Array.isArray(data.exercises) || data.exercises.length === 0) {
    throw new Error('Generated workout has no exercises. Please regenerate.');
  }

  return {
    date: todayCheckIn.date,
    exercises: data.exercises,
    warmup: data.warmup,
    cooldown: data.cooldown,
    coachingNotes: data.coachingNotes,
    generatedAt: Date.now(),
  };
}

export type { FoodAnalysis };
