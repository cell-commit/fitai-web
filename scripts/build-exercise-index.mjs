// Build a slim exercise index from the free-exercise-db (yuhonas).
//
// Fetches the full dataset (~870 entries) and emits src/data/exercise-index.json
// keeping only the fields the app needs: { id, name, equipment, primaryMuscles,
// image }. `image` is the FIRST image path only (e.g. "Barbell_Squat/0.jpg");
// the app builds the CDN URL with buildImageUrl() in src/services/exerciseDb.ts:
//   https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/exercises/<image>
//
// Run from the repo root:  node scripts/build-exercise-index.mjs
// The generated JSON is committed to the tree (design doc §4).

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL =
  'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../src/data/exercise-index.json');

async function main() {
  console.log(`Fetching ${SOURCE_URL} …`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }
  const raw = await res.json();
  if (!Array.isArray(raw)) {
    throw new Error('Unexpected dataset shape — expected an array.');
  }

  const index = raw.map((e) => ({
    id: e.id,
    name: e.name,
    equipment: e.equipment ?? null,
    primaryMuscles: Array.isArray(e.primaryMuscles) ? e.primaryMuscles : [],
    image: Array.isArray(e.images) && e.images.length > 0 ? e.images[0] : null,
  }));

  // Stable ordering by id so diffs stay small across rebuilds.
  index.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(index, null, 0) + '\n', 'utf-8');

  console.log(`Wrote ${index.length} entries → ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
