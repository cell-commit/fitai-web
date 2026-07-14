# FitAI — Setup Guide

FitAI is your personal training app: a weekly Push/Pull/Full-Body program that
Claude generates and adapts for you, an in-app coach you can chat with (it edits
your program *and* your canonical training files on Google Drive — the same
"shared brain" the Claude Code `training` skill uses), workout logging with
exercise images and per-set reps/weight, progress photos with AI feedback, Apple
Health imports, and nutrition guidance. It runs entirely in your browser and
stores everything on your device; nothing lives on a server we run.

The web address, once deployed, is:

> **https://&lt;owner&gt;.github.io/fitai-web/**

(`<owner>` is the GitHub account the repo is pushed under — the URL is final once
that's decided.)

---

## 1. Install it on your iPhone (one time, ~1 minute)

1. Open **https://&lt;owner&gt;.github.io/fitai-web/** in **Safari** (it must be
   Safari, not Chrome, for "Add to Home Screen" to work properly on iOS).
2. Tap the **Share** button (the square with an up-arrow, at the bottom).
3. Scroll down and tap **Add to Home Screen**, then **Add**.
4. Close Safari and open FitAI from the **new icon** on your home screen. From
   now on it runs full-screen like a normal app and works offline at the gym.

---

## 2. Add your Anthropic API key (one time)

The coach and photo feedback use Claude. Your key stays **only on your phone**
(in the app's local storage) — it is never uploaded or shared.

1. Get a key at **https://console.anthropic.com/settings/keys** → *Create Key* →
   copy it (starts with `sk-ant-`).
2. In FitAI, tap **More → Settings**.
3. Paste the key into **Anthropic API key**.
4. Tap **Save Settings**.

---

## 3. Connect Google Drive sync (one time, ~10 minutes)

This links the app to your three training files on Drive
(`training-status.md`, `training-history-log.md`, `CLAUDE.md`) so the coach and
your Claude Code `training` skill stay in sync.

Follow the step-by-step guide here: **[docs/apps-script/README.md](docs/apps-script/README.md)**.
It walks you (no coding needed) through deploying a small Google Apps Script and
gives you two things to paste into **More → Settings**:

- **Apps Script URL** (ends in `/exec`)
- **Sync token** (the secret string you created)

Then tap **Save Settings** → **Test connection**. You should see the three files
listed with their last-modified times.

---

## 4. Optional — Apple Health imports

To pull in health data (sleep, weight, activity), install **Health Auto Export**
from the App Store, export a JSON or CSV, then in FitAI go to
**More → Health Import** and choose the file. The coach uses a short summary of
it for context.

---

## How updates work

You don't update anything manually. Every time the code is pushed to `main`,
GitHub automatically rebuilds and redeploys the app. Next time you open FitAI (or
while it's open), a small **"App updated — reload"** toast appears near the
bottom — tap **Reload** to get the new version. That's it.

---

## For the developer (Claude / whoever maintains it)

Prerequisites: Node 20+ (CI uses 22).

```bash
npm install        # install dependencies
npm run dev        # local dev server at http://localhost:5173/ (base = '/')
npm test           # run the vitest suite once
npm run typecheck  # tsc --noEmit
npm run build      # production build into dist/ (base = '/')
```

Deploy is automatic: **push to `main`** → the workflow in
`.github/workflows/deploy.yml` runs typecheck + tests, builds with the Pages base
path, and publishes to GitHub Pages.

The GitHub Pages base path lives in exactly one place — the `GHPAGES_BASE`
environment variable in the build step of that workflow (currently
`/fitai-web/`). `vite.config.ts` reads it (`process.env.GHPAGES_BASE ?? '/'`), so
local dev/preview stay at root while the deployed build is served under the repo
path. If the repo is ever renamed, change `GHPAGES_BASE` there and nowhere else.

Pages has no server-side SPA rewrite, so the build also emits a `404.html` copy
of `index.html` (see the `spa-fallback-404` plugin in `vite.config.ts`) to make
deep links and hard refreshes load the app.
