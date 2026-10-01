'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonlCache, listJsonl, exists } = require('./localfiles');
const { httpJson, cachedJson, num, fmtTokens, fmtDuration, fmtAgo, clampPct, startOfLocalDay, DAY, expandHome } = require('./util');

function codexHome(override) {
  if (override) return expandHome(override);
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  return path.join(os.homedir(), '.codex');
}

function extractTokenCount(obj) {
  let p = null;
  if (obj && obj.payload && obj.payload.type === 'token_count') p = obj.payload;
  else if (obj && obj.type === 'token_count') p = obj;
  else if (obj && obj.msg && obj.msg.type === 'token_count') p = obj.msg;
  if (!p) return null;
  const ts = Date.parse(obj.timestamp || p.timestamp || '') || null;
  const info = p.info || null;
  let total = null;
  if (info && info.total_token_usage) {
    const t = info.total_token_usage;
    total = t.total_tokens != null ? num(t.total_tokens) : num(t.input_tokens) + num(t.output_tokens);
  }
  return { ts, total, rl: p.rate_limits || null };
}

function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? d : null;
}

/** Normalize one rate-limit window across Codex CLI versions. */
function normWindow(rl, key, eventMs) {
  const w = rl[key];
  let pct;
  let minutes;
  let resetsAt = null;
  if (w && typeof w === 'object') {
    pct = w.used_percent ?? w.usedPercent;
    minutes = w.window_minutes ?? w.windowMinutes;
    resetsAt = toMs(w.resets_at ?? w.resetsAt);
    const inSec = w.resets_in_seconds ?? w.resetsInSeconds;
    if (resetsAt === null && inSec != null && eventMs) resetsAt = eventMs + num(inSec) * 1000;
  } else if (rl[`${key}_used_percent`] !== undefined) {
    pct = rl[`${key}_used_percent`];
    minutes = rl[`${key}_window_minutes`];
    resetsAt = toMs(rl[`${key}_resets_at`]);
    const inSec = rl[`${key}_resets_in_seconds`];
    if (resetsAt === null && inSec != null && eventMs) resetsAt = eventMs + num(inSec) * 1000;
  } else {
    return null;
  }
  if (pct === undefined || pct === null) return null;
  return { pct: num(pct), minutes: minutes != null ? num(minutes) : null, resetsAt };
}

