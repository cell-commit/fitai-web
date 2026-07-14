import type {
  CheckIn,
  Workout,
  FoodEntry,
  Settings,
  DayData,
  WeeklyProgram,
  SessionLog,
  LoggedExercise,
  ChatMessage,
  ChatMode,
  ProgressPhoto,
  HealthImportSummary,
} from '../types';
import { formatDate, getTodayDate } from '../utils/date';
import { kv as store } from './kv';

// Web port: small JSON app state lives in localStorage via the `kv` adapter
// (mirrors the RN AsyncStorage surface so the defensive get/save pattern below
// ports over near-verbatim). Blobs (photos, imported health files) do NOT go
// here — they live in IndexedDB via src/services/blobStore.ts.

// Local-time date helpers now live in ../utils/date (design doc §9.9 UTC fix).
// Re-exported here so callers importing from '../services/storage' keep working.
export { formatDate, getTodayDate };

const KEYS = {
  CHECK_INS: '@fitai/checkins',
  WORKOUTS: '@fitai/workouts',
  FOOD_ENTRIES: '@fitai/food_entries',
  SETTINGS: '@fitai/settings',
  // WP1 additions
  WEEKLY_PROGRAM: '@fitai/weekly_program',
  PROGRAM_ARCHIVE: '@fitai/program_archive',
  SESSION_LOGS: '@fitai/session_logs',
  CHAT_COACH: '@fitai/chat_coach',
  CHAT_NUTRITION: '@fitai/chat_nutrition',
  PHOTOS_META: '@fitai/photos_meta',
  HEALTH_SUMMARIES: '@fitai/health_summaries',
  EXERCISE_MATCH_CACHE: '@fitai/exercise_match_cache',
};

// Caps (design doc §3)
const PROGRAM_ARCHIVE_CAP = 12;
const CHAT_CAP = 200;
const HEALTH_SUMMARY_CAP = 6;

const DEFAULT_SETTINGS: Settings = {
  calorieTarget: 2000,
  proteinTarget: 150,
  name: '',
};

