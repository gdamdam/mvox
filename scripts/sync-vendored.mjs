#!/usr/bin/env node
/**
 * Check or re-sync the tuning core vendored from the sibling mdrone repo.
 *
 * The canonical source is ../mdrone/src/tuning/{model,scala,builtins}.ts. Each
 * file is copied VERBATIM into src/vendor/tuning-core/, with a short credit
 * header prepended above a marker line. Everything BELOW the marker is
 * byte-identical to the upstream file; the checker compares only that region so
 * the (informational) header — which carries the source path, the upstream SHA
 * and the AGPL note — never trips a false "stale" result.
 *
 *   npm run vendored:check   # exit 1 if any copy is stale/missing (default)
 *   npm run vendored:sync    # re-copy from ../mdrone and re-stamp the headers
 *
 * Mirrors ../mbus/scripts/sync-vendored.mjs (which vendors the mbus client the
 * same way); the difference is that mbus keeps the credit header in a separate
 * per-repo index.ts, whereas here it rides atop each file behind the marker.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FILES = ['model.ts', 'scala.ts', 'builtins.ts']

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const upstreamDir = join(root, '..', 'mdrone', 'src', 'tuning')
const vendorDir = join(root, 'src', 'vendor', 'tuning-core')
const mode = process.argv.includes('--sync') ? 'sync' : 'check'
const note = (s) => console.log(s)

/** Short SHA of the upstream repo HEAD (best-effort; informational only). */
function upstreamSha() {
  try {
    return execFileSync('git', ['-C', join(root, '..', 'mdrone'), 'rev-parse', '--short', 'HEAD'])
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
}

/** The marker separating the credit header from the verbatim upstream body. */
function marker(file) {
  return `// @vendored:mdrone/src/tuning/${file}`
}

function header(file, sha) {
  return [
    '/**',
    ' * VENDORED — DO NOT EDIT BY HAND.',
    ` * Source: mdrone/src/tuning/${file} @ ${sha}`,
    ' * Copied verbatim from the sibling mdrone repo (same author). This file is',
    ' * licensed AGPL-3.0-or-later, identical to both repos. Refresh with',
    ' * `npm run vendored:sync`; CI guards drift with `npm run vendored:check`.',
    ' * Everything below the marker line is byte-identical to the upstream file.',
    ' */',
    marker(file),
    '',
    '',
  ].join('\n')
}

/** The verbatim upstream body of a vendored file (content after the marker). */
function bodyOf(file, text) {
  const m = marker(file)
  const idx = text.indexOf(m)
  if (idx < 0) return null
  // Skip the marker line and the single blank line the header adds after it.
  const afterMarker = text.slice(idx + m.length)
  return afterMarker.replace(/^\n\n/, '')
}

const sha = upstreamSha()
let failures = 0

if (!existsSync(upstreamDir)) {
  note(`✗ upstream ${upstreamDir} missing (mdrone not cloned as a sibling?)`)
  process.exit(1)
}

for (const file of FILES) {
  const upstreamPath = join(upstreamDir, file)
  const vendorPath = join(vendorDir, file)
  if (!existsSync(upstreamPath)) {
    note(`✗ upstream ${file} missing`)
    failures++
    continue
  }
  const upstream = readFileSync(upstreamPath, 'utf8')

  if (mode === 'sync') {
    writeFileSync(vendorPath, header(file, sha) + upstream)
    note(`↻ ${file} re-vendored @ ${sha}`)
    continue
  }

  if (!existsSync(vendorPath)) {
    note(`✗ ${file} missing under src/vendor/tuning-core/`)
    failures++
    continue
  }
  const body = bodyOf(file, readFileSync(vendorPath, 'utf8'))
  if (body === null) {
    note(`✗ ${file} has no vendor marker (regenerate with vendored:sync)`)
    failures++
  } else if (body === upstream) {
    note(`✓ ${file} in sync`)
  } else {
    note(`✗ ${file} DIFFERS from upstream`)
    failures++
  }
}

if (mode === 'check' && failures > 0) {
  note(`\n${failures} problem(s). Run \`npm run vendored:sync\` to refresh.`)
  process.exit(1)
}
note(mode === 'sync' ? '\nTuning core re-vendored.' : '\nTuning core in sync.')
