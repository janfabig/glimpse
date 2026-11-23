// Renderer-only build for UI snapshots: independent of the main/preload build, so a broken main
// process never blocks UI work. Output: .cache/ui-build (loaded by scripts/ui-harness/main.mjs).

import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = resolve(import.meta.dirname, '../..')

export const UI_BUILD_DIR = resolve(root, '.cache/ui-build')

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@renderer': resolve(root, 'src/renderer/src')
    }
  },
  build: {
    outDir: UI_BUILD_DIR,
    emptyOutDir: true,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2000
  },
  logLevel: 'warn'
})
