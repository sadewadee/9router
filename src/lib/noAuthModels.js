// Live model catalog for noAuth providers (e.g. OpenCode Free) so /v1/models can
// list models that never exist in the static registry. Server-side counterpart of
// the dashboard's suggested-models route: same `modelsFetcher` config and FILTERS,
// plus a timeout, TTL cache and stale fallback so an upstream outage can never
// break /v1/models.
import { FILTERS } from "../app/api/providers/suggested-models/filters.js";

const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FAILURE_BACKOFF_MS = 60 * 1000; // don't re-hit a failing upstream on every request
const cache = new Map(); // key: fetcher.url → { data, expiresAt } (data = last good list)
const inflight = new Map(); // key: fetcher.url → Promise, collapses concurrent cold fetches

async function fetchCatalog(fetcher, filter) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(fetcher.url, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    return filter(Array.isArray(raw) ? raw : []);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Live models for a provider's modelsFetcher ({ url, type }). Never throws:
 * on failure returns the last cached list, else [].
 * @param {{ url: string, type: string }} fetcher
 * @param {{ cacheOnly?: boolean }} [options] cacheOnly = never touch the network
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function fetchNoAuthModels(fetcher, { cacheOnly = false } = {}) {
  const filter = FILTERS[fetcher?.type];
  if (!fetcher?.url || !filter) return [];

  const cached = cache.get(fetcher.url);
  if (cacheOnly || (cached && Date.now() < cached.expiresAt)) return cached?.data ?? [];

  let pending = inflight.get(fetcher.url);
  if (!pending) {
    pending = fetchCatalog(fetcher, filter)
      .then((data) => {
        // An empty catalog means the upstream is broken, not that it has no models.
        if (data.length === 0) throw new Error("empty catalog");
        cache.set(fetcher.url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
        return data;
      })
      .catch((err) => {
        console.log(`noAuth models fetch failed for ${fetcher.url}: ${err?.message || err}`);
        const stale = cache.get(fetcher.url)?.data ?? [];
        cache.set(fetcher.url, { data: stale, expiresAt: Date.now() + FAILURE_BACKOFF_MS });
        return stale;
      })
      .finally(() => inflight.delete(fetcher.url));
    inflight.set(fetcher.url, pending);
  }
  return pending;
}
