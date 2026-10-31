/**
 * CodeBuddy CN usage handler
 *
 * Scoped to the "codebuddy-cn" provider specifically — a future "codebuddy-intl"
 * variant would get its own handler/endpoint, so keep this CN-only.
 *
 * Quota lives behind a Tencent billing endpoint (POST, payload wrapped twice
 * under data.Response.Data). It mixes two credit types that must NOT be merged:
 *
 *  - Refill / base ("基础体验包"): a recurring allowance whose cycle resets long
 *    before the resource itself expires (CycleEndTime << DeductionEndTime). The
 *    live numbers live in the *Cycle* fields (e.g. CycleCapacityUsed 6.54 / 500)
 *    and resetAt is the next monthly refresh.
 *  - Bonus ("活动赠送包"): one-shot credits that run a single cycle and then
 *    expire for good (CycleEndTime == DeductionEndTime). Numbers live in the
 *    plain Capacity fields.
 *
 * We surface one quota row per package — a cadence label (Monthly/Weekly/Daily)
 * for refill packs, "Bonus Pack N" for bonus packs (soonest-expiring first).
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { PROVIDERS } from "../../providers/index.js";
import { buildWorkBuddyBillingHeaders } from "../../utils/workbuddyIdentity.js";
import { U, parseResetTime } from "./shared.js";

const PROVIDER_ID = "codebuddy-cn";

// Prefer the *Precise string fields (exact), fall back to the numeric ones.
function num(precise, plain) {
  const n = Number(precise ?? plain);
  return Number.isFinite(n) ? n : 0;
}

// Label a refill pack by its cycle length (Monthly is the common CodeBuddy case).
function refillCadence(acc) {
  const start = parseResetTime(acc.CycleStartTime);
  const end = parseResetTime(acc.CycleEndTime);
  if (start && end) {
    const days = (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
    if (days <= 1.5) return "Daily";
    if (days <= 10) return "Weekly";
  }
  return "Monthly";
}

// Per-gateway request/label overrides of the shared fetcher (defaults = the CN/intl behaviour).
const DEFAULT_PROFILE = {
  label: "CodeBuddy CN",
  defaultPlan: "CodeBuddy",
  headers: (providerId) => PROVIDERS[providerId]?.headers || {},
  body: () => "{}",
};

// The billing API reads package windows as UTC+8 wall-clock "YYYY-MM-DD HH:mm:ss".
function billingWallClock(date) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

// WorkBuddy global realm: the desktop client's billing call (single-segment UA,
// account uid, per-account X-Machine-ID / X-Session-ID) with the package filter
// it sends — every package still valid, active or not yet started.
const WORKBUDDY_PROFILE = {
  label: "WorkBuddy",
  defaultPlan: "WorkBuddy",
  headers: (providerId, providerSpecificData, token) =>
    buildWorkBuddyBillingHeaders({ providerSpecificData, accessToken: token }),
  body: () => {
    const now = new Date();
    return JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      PackageEndTimeRangeBegin: billingWallClock(now),
      PackageEndTimeRangeEnd: billingWallClock(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
    });
  },
};

async function getCodeBuddyUsage(providerId, accessToken, apiKey, providerSpecificData, proxyOptions = null, profile = DEFAULT_PROFILE) {
  const token = accessToken || apiKey;
  if (!token) {
    return { message: `CodeBuddy (${providerId}) credential not available.` };
  }
  const { label, defaultPlan } = profile;

  try {
    // Some realms serve billing at two paths (workbuddy: bare first, /v2 on 404).
    const { url, fallbackUrl } = U(providerId);
    let response;
    for (const target of [url, fallbackUrl].filter(Boolean)) {
      response = await proxyAwareFetch(target, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...profile.headers(providerId, providerSpecificData, token),
        },
        body: profile.body(),
      }, proxyOptions);
      if (response.status !== 404) break;
    }

    if (response.status === 401 || response.status === 403) {
      return { message: `${label} credential invalid or expired.` };
    }
    if (!response.ok) {
      return { message: `${label} quota API error (${response.status}).` };
    }

    const json = await response.json();
    if (json?.code !== 0) {
      return { message: `${label} quota error: ${json?.msg || "unknown"}` };
    }

    const data = json?.data?.Response?.Data || {};
    const accounts = Array.isArray(data.Accounts) ? data.Accounts : [];
    if (accounts.length === 0) {
      return { message: `${label} connected. No credit package found.` };
    }

    const cycleEndMs = (acc) => {
      const r = parseResetTime(acc.CycleEndTime);
      return r ? new Date(r).getTime() : Number.POSITIVE_INFINITY;
    };
    // Refill packs roll into a new cycle before the resource expires; bonus packs
    // end exactly at expiry. >2d gap between cycle end and validity end = refill.
    const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000;
    const isRefill = (acc) => {
      const ce = cycleEndMs(acc);
      const de = Number(acc.DeductionEndTime);
      return Number.isFinite(ce) && Number.isFinite(de) && de - ce > REFILL_GAP_MS;
    };
    const byExpiry = (a, b) => cycleEndMs(a) - cycleEndMs(b);

    const refills = accounts.filter(isRefill).sort(byExpiry);
    const bonuses = accounts.filter((a) => !isRefill(a)).sort(byExpiry);

    const quotas = {};
    // Refill packs first: cadence-labelled, using the *Cycle* balance and
    // resetting at the next refresh.
    const seenRefill = {};
    refills.forEach((acc) => {
      const base = refillCadence(acc);
      seenRefill[base] = (seenRefill[base] || 0) + 1;
      const name = seenRefill[base] > 1 ? `${base} ${seenRefill[base]}` : base;
      quotas[name] = {
        used: num(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed),
        total: num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
        // Recurring allowance: the CycleEndTime is the next refresh, not the
        // final expiry. The UI must show "Resets in", not "Expires in".
        recurring: true,
      };
    });
    // Bonus packs: use the lifetime Capacity balance; resetAt is the expiry.
    // These are one-shot credits (CycleEndTime == DeductionEndTime), so they
    // never replenish — mark recurring:false so the UI shows "Expires in"
    // instead of implying a monthly refill.
    bonuses.forEach((acc, i) => {
      quotas[`Bonus Pack ${i + 1}`] = {
        used: num(acc.CapacityUsedPrecise, acc.CapacityUsed),
        total: num(acc.CapacitySizePrecise, acc.CapacitySize),
        resetAt: parseResetTime(acc.CycleEndTime),
        unlimited: false,
        recurring: false,
      };
    });

    const basePkg = refills[0] || accounts[0] || {};
    const plan = basePkg.PackageName || basePkg.SubProductName || defaultPlan;

    return { plan, quotas };
  } catch (error) {
    return { message: `CodeBuddy (${providerId}) error: ${error.message}` };
  }
}

export async function getCodeBuddyCnUsage(accessToken, apiKey, providerSpecificData, proxyOptions = null) {
  return getCodeBuddyUsage(PROVIDER_ID, accessToken, apiKey, providerSpecificData, proxyOptions);
}

export async function getCodeBuddyIntlUsage(accessToken, apiKey, providerSpecificData, proxyOptions = null) {
  return getCodeBuddyUsage("codebuddy-intl", accessToken, apiKey, providerSpecificData, proxyOptions);
}

export async function getWorkBuddyUsage(accessToken, apiKey, providerSpecificData, proxyOptions = null) {
  return getCodeBuddyUsage("workbuddy", accessToken, apiKey, providerSpecificData, proxyOptions, WORKBUDDY_PROFILE);
}
