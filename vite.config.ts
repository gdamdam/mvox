import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import packageJson from './package.json' with { type: 'json' }

// Emit a precache-manifest.json listing hashed build assets so the hand-written
// service worker can precache the exact chunks Vite produced this build, and stamp
// a per-build version into public/sw.js. The stamp is essential: browsers reinstall
// a service worker only when its script bytes differ, but sw.js is copied verbatim
// from public/ every build. Injecting a hash of the (content-hashed) asset list
// changes sw.js on every deploy that changes any chunk, so install()/precache()
// actually re-runs and the newest chunks get cached instead of only the first-ever set.
function precacheManifest(): Plugin {
  let outDir = 'dist'
  let swVersion = 'dev'
  return {
    name: 'mvox-precache-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((f) => !f.endsWith('.html') && f !== 'precache-manifest.json')
        .sort()
      const source = JSON.stringify(assets)
      // Hash the hashed-asset list: it changes iff a chunk's content changed.
      swVersion = createHash('sha256').update(source).digest('hex').slice(0, 12)
      this.emitFile({
        type: 'asset',
        fileName: 'precache-manifest.json',
        source,
      })
    },
    // Vite copies public/ into outDir at renderStart (order: pre), so the verbatim
    // sw.js is on disk by closeBundle; patch its version token in place there.
    async closeBundle() {
      const swPath = path.join(outDir, 'sw.js')
      try {
        const contents = await readFile(swPath, 'utf8')
        await writeFile(swPath, contents.replaceAll('__SW_VERSION__', swVersion))
      } catch {
        // No sw.js emitted (e.g. copyPublicDir disabled); nothing to version.
      }
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
