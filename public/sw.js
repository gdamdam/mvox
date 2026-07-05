// Build-time token: the Vite precache plugin string-replaces __SW_VERSION__ with a
// hash of this build's hashed-asset list, so sw.js bytes change on every deploy that
// alters a chunk. That is what makes the browser reinstall the worker and re-run
// precache() post-deploy; without it install() fires only once, ever, and newly
// hashed chunks (e.g. the audio worklet, fetched only on start) never get cached.
// In dev the literal token is used verbatim, which is a fine static cache name.
const SW_VERSION = '__SW_VERSION__'
// Versioned cache names: activate() deletes any cache not matching the current
// names, so the prior deploy's shell/runtime caches are purged on activation.
const SHELL_CACHE = `mvox-shell-${SW_VERSION}`
// Runtime cache is additionally size-capped: within a single version, hashed bundles
// from many navigations can accumulate; trimming to a fixed budget bounds disk usage.
const RUNTIME_CACHE = `mvox-runtime-${SW_VERSION}`
const RUNTIME_MAX_ENTRIES = 64
const APP_BASE = new URL('./', self.location.href).pathname
const SHELL_URLS = [APP_BASE, `${APP_BASE}manifest.webmanifest`, `${APP_BASE}mvox-mark.svg`]

async function precache() {
  const cache = await caches.open(SHELL_CACHE)
  await cache.addAll(SHELL_URLS)
  // Precache the content-hashed build assets (JS/CSS/worklet) listed in the
  // generated manifest. The SW activates after the first visit's assets have
  // already loaded, so without this they would not be cached until re-requested,
  // leaving the first offline load broken. Best-effort: a missing manifest (dev
  // build) or fetch failure still leaves the shell cached and assets fall back to
  // the runtime cache-first handler below.
  try {
    const response = await fetch(`${APP_BASE}precache-manifest.json`, { cache: 'no-store' })
    if (response.ok) {
      const assets = await response.json()
      if (Array.isArray(assets)) {
        await cache.addAll(assets.map((path) => `${APP_BASE}${path}`))
      }
    }
  } catch {
    // Offline precache of hashed assets is best-effort; ignore failures.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache())
  // No skipWaiting(): the new worker must NOT take over tabs still running the
  // previous bundle. Activating early would purge the old version's caches while
  // an open tab may still lazily fetch its (now deleted, server-replaced) hashed
  // assets — e.g. the audio worklet is only fetched on Start, which would then
  // 404 mid-session. The new worker activates once the old tabs are gone.
})

self.addEventListener('activate', (event) => {
  // Keep claim() inside waitUntil so the browser can't terminate the worker
  // before old caches are purged and clients are claimed.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

// Drop the oldest entries until the cache is within budget. cache.keys() returns
// requests in insertion order, so the front of the list is the least recently
// added — delete from there.
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName)
  const keys = await cache.keys()
  for (let i = 0; i < keys.length - maxEntries; i += 1) {
    await cache.delete(keys[i])
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  if (new URL(request.url).origin !== self.location.origin) return

  // Network-first for navigations: a stale cached index.html points at hashed
  // asset URLs that no longer exist after a deploy, which renders a blank page.
  // Always try the network, refresh the cached shell, and fall back to cache offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            // Attach the cache refresh to the event so it isn't cut short if the
            // worker is stopped right after the response is delivered. Key on APP_BASE
            // (not request.url) so query'd navigations don't each spawn a distinct,
            // never-trimmed shell entry; there is exactly one shell copy, always the
            // freshest, which is also the entry the offline fallback below reads.
            const copy = response.clone()
            event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.put(APP_BASE, copy)))
          }
          return response
        })
        .catch(() => caches.match(request).then((cached) => cached ?? caches.match(APP_BASE))),
    )
    return
  }

  // Cache-first for everything else: built assets are content-hashed and immutable.
  // Check the precache (shell) first, then the runtime cache; on a network fetch,
  // store into the runtime cache and trim it back to RUNTIME_MAX_ENTRIES so past
  // releases' obsolete bundles can't grow it without bound.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (response.ok) {
          // waitUntil keeps the put + trim alive past respondWith so the cache
          // bound is actually enforced even if the worker is about to stop.
          const copy = response.clone()
          event.waitUntil(
            caches.open(RUNTIME_CACHE)
              .then((cache) => cache.put(request, copy))
              .then(() => trimCache(RUNTIME_CACHE, RUNTIME_MAX_ENTRIES)),
          )
        }
        return response
      })
    }),
  )
})
