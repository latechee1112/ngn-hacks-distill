import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

// Builds the side panel UI (dist/sidepanel.html + assets).
// Run alongside vite.background.config.ts and vite.content.config.ts — see `npm run build`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // All three extension bundles share dist/. Production builds opt into
    // cleaning via the CLI; watch builds must preserve sibling bundles.
    emptyOutDir: false,
    // sidepanel.html and calibration.html share a chunk, so Vite emits a
    // <link rel="modulepreload"> for it. An extension page loads in an isolated
    // world where Chrome refuses that preload ("cross-world extension resource
    // mismatch") and warns on every open; the chunk is then fetched normally by the
    // import anyway. Two small pages — dropping the preload costs nothing.
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, 'sidepanel.html'),
        calibration: resolve(import.meta.dirname, 'calibration.html'),
      },
    },
  },
})
