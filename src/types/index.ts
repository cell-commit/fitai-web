export interface CheckIn {
  date: string;
  soreness: number;
  energy: number;
  sleep: number;
  notes: string;
  timestamp: number;
}

export interface Exercise {
  name: string;
  sets: number;
  reps: string;
  weight?: string;
  notes?: string;
}

export interface Workout {
  date: string;
  exercises: Exercise[];
  warmup?: string[];
  cooldown?: string[];
  coachingNotes?: string;
  generatedAt: number;
}

export interface FoodEntry {
  id: string;
  date: string;
  mealName: string;
  description: string;
  calories: number;
  protein: number;
  timestamp: number;
  imageUri?: string;
}

export interface Settings {
  calorieTarget: number;
  proteinTarget: number;
  name: string;
  // Anthropic API key — entered once in Settings, stored in localStorage on the
  // device (web port; never bundled). Used by src/services/claude.ts.
  anthropicApiKey?: string;
  appsScriptUrl?: string;
  appsScriptToken?: string;
  // ── Session UX upgrades (WP-0 foundations) ──
  // All optional so stored settings need no migration; DEFAULT_SETTINGS in
  // storage.ts supplies the values and getSettings() spreads defaults first.
  /** Rest-timer default length in seconds (rest timer between sets). */
  restDefaultSec?: number;
  /** Play the best-effort rest-end sound (silent switch may still mute it). */
  restSoundEnabled?: boolean;
  /** Show the "start your Apple Watch workout" nudge on a fresh session. */
  watchReminderEnabled?: boolean;
}

export interface DayData {
  date: string;
  checkIn?: CheckIn;
  workout?: Workout;
  foodEntries: FoodEntry[];
}

// ─────────────────────────────────────────────────────────────
// WP1 additions — weekly adaptive program, session logging,
// coach chat, progress photos, health import. All additive;
// existing types above are untouched.
// ─────────────────────────────────────────────────────────────

// Program

export type DayFocus =
  | 'push'
  | 'pull'
  | 'fullbody'
  | 'legs'
  | 'upper'
  | 'cardio'
  | 'rest';

export interface ProgramExercise {
  name: string;
  slug?: string; // exercise-db id
  sets: number;
  repRange: string; // e.g. "12-15"
  targetWeight?: string;
  notes?: string;
  /**
   * Prescribed tempo in the standard 4-digit notation — eccentric / pause /
   * concentric / pause in seconds, e.g. "4030" (4s down, no pause, 3s up… ) or
   * "2010". Optional and only set where it matters (rehab, control work, a lift
   * he rushes); surfaced with `notes` in the COACH TIPS block at the top of the
   * in-gym exercise page.
   */
  tempo?: string;
}

export interface ProgramDay {
  date: string;
  focus: DayFocus;
  title: string;
  exercises: ProgramExercise[];
  coachNotes?: string;
  status: 'planned' | 'done' | 'skipped' | 'amended';
}

export interface WeeklyProgram {
  weekStart: string; // Monday, YYYY-MM-DD
  days: ProgramDay[];
  generatedAt: number;
  revision: number;
  rationale?: string;
}

// ─────────────────────────────────────────────────────────────
// Program safety-review gate (independent reviewer before a program
// change reaches Jason). A proposed change is never applied silently:
// it is staged as a PendingProgram for explicit approval.
// ─────────────────────────────────────────────────────────────

export interface ReviewConcern {
  severity: 'must_fix' | 'caution';
  /** What is wrong (one line, plain language). */
  issue: string;
  /** Concrete suggested fix. */
  suggestion: string;
}

export interface ReviewVerdict {
  approved: boolean;
  /** One-line, user-facing summary of the review. */
  summary: string;
  concerns: ReviewConcern[];
}

/** Marker used when the review call itself failed (fail-open, but loud). */
export interface UnreviewedMarker {
  status: 'unreviewed';
}

export interface PendingProgram {
  /** The proposed week awaiting approval (never yet the active program). */
  program: WeeklyProgram;
  /** Reviewer verdict, or an unreviewed marker when the review was unavailable. */
  review: ReviewVerdict | UnreviewedMarker;
  proposedAt: number;
  source: 'generate' | 'amend' | 'coach';
  /** True when the reviewer's must-fix concerns triggered a revision pass. */
  revisedByReviewer: boolean;
}

// Logging

export interface LoggedSet {
  reps: number;
  weightKg: number;
  /**
   * Explicit per-set ✓ (session UX upgrades). Optional and backwards-compatible:
   * historical sets have no `done` flag, so isSetDone() falls back to reps > 0.
   * A set marked done is the commit point for the rest timer, weight
   * fill-forward and placeholder materialisation.
   */
  done?: boolean;
}

export interface LoggedExercise {
  name: string;
  slug?: string;
  targetSets: number;
  targetRepRange: string;
  sets: LoggedSet[];
  note?: string;
}

export interface SessionLog {
  id: string;
  /** Actual calendar date the session was performed (YYYY-MM-DD). */
  date: string;
  focus: DayFocus;
  exercises: LoggedExercise[];
  startedAt: number;
  completedAt?: number;
  feedback?: string;
  syncedToDrive: boolean;
  /**
   * The program day this session fulfilled, when it differs from `date` — e.g.
   * performing Wednesday's planned "Pull" on Thursday. Absent when the session
   * was performed on its own planned day (the common case).
   */
  programDate?: string;
}

// Chat

export type ChatMode = 'coach' | 'nutrition';

export interface ChatToolEvent {
  tool: string;
  summary: string; // for UI chips: "Updated Wed plan"
}

/**
 * An image attached to a coach-chat message (chat photo attachments upgrade).
 * The thread holds references only — the blob itself lives in IndexedDB under
 * `blobKey`, so localStorage never carries image bytes.
 */
export interface ChatAttachment {
  id: string;
  /** blobStore key, e.g. `chat/<id>`. */
  blobKey: string;
  /** MIME type of the stored blob, e.g. 'image/jpeg'. */
  mediaType: string;
  width?: number;
  height?: number;
}

export interface ChatMessage {
  id: string;
  mode: ChatMode;
  role: 'user' | 'assistant';
  text: string;
  toolEvents?: ChatToolEvent[];
  timestamp: number;
  /** Images attached to this message (chat photo attachments upgrade). */
  attachments?: ChatAttachment[];
  /**
   * Set on an assistant turn that hit the output-token cap mid-answer. The text
   * that WAS generated is kept (never discarded); the flag is what lets the UI
   * offer "Continue" and lets the next send tell the model to resume instead of
   * restarting. Optional so existing stored threads need no migration.
   */
  truncated?: boolean;
}

// Photos

export interface ProgressPhoto {
  id: string;
  takenAt: number;
  // Web port: the image blob lives in IndexedDB (see src/services/blobStore.ts).
  // fileUri holds the blob key (later WPs may also cache an object-URL here).
  fileUri: string;
  mediaLibraryAssetId?: string;
  note?: string;
}

// Health

export interface HealthImportSummary {
  id: string;
  importedAt: number;
  source: 'health-auto-export-json' | 'health-auto-export-csv';
  dateRange: { from: string; to: string };
  days: Array<{
    date: string;
    sleepHours?: number;
    steps?: number;
    activeKcal?: number;
    restingHR?: number;
    workouts: Array<{ name: string; minutes: number; kcal?: number }>;
  }>;
  summaryText: string; // ≤1KB, for coach context
}
