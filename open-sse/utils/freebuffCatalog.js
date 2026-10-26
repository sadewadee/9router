// Freebuff model catalog (GET {FREEBUFF_API_BASE}/api/v1/freebuff/models — live base is
// https://www.codebuff.com), protocol of the official CLI 0.2.34 and Desktop 0.0.188. The
// response carries the routable model rows and a `fetchId` that chat and session calls must echo
// back (x-freebuff-catalog-fetch) and fold into the device-key signature. 9router registers the
// device key before the first request, so every catalog call goes out signed (the CLI's very
// first fetch is unsigned because it has no key yet).
//
// Response shape (zod H6L in the CLI, live-verified 2026-10-27): { protocol: 1, version,
// issuedAt, refreshAt, rows: [...], recommendedKey?, fallbackKey?, plansUrl, sections?, fetchId? }.
// Rows are gated by `opensAt` (Mg): only rows whose opensAt has passed are visible. Live rows are
// keyed "m-<10hex>" with "fbm1..." opaque handles — request model fields must come from these
// rows; the legacy fnv digest below is diagnostic only.

import { createHash } from "node:crypto";

// Live-verified (2026-10-27 probe): EVERY Freebuff API endpoint lives on www.codebuff.com —
// device-keys, models catalog, session/admission, chat and cloud-runs. freebuff.com is the
// landing page only (its /api/* answers 404 HTML). Override FREEBUFF_API_BASE to repoint the
// whole surface (read at module load, so a restart is enough).
export const FREEBUFF_API_BASE = (process.env.FREEBUFF_API_BASE || "https://www.codebuff.com").replace(/\/$/, "");
export const CATALOG_URL = `${FREEBUFF_API_BASE}/api/v1/freebuff/models`;
export const DEVICE_KEYS_URL = `${FREEBUFF_API_BASE}/api/v1/freebuff/device-keys`;

const CATALOG_PROTOCOL_HEADER = "x-freebuff-catalog-protocol";
const CATALOG_FETCH_HEADER = "x-freebuff-catalog-fetch";
const CLIENT_HEADER = "x-freebuff-client";

export const CLIENT_CLI = "cli";
export const CLIENT_DESKTOP = "desktop";

const DEFAULT_CATALOG_TTL_MS = 5 * 60_000;
const MIN_CATALOG_TTL_MS = 60_000;
const MAX_CATALOG_TTL_MS = 30 * 60_000;
const CATALOG_TIMEOUT_MS = 20_000;

export function tokenHashOf(token) {
  return createHash("sha1").update(String(token)).digest("hex");
}

// freebuffLegacyModelDigest (Desktop orchestrator.js line ~102784, verbatim): FNV-1a 32 plus a
// second variant, hex8 each. Verified: "z-ai/glm-5.3-flash" -> legacyDigest 197cbcdc4b67262b.
export function freebuffLegacyModelDigest(modelId) {
  const input = `freebuff-legacy-model:${modelId}`;
  let h1 = 2166136261;
  let h2 = 1523705862;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 1540483477) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// COMPILED_BY_DEFAULT_KEY: "m-" + digest("key:<id>").slice(0, 10). Verified against the desktop
// binary: z-ai/glm-5.3-flash -> m-7e20df6765.
export function freebuffHandleFor(modelId) {
  return `m-${freebuffLegacyModelDigest(`key:${modelId}`).slice(0, 10)}`;
}

// Minimal validation in the spirit of the CLI's zod parse: protocol 1 and at least one row.
export function parseCatalog(data) {
  if (!data || typeof data !== "object") return null;
  if (data.protocol !== 1 || !Array.isArray(data.rows)) return null;
  if (data.rows.length === 0) return null;
  return data;
}

// Mg: rows whose opensAt has passed (undefined opensAt = visible).
export function visibleRows(catalog, now = Date.now()) {
  if (!catalog?.rows) return [];
  return catalog.rows.filter((row) => row?.opensAt === undefined || row.opensAt <= now);
}

function catalogTtlOverrideMs() {
  const raw = String(process.env.FREEBUFF_CATALOG_TTL_MS ?? "").trim();
  if (!raw) return null;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : null;
}

// Cache lifetime: env override wins, else the server's calendar (refreshAt), clamped to sane
// bounds; a catalog without refreshAt gets the 5 minute default.
export function catalogTtlMs(catalog, now = Date.now()) {
  const override = catalogTtlOverrideMs();
  if (override !== null) return override;
  const refreshAt = Number(catalog?.refreshAt);
  if (Number.isFinite(refreshAt) && refreshAt > now) {
    return Math.min(Math.max(refreshAt - now, MIN_CATALOG_TTL_MS), MAX_CATALOG_TTL_MS);
  }
  return DEFAULT_CATALOG_TTL_MS;
}

