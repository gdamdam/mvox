import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import packageJson from './package.json' with { type: 'json' }

// Emit a precache-manifest.json listing hashed build assets so the hand-written
// service worker can precache the exact chunks Vite produced this build.
function precacheManifest(): Plugin {
  return {
    name: 'mvox-precache-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((f) => !f.endsWith('.html') && f !== 'precache-manifest.json')
        .sort()
      this.emitFile({
        type: 'asset',
        fileName: 'precache-manifest.json',
        source: JSON.stringify(assets),
      })
    },
  }
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  define: { __APP_VERSION__: JSON.stringify(packageJson.version) },
  plugins: [react(), precacheManifest()],
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
})
