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

// Logging

export interface LoggedSet {
  reps: number;
  weightKg: number;
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
  date: string;
  focus: DayFocus;
  exercises: LoggedExercise[];
  startedAt: number;
  completedAt?: number;
  feedback?: string;
  syncedToDrive: boolean;
}

// Chat

export type ChatMode = 'coach' | 'nutrition';

export interface ChatToolEvent {
  tool: string;
  summary: string; // for UI chips: "Updated Wed plan"
}

export interface ChatMessage {
  id: string;
  mode: ChatMode;
  role: 'user' | 'assistant';
  text: string;
  toolEvents?: ChatToolEvent[];
  timestamp: number;
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
