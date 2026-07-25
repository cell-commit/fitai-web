/// <reference types="vitest/config" />
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Read the app version from package.json so it can be surfaced in the UI
// (Settings → About) without hard-coding it in two places.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')
) as { version: string };

// GitHub Pages serves the app under /<repo>/. The deploy workflow sets
// GHPAGES_BASE (e.g. '/fitai-web/'); local dev/preview default to root so
// `npm run dev` keeps working at http://localhost:5173/. The repo name is thus
// only written once — in the workflow — not baked into this file.
const base = process.env.GHPAGES_BASE ?? '/';

// GitHub Pages has no server-side SPA rewrite: a deep link or hard refresh to a
// non-root path 404s. Pages serves 404.html for any unknown path, so shipping a
// byte-for-byte copy of the built index.html as 404.html makes the SPA load
// from any URL.
function spaFallback404(): Plugin {
  return {
    name: 'spa-fallback-404',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const indexPath = fileURLToPath(new URL('./dist/index.html', import.meta.url));
      const fallbackPath = fileURLToPath(new URL('./dist/404.html', import.meta.url));
      if (!existsSync(indexPath)) return;
      writeFileSync(fallbackPath, readFileSync(indexPath, 'utf8'));
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  base,
  define: {
    // Surfaced in Settings → About. JSON.stringify so it's a string literal.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    VitePWA({
      // 'prompt' so a waiting update surfaces a reload toast (useRegisterSW's
      // onNeedRefresh) rather than silently hot-swapping the app mid-session.
      registerType: 'prompt',
      includeAssets: ['icon.svg'],
      // manifest scope/start_url are intentionally left unset so vite-plugin-pwa
      // derives them from Vite `base` — correct for both root dev and the
      // /fitai-web/ Pages build.
      manifest: {
        name: 'FitAI',
        short_name: 'FitAI',
        description: 'Personal adaptive training coach',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#0F172A',
        background_color: '#0F172A',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // Serve the SPA shell for any navigation that isn't precached (deep
        // links, hard refreshes). vite-plugin-pwa prefixes this with `base`.
        navigateFallback: 'index.html',
        // Keep the fallback away from the Apps Script sync + Anthropic API.
        navigateFallbackDenylist: [/script\.google\.com/, /api\.anthropic\.com/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Exercise images from the jsDelivr CDN — cache-first so gym
            // sessions work fully offline after the first view.
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'exercise-images',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
    spaFallback404(),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