/** Normalize an exercise name for slug/name matching (lowercase, collapse space). */
function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function formatDisplayDate(dateStr: string): string {
  const date = new Date(dateStr + 'T12:00:00');
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function formatShortDate(dateStr: string): string {
  const date = new Date(dateStr + 'T12:00:00');
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

// Settings

export async function getSettings(): Promise<Settings> {
  try {
    const data = await store.getItem(KEYS.SETTINGS);
    return data ? { ...DEFAULT_SETTINGS, ...JSON.parse(data) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await store.setItem(KEYS.SETTINGS, JSON.stringify(settings));
}

// Check-ins

async function getAllCheckIns(): Promise<Record<string, CheckIn>> {
  try {
    const data = await store.getItem(KEYS.CHECK_INS);
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

export async function saveCheckIn(checkIn: CheckIn): Promise<void> {
  const all = await getAllCheckIns();
  all[checkIn.date] = checkIn;
  await store.setItem(KEYS.CHECK_INS, JSON.stringify(all));
}

export async function getCheckIn(date: string): Promise<CheckIn | null> {
  const all = await getAllCheckIns();
  return all[date] ?? null;
}

// Workouts

async function getAllWorkouts(): Promise<Record<string, Workout>> {
  try {
    const data = await store.getItem(KEYS.WORKOUTS);
    return data ? JSON.parse(data) : {};
  } catch {
    return {};
  }
}

export async function saveWorkout(workout: Workout): Promise<void> {
  const all = await getAllWorkouts();
  all[workout.date] = workout;
  await store.setItem(KEYS.WORKOUTS, JSON.stringify(all));
}

export async function getWorkout(date: string): Promise<Workout | null> {
  const all = await getAllWorkouts();
  return all[date] ?? null;
}

// Food entries

async function getAllFoodEntries(): Promise<FoodEntry[]> {
  try {
    const data = await store.getItem(KEYS.FOOD_ENTRIES);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export async function getFoodEntriesForDate(date: string): Promise<FoodEntry[]> {
  const all = await getAllFoodEntries();
  return all
    .filter((e) => e.date === date)
    .sort((a, b) => a.timestamp - b.timestamp);
}

export async function saveFoodEntry(entry: FoodEntry): Promise<void> {
  const all = await getAllFoodEntries();
  all.push(entry);
  await store.setItem(KEYS.FOOD_ENTRIES, JSON.stringify(all));
}

export async function deleteFoodEntry(id: string): Promise<void> {
  const all = await getAllFoodEntries();
  const filtered = all.filter((e) => e.id !== id);
  await store.setItem(KEYS.FOOD_ENTRIES, JSON.stringify(filtered));
}

// History

export async function getHistory(days: number = 30): Promise<DayData[]> {
  const [allCheckIns, allWorkouts, allFood] = await Promise.all([
    getAllCheckIns(),
    getAllWorkouts(),
    getAllFoodEntries(),
  ]);

  const foodByDate: Record<string, FoodEntry[]> = {};
  allFood.forEach((entry) => {
    if (!foodByDate[entry.date]) foodByDate[entry.date] = [];
    foodByDate[entry.date].push(entry);
  });

  const dates = new Set<string>([
    ...Object.keys(allCheckIns),
    ...Object.keys(allWorkouts),
    ...Object.keys(foodByDate),
  ]);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = formatDate(cutoff);

  return Array.from(dates)
    .filter((d) => d >= cutoffStr)
    .sort((a, b) => b.localeCompare(a))
    .map((date) => ({
      date,
      checkIn: allCheckIns[date],
      workout: allWorkouts[date],
      foodEntries: (foodByDate[date] ?? []).sort((a, b) => a.timestamp - b.timestamp),
    }));
}

export async function getRecentHistory(days: number = 7): Promise<DayData[]> {
  const today = getTodayDate();
  const history = await getHistory(days + 1);
  return history.filter((d) => d.date !== today).slice(0, days);
}

// ─────────────────────────────────────────────────────────────
// WP1 — weekly program
// ─────────────────────────────────────────────────────────────

export async function getWeeklyProgram(): Promise<WeeklyProgram | null> {
  try {
    const data = await store.getItem(KEYS.WEEKLY_PROGRAM);
    return data ? (JSON.parse(data) as WeeklyProgram) : null;
  } catch {
    return null;
  }
}

/**
 * Persist the current weekly program. If a different week was previously
 * current, it is pushed onto the archive (capped at 12, oldest dropped).
 */
export async function saveWeeklyProgram(program: WeeklyProgram): Promise<void> {
  const existing = await getWeeklyProgram();
  if (existing && existing.weekStart !== program.weekStart) {
    await archiveProgram(existing);
  }
  await store.setItem(KEYS.WEEKLY_PROGRAM, JSON.stringify(program));
}

export async function getProgramArchive(): Promise<WeeklyProgram[]> {
  try {
    const data = await store.getItem(KEYS.PROGRAM_ARCHIVE);
    return data ? (JSON.parse(data) as WeeklyProgram[]) : [];
  } catch {
    return [];
  }
}

async function archiveProgram(program: WeeklyProgram): Promise<void> {
  const archive = await getProgramArchive();
  // Most-recent first; replace any same-week entry.
  const filtered = archive.filter((p) => p.weekStart !== program.weekStart);
  filtered.unshift(program);
  const capped = filtered.slice(0, PROGRAM_ARCHIVE_CAP);
  await store.setItem(KEYS.PROGRAM_ARCHIVE, JSON.stringify(capped));
}

// ─────────────────────────────────────────────────────────────
// WP1 — session logs
// ─────────────────────────────────────────────────────────────

async function getAllSessionLogs(): Promise<SessionLog[]> {
  try {
    const data = await store.getItem(KEYS.SESSION_LOGS);
    return data ? (JSON.parse(data) as SessionLog[]) : [];
  } catch {
    return [];
  }
}

export async function saveSessionLog(log: SessionLog): Promise<void> {
  const all = await getAllSessionLogs();
  const idx = all.findIndex((l) => l.id === log.id);
  if (idx >= 0) {
    all[idx] = log;
  } else {
    all.push(log);
  }
  await store.setItem(KEYS.SESSION_LOGS, JSON.stringify(all));
}

/** All session logs, newest first (for the Progress → History list). */
export async function listSessionLogs(): Promise<SessionLog[]> {
  const all = await getAllSessionLogs();
  return [...all].sort(
    (a, b) => b.date.localeCompare(a.date) || b.startedAt - a.startedAt
  );
}

/** Session logs within the last `days` days, newest first. */
export async function getSessionLogs(days: number = 14): Promise<SessionLog[]> {
  const all = await getAllSessionLogs();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = formatDate(cutoff);
  return all
    .filter((l) => l.date >= cutoffStr)
    .sort((a, b) => b.date.localeCompare(a.date) || b.startedAt - a.startedAt);
}

/**
 * Most recent logged instance of an exercise, matched by slug (preferred) or
 * normalized name. Returns null if never logged. Scans all history, newest
 * first, so "previous session" numbers survive across weeks.
 */
export async function getLastLoggedExercise(
  slugOrName: string
): Promise<LoggedExercise | null> {
  const all = await getAllSessionLogs();
  const sorted = [...all].sort(
    (a, b) => b.date.localeCompare(a.date) || b.startedAt - a.startedAt
  );
  const target = normalizeName(slugOrName);
  for (const log of sorted) {
    for (const ex of log.exercises) {
      if (
        (ex.slug && ex.slug === slugOrName) ||
        normalizeName(ex.name) === target
      ) {
        return ex;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// WP1 — chat threads (coach + nutrition), capped 200 each
// ─────────────────────────────────────────────────────────────

function chatKey(mode: ChatMode): string {
  return mode === 'coach' ? KEYS.CHAT_COACH : KEYS.CHAT_NUTRITION;
}

export async function getChatMessages(mode: ChatMode): Promise<ChatMessage[]> {
  try {
    const data = await store.getItem(chatKey(mode));
    return data ? (JSON.parse(data) as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

/** Append a message to a thread; trims oldest beyond the 200-message cap. */
export async function appendChatMessage(message: ChatMessage): Promise<void> {
  const all = await getChatMessages(message.mode);
  all.push(message);
  const capped = all.slice(-CHAT_CAP);
  await store.setItem(chatKey(message.mode), JSON.stringify(capped));
}

export async function saveChatMessages(
  mode: ChatMode,
  messages: ChatMessage[]
): Promise<void> {
  const capped = messages.slice(-CHAT_CAP);
  await store.setItem(chatKey(mode), JSON.stringify(capped));
}

// ─────────────────────────────────────────────────────────────
// WP1 — progress photo metadata (blobs live in IndexedDB / blobStore)
// ─────────────────────────────────────────────────────────────

export async function getPhotos(): Promise<ProgressPhoto[]> {
  try {
    const data = await store.getItem(KEYS.PHOTOS_META);
    return data ? (JSON.parse(data) as ProgressPhoto[]) : [];
  } catch {
    return [];
  }
}

export async function savePhoto(photo: ProgressPhoto): Promise<void> {
  const all = await getPhotos();
  const idx = all.findIndex((p) => p.id === photo.id);
  if (idx >= 0) {
    all[idx] = photo;
  } else {
    all.push(photo);
  }
  await store.setItem(KEYS.PHOTOS_META, JSON.stringify(all));
}

export async function deletePhoto(id: string): Promise<void> {
  const all = await getPhotos();
  await store.setItem(
    KEYS.PHOTOS_META,
    JSON.stringify(all.filter((p) => p.id !== id))
  );
}

// ─────────────────────────────────────────────────────────────
// WP1 — health import summaries, capped 6
// ─────────────────────────────────────────────────────────────

export async function getHealthSummaries(): Promise<HealthImportSummary[]> {
  try {
    const data = await store.getItem(KEYS.HEALTH_SUMMARIES);
    return data ? (JSON.parse(data) as HealthImportSummary[]) : [];
  } catch {
    return [];
  }
}

/** Save a summary (most recent first), capped at 6. */
export async function saveHealthSummary(
  summary: HealthImportSummary
): Promise<void> {
  const all = await getHealthSummaries();
  all.unshift(summary);
  const capped = all.slice(0, HEALTH_SUMMARY_CAP);
  await store.setItem(KEYS.HEALTH_SUMMARIES, JSON.stringify(capped));
}

export async function getLatestHealthSummary(): Promise<HealthImportSummary | null> {
  const all = await getHealthSummaries();
  return all[0] ?? null;
}

export async function deleteHealthSummary(id: string): Promise<void> {
  const all = await getHealthSummaries();
  await store.setItem(
    KEYS.HEALTH_SUMMARIES,
    JSON.stringify(all.filter((s) => s.id !== id))
  );
}

// ─────────────────────────────────────────────────────────────
// WP1 — exercise-name → slug match cache
// ─────────────────────────────────────────────────────────────

export async function getExerciseMatchCache(): Promise<
  Record<string, string | null>
> {
  try {
    const data = await store.getItem(KEYS.EXERCISE_MATCH_CACHE);
    return data ? (JSON.parse(data) as Record<string, string | null>) : {};
  } catch {
    return {};
  }
}

export async function setExerciseMatch(
  normalizedName: string,
  slug: string | null
): Promise<void> {
  const cache = await getExerciseMatchCache();
  cache[normalizedName] = slug;
  await store.setItem(KEYS.EXERCISE_MATCH_CACHE, JSON.stringify(cache));
}