function windowLabel(minutes, fallback) {
  if (!minutes) return fallback;
  if (minutes === 300) return '5-hour limit';
  if (minutes === 10080) return 'Weekly limit';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-min limit`;
}

const cache = new JsonlCache({ needle: 'token_count', extract: extractTokenCount });

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const USAGE_TTL = 3 * 60 * 1000;
const SIGN_IN_NOTE = 'Open Codex to refresh its sign-in to show live limits.';

/** Codex's ChatGPT sign-in from auth.json. Read only: Codex refreshes it itself. */
function readCodexAuth(home) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
  } catch {
    return null;
  }
  const t = d && d.tokens;
  if (!t || !t.access_token || (d.auth_mode && d.auth_mode !== 'chatgpt')) return null;
  let expMs = null;
  try {
    const exp = JSON.parse(Buffer.from(t.access_token.split('.')[1], 'base64url').toString()).exp;
    if (Number.isFinite(exp)) expMs = exp * 1000;
  } catch {}
  return { token: t.access_token, accountId: t.account_id || null, expMs };
}

/** The live usage response, mapped onto the rate_limits shape Codex writes into its logs. */
function usageToRl(u) {
  const win = (w) =>
    w && w.used_percent != null
      ? { used_percent: w.used_percent, window_minutes: w.limit_window_seconds ? num(w.limit_window_seconds) / 60 : null, resets_at: w.reset_at ?? null }
      : null;
  const rl = (u && u.rate_limit) || {};
  return { primary: win(rl.primary_window), secondary: win(rl.secondary_window), plan_type: u && u.plan_type, credits: u && u.credits };
}

/**
 * Codex on a ChatGPT plan: reads the rate-limit snapshots that the Codex CLI/IDE
 * writes into ~/.codex/sessions/**\/rollout-*.jsonl. Fully local, no network.
 */
async function fetchCodex({ home } = {}, { now = new Date(), fetchImpl } = {}) {
  const root = path.join(codexHome(home), 'sessions');
  const auth = readCodexAuth(codexHome(home));
  if (!auth && !exists(root)) throw new Error(`No Codex sessions at ${root.replace(os.homedir(), '~')}`);

  const nowMs = now.getTime();
  const todayStart = startOfLocalDay(now).getTime();
  // Sessions live in sessions/YYYY/MM/DD/. Only walk the last 9 days instead of the whole history.
  const since = nowMs - 8 * DAY;
  const files = exists(root) ? await listJsonl(root, since, 0) : []; // flat layout used by older versions
  for (let i = 0; i <= 8; i++) {
    const d = new Date(nowMs - i * DAY);
    const dayDir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    if (exists(dayDir)) files.push(...(await listJsonl(dayDir, since, 1)));
  }

  let latestRl = null;
  let lastActivity = 0;
  let tokensToday = 0;

  for (const { file, stat } of files) {
    let recs;
    try {
      recs = await cache.read(file, stat);
    } catch {
      continue;
    }
    if (!recs.length) continue;
    let base = 0;
    let lastToday = null;
    for (const r of recs) {
      const ts = r.ts || stat.mtimeMs;
      if (ts > lastActivity) lastActivity = ts;
      if (r.total !== null) {
        if (ts < todayStart) base = r.total;
        else lastToday = r.total;
      }
      if (r.rl && (!latestRl || ts >= latestRl.ts)) latestRl = { ts, rl: r.rl };
    }
    if (lastToday !== null) tokensToday += Math.max(0, lastToday - base);
  }

  // Live limits from ChatGPT win over the last local snapshot.
  let live = false;
  let apiNote = null;
  if (auth && auth.expMs && auth.expMs <= nowMs) {
    apiNote = SIGN_IN_NOTE;
  } else if (auth) {
    try {
      const headers = { authorization: `Bearer ${auth.token}` };
      if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId;
      const usage = await cachedJson(`codex:${auth.token}`, USAGE_TTL, nowMs, () => httpJson(USAGE_URL, { headers, fetchImpl }));
      const rl = usageToRl(usage.data);
      if (rl.primary || rl.secondary) {
        latestRl = { ts: usage.at, rl };
        live = true;
        if (usage.stale) apiNote = `Limits as of ${fmtAgo(usage.at, nowMs)}; couldn't refresh.`;
      }
    } catch (err) {
      apiNote = err.status === 401 || err.status === 403 ? SIGN_IN_NOTE : `Live limits unavailable: ${err.message}`;
    }
  }

  const meters = [];
  let headline = { value: fmtTokens(tokensToday), label: 'tokens today' };
  let foot = null;
  let plan = null;
  let credits = null;

  if (latestRl) {
    const { rl, ts } = latestRl;
    plan = rl.plan_type || rl.planType || null;
    if (rl.credits && typeof rl.credits === 'object') {
      if (rl.credits.unlimited) credits = 'unlimited';
      else if (rl.credits.balance != null) credits = String(rl.credits.balance);
    }
    const windows = [
      ['primary', 'Short window'],
      ['secondary', 'Long window'],
    ]
      .map(([k, fb]) => {
        const w = normWindow(rl, k, ts);
        return w ? { ...w, label: windowLabel(w.minutes, fb) } : null;
      })
      .filter(Boolean);

    let tight = null;
    for (const w of windows) {
      const expired = w.resetsAt !== null && w.resetsAt <= nowMs;
      const pct = expired ? 0 : clampPct(w.pct);
      const left = Math.round(100 - pct);
      const inTime = w.resetsAt ? fmtDuration(w.resetsAt - nowMs) : '';
      const resets = expired ? 'reset since last use' : inTime ? `resets in ${inTime}` : '';
      meters.push({ label: w.label, pct, detail: expired ? resets : [`${left}% left`, inTime].filter(Boolean).join(' · ') });
      if (!tight || pct > tight.pct) tight = { pct, left, label: w.label, resets };
    }
    // Lead with whichever limit is closest to running out.
    if (tight) {
      const what = tight.label === 'Weekly limit' ? 'this week' : `of ${tight.label.toLowerCase()}`;
      headline = { value: `${tight.left}%`, label: `left ${what}`, short: `left ${what}` };
      foot = tight.resets || null;
    }
  }

  const stats = [
    { label: 'Tokens today', value: fmtTokens(tokensToday) },
    { label: 'Last activity', value: lastActivity ? fmtAgo(lastActivity, nowMs) : 'none' },
  ];
  if (plan) stats.push({ label: 'Plan', value: String(plan) });
  if (credits) stats.push({ label: 'Credits', value: credits });

  return {
    headline,
    foot: foot || 'no limit data yet',
    meters,
    stats,
    spark: null,
    note:
      apiNote ||
      (live
        ? 'Live from ChatGPT.'
        : latestRl
          ? 'Snapshot from your latest Codex session; it updates whenever Codex runs.'
          : 'No rate-limit data yet. Run Codex once (or use /status) to populate it.'),
  };
}

module.exports = { fetchCodex, extractTokenCount, normWindow, windowLabel, readCodexAuth, usageToRl };
