// Live Freebuff model list for /v1/models, built from the signed catalog the same way the
// executor reads it. Follows the kiroModels/kimchiModels resolver contract: returns
// { models: [{ id, name? }] } or null when there is nothing live (the static registry list then
// stands in). Model ids are the catalog row keys (the opaque chat model ids); rows the server
// gates behind `access: "locked"` are not routable and stay off the list.

import { getFreebuffCatalog, visibleRows, invalidateFreebuffCatalog, tokenHashOf } from "../utils/freebuffCatalog.js";
import { FreebuffDeviceKeyManager } from "../utils/freebuffDeviceKey.js";

// Managers per token, shared with nothing else — /v1/models calls are rarer than chats, but the
// keypair must be the same one the executor registers, so both go through providerSpecificData.
const managers = new Map();

function managerFor(token, { storedRecord, persist, log, proxyFetch, proxyOptions }) {
  const key = tokenHashOf(token);
  let manager = managers.get(key);
  if (!manager) {
    manager = new FreebuffDeviceKeyManager({
      record: storedRecord && typeof storedRecord.privateKey === "string" ? storedRecord : null,
      persist,
      fetchImpl: (url, init) => (proxyFetch || fetch)(url, init, proxyOptions ?? null),
      log,
    });
    if (managers.size > 200) managers.clear();
    managers.set(key, manager);
  }
  return manager;
}

export async function resolveFreebuffModels(
  { accessToken, apiKey, providerSpecificData = {}, connectionId = null } = {},
  { log = null, proxyOptions = null, proxyFetch = null } = {},
) {
  const token = (accessToken || apiKey || "").trim();
  if (!token) return null;

  const storedRecord = providerSpecificData?.freebuffDeviceKey;
  const manager = managerFor(token, {
    storedRecord,
    persist: async (record) => {
      if (!connectionId) return;
      try {
        const { updateProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
        await updateProviderConnection(connectionId, {
          providerSpecificData: { ...providerSpecificData, freebuffDeviceKey: record },
        });
      } catch {
        // best effort; the executor re-registers on the next chat if the record never landed
      }
    },
    log,
    proxyFetch,
    proxyOptions,
  });

  const catalog = await getFreebuffCatalog({
    token,
    deviceKey: manager,
    accountId: providerSpecificData?.userId || null,
    proxyFetch,
    proxyOptions,
    log,
  });
  if (!catalog) return null;

  const models = visibleRows(catalog)
    .filter((row) => row?.key && row.access !== "locked")
    .map((row) => ({ id: row.key, name: row.displayName || row.handle || row.key }));
  return models.length ? { models } : null;
}

// A catalog that just went stale must not answer /v1/models forever.
export function invalidateFreebuffModelsCache(token) {
  invalidateFreebuffCatalog(token ? tokenHashOf(token) : null);
}
