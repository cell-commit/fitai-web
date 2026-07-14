import { describe, it, expect, beforeEach } from 'vitest';
import {
  getWeeklyProgram,
  saveWeeklyProgram,
  getProgramArchive,
  saveSessionLog,
  getSessionLogs,
  getLastLoggedExercise,
  appendChatMessage,
  getChatMessages,
  savePhoto,
  getPhotos,
  deletePhoto,
  saveHealthSummary,
  getHealthSummaries,
  getLatestHealthSummary,
  setExerciseMatch,
  getExerciseMatchCache,
  getSettings,
  saveSettings,
  formatDate,
} from '../storage';
import type {
  WeeklyProgram,
  SessionLog,
  ChatMessage,
  ProgressPhoto,
  HealthImportSummary,
} from '../../types';

beforeEach(() => {
  localStorage.clear();
});

function makeProgram(weekStart: string): WeeklyProgram {
  return {
    weekStart,
    days: [],
    generatedAt: Date.now(),
    revision: 1,
  };
}

function makeSession(date: string, weightKg: number): SessionLog {
  return {
    id: `s-${date}`,
    date,
    focus: 'push',
    exercises: [
      {
        name: 'Bench Press',
        slug: 'Barbell_Bench_Press',
        targetSets: 3,
        targetRepRange: '8-10',
        sets: [{ reps: 10, weightKg }],
      },
    ],
    startedAt: Date.now(),
    syncedToDrive: false,
  };
}

describe('weekly program', () => {
  it('round-trips the current program', async () => {
    const p = makeProgram('2026-03-16');
    await saveWeeklyProgram(p);
    expect(await getWeeklyProgram()).toEqual(p);
  });

  it('archives the prior week when a new week is saved, capped at 12', async () => {
    // Save 14 distinct weeks; each new one archives the prior current.
    for (let i = 0; i < 14; i++) {
      const monday = `2026-01-${String(6 + i * 7).padStart(2, '0')}`;
      await saveWeeklyProgram(makeProgram(monday));
    }
    const archive = await getProgramArchive();
    expect(archive.length).toBe(12);
    // Newest archived entry is first.
    expect(archive[0].weekStart > archive[1].weekStart).toBe(true);
  });
});

describe('session logs', () => {
  it('round-trips and filters by day window', async () => {
    const today = new Date();
    const recent = formatDate(today);
    const old = new Date();
    old.setDate(old.getDate() - 40);
    const oldStr = formatDate(old);

    await saveSessionLog(makeSession(recent, 40));
    await saveSessionLog(makeSession(oldStr, 30));

    const within14 = await getSessionLogs(14);
    expect(within14.map((l) => l.date)).toEqual([recent]);

    const within60 = await getSessionLogs(60);
    expect(within60.length).toBe(2);
    // Newest first.
    expect(within60[0].date).toBe(recent);
  });

  it('getLastLoggedExercise returns the most recent matching exercise', async () => {
    const older = new Date();
    older.setDate(older.getDate() - 5);
    const newer = new Date();
    await saveSessionLog(makeSession(formatDate(older), 30));
    await saveSessionLog(makeSession(formatDate(newer), 45));

    const bySlug = await getLastLoggedExercise('Barbell_Bench_Press');
    expect(bySlug?.sets[0].weightKg).toBe(45);

    const byName = await getLastLoggedExercise('bench press');
    expect(byName?.sets[0].weightKg).toBe(45);

    expect(await getLastLoggedExercise('nonexistent')).toBeNull();
  });
});

describe('chat threads', () => {
  it('appends and caps each thread at 200 messages', async () => {
    for (let i = 0; i < 205; i++) {
      const msg: ChatMessage = {
        id: `m-${i}`,
        mode: 'coach',
        role: 'user',
        text: `msg ${i}`,
        timestamp: i,
      };
      await appendChatMessage(msg);
    }
    const coach = await getChatMessages('coach');
    expect(coach.length).toBe(200);
    // Oldest trimmed; newest kept.
    expect(coach[coach.length - 1].id).toBe('m-204');
    expect(coach[0].id).toBe('m-5');
    // Nutrition thread is separate and untouched.
    expect(await getChatMessages('nutrition')).toEqual([]);
  });
});

describe('progress photos', () => {
  it('saves, lists, and deletes photo metadata', async () => {
    const photo: ProgressPhoto = {
      id: 'p1',
      takenAt: 1,
      fileUri: 'blob-key-p1',
    };
    await savePhoto(photo);
    expect(await getPhotos()).toEqual([photo]);
    await deletePhoto('p1');
    expect(await getPhotos()).toEqual([]);
  });
});

describe('health summaries', () => {
  it('caps at 6, newest first', async () => {
    for (let i = 0; i < 8; i++) {
      const s: HealthImportSummary = {
        id: `h-${i}`,
        importedAt: i,
        source: 'health-auto-export-json',
        dateRange: { from: '2026-03-01', to: '2026-03-07' },
        days: [],
        summaryText: `summary ${i}`,
      };
      await saveHealthSummary(s);
    }
    const all = await getHealthSummaries();
    expect(all.length).toBe(6);
    expect(all[0].id).toBe('h-7'); // most recent first
    expect((await getLatestHealthSummary())?.id).toBe('h-7');
  });
});

describe('exercise match cache', () => {
  it('stores slug and null misses', async () => {
    await setExerciseMatch('rdl', 'Romanian_Deadlift');
    await setExerciseMatch('made up move', null);
    const cache = await getExerciseMatchCache();
    expect(cache['rdl']).toBe('Romanian_Deadlift');
    expect(cache['made up move']).toBeNull();
  });
});

describe('settings with Apps Script + API key fields', () => {
  it('round-trips appsScriptUrl, appsScriptToken and anthropicApiKey', async () => {
    await saveSettings({
      calorieTarget: 2200,
      proteinTarget: 180,
      name: 'Jason',
      anthropicApiKey: 'sk-ant-test',
      appsScriptUrl: 'https://example/exec',
      appsScriptToken: 'secret',
    });
    const s = await getSettings();
    expect(s.appsScriptUrl).toBe('https://example/exec');
    expect(s.appsScriptToken).toBe('secret');
    expect(s.anthropicApiKey).toBe('sk-ant-test');
    expect(s.name).toBe('Jason');
  });
});