// `${tokenHash}:${client}` -> { catalog, fetchId, expiresAt }
const catalogs = new Map();

export function cachedCatalog(tokenHash, client = CLIENT_CLI) {
  const entry = catalogs.get(`${tokenHash}:${client}`);
  if (entry && entry.expiresAt > Date.now()) return entry;
  return null;
}

export function cachedFetchId(tokenHash, client = CLIENT_CLI) {
  return catalogs.get(`${tokenHash}:${client}`)?.fetchId || "";
}

export function invalidateFreebuffCatalog(tokenHash = null) {
  if (!tokenHash) {
    catalogs.clear();
    return;
  }
  for (const key of [...catalogs.keys()]) {
    if (key.startsWith(`${tokenHash}:`)) catalogs.delete(key);
  }
}

// The admission (x-freebuff-model) and cloud-run model fields must be a key straight from the
// live catalog (rows are keyed "m-<10hex>"; handles are "fbm1..." opaque tokens). Live probe:
// anything else — including the legacy fnv-derived handle — is rejected with 409
// freebuff_catalog_stale. No row for the model -> null; the caller answers 502 invalid_model
// instead of guessing. Callers should prefer row.key; row.handle is passed through only when a
// row carries one the server currently accepts.
export function resolveAdmissionModel(catalog, modelKey) {
  const row = visibleRows(catalog).find((candidate) => candidate.key === modelKey);
  return row ? row.key || row.handle || null : null;
}

async function fetchOnce({ token, deviceKey, accountId, client, proxyFetch, proxyOptions, signal, log }) {
  const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const deviceHeaders = deviceKey
    ? await deviceKey.headers({
        token,
        accountId,
        apiHost: FREEBUFF_API_BASE,
        method: "GET",
        url: CATALOG_URL,
        register: true,
      })
    : {};
  const response = await (proxyFetch || fetch)(CATALOG_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      [CATALOG_PROTOCOL_HEADER]: "1",
      [CLIENT_HEADER]: client,
      ...deviceHeaders,
    },
    signal: merged,
  }, proxyOptions);
  const text = await response.text().catch(() => "");
  return { response, text };
}

// Ensure a catalog for the token: cached within TTL, fetched (and cached) otherwise. Returns
// the catalog object or null when upstream has none — callers proceed without a fetchId.
export async function getFreebuffCatalog({
  token,
  deviceKey,
  accountId = null,
  client = CLIENT_CLI,
  proxyFetch = null,
  proxyOptions = null,
  signal,
  log,
  force = false,
}) {
  const cacheKey = `${tokenHashOf(token)}:${client}`;
  if (!force) {
    const cached = catalogs.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.catalog;
  }

  let result;
  try {
    result = await fetchOnce({ token, deviceKey, accountId, client, proxyFetch, proxyOptions, signal, log });
  } catch (err) {
    log?.debug?.("FREEBUFF", `Catalog fetch failed: ${err?.message || err}`);
    return null;
  }
  const { response, text } = result;

  if (!response.ok) {
    // Mirror the CLI: a device-key complaint invalidates the registration for a re-register.
    const { isDeviceKeyError } = await import("./freebuffDeviceKey.js");
    if (isDeviceKeyError(text)) deviceKey?.forgetRegistration({ token, accountId, apiHost: FREEBUFF_API_BASE });
    log?.debug?.("FREEBUFF", `Catalog answered ${response.status}`);
    return null;
  }

  let catalog;
  try {
    catalog = parseCatalog(JSON.parse(text));
  } catch {
    catalog = null;
  }
  if (!catalog) {
    log?.debug?.("FREEBUFF", "Catalog answer was not a protocol 1 document");
    return null;
  }

  catalogs.set(cacheKey, {
    catalog,
    fetchId: typeof catalog.fetchId === "string" ? catalog.fetchId : "",
    expiresAt: Date.now() + catalogTtlMs(catalog),
  });
  return catalog;
}

export const __test__ = {
  DEFAULT_CATALOG_TTL_MS,
  MIN_CATALOG_TTL_MS,
  MAX_CATALOG_TTL_MS,
  CATALOG_TIMEOUT_MS,
  CATALOG_PROTOCOL_HEADER,
  CATALOG_FETCH_HEADER,
  CLIENT_HEADER,
  catalogs,
};

export { CATALOG_FETCH_HEADER };
