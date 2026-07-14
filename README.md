# FitAI

Personal adaptive training coach — a mobile-first PWA (Vite + React 19 +
TypeScript). Weekly Push/Pull/Full-Body program generated and amended by Claude,
in-app coach chat that mutates the program and your canonical Google Drive
training files, workout logging with exercise images, progress photos with AI
vision feedback, Apple Health imports, and nutrition guidance. All data lives on
the device; the Anthropic API key and Drive sync token are entered on-device in
Settings (no secrets are bundled or served).

## Setup & phone install

See **[SETUP.md](SETUP.md)** — written for the end user: Add to Home Screen,
paste the Anthropic API key, deploy the Drive sync bridge
(**[docs/apps-script/README.md](docs/apps-script/README.md)**), optional Apple
Health import, and how automatic updates work.

## Development

```bash
npm install        # install dependencies
npm run dev        # dev server at http://localhost:5173/  (base '/')
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # production build → dist/
```

## Deploy

Push to `main`. The workflow in `.github/workflows/deploy.yml` runs typecheck +
tests, builds with the GitHub Pages base path
(`GHPAGES_BASE=/fitai-web/`, the single source of truth for the repo path), and
publishes to GitHub Pages at `https://<owner>.github.io/fitai-web/`.
