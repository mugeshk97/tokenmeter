'use strict';

const os = require('os');
const path = require('path');
const { JsonlCache, listJsonl, exists } = require('./localfiles');
const { num, fmtTokens, fmtDuration, fmtAgo, clampPct, startOfLocalDay, DAY } = require('./util');

function codexHome(override) {
  if (override) return override.replace(/^~(?=$|\/)/, os.homedir());
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

/**
 * Codex on a ChatGPT plan: reads the rate-limit snapshots that the Codex CLI/IDE
 * writes into ~/.codex/sessions/**\/rollout-*.jsonl. Fully local, no network.
 */
async function fetchCodex({ home } = {}, { now = new Date() } = {}) {
  const root = path.join(codexHome(home), 'sessions');
  if (!exists(root)) throw new Error(`No Codex sessions at ${root.replace(os.homedir(), '~')}`);

  const nowMs = now.getTime();
  const todayStart = startOfLocalDay(now).getTime();
  // Sessions live in sessions/YYYY/MM/DD/. Only walk the last 9 days instead of the whole history.
  const since = nowMs - 8 * DAY;
  const files = await listJsonl(root, since, 0); // flat layout used by older versions
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

  const meters = [];
  let headline = { value: fmtTokens(tokensToday), label: 'tokens today' };
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

    for (const w of windows) {
      const expired = w.resetsAt !== null && w.resetsAt <= nowMs;
      const pct = expired ? 0 : clampPct(w.pct);
      meters.push({
        label: w.label,
        pct,
        detail: expired ? 'reset since last use' : w.resetsAt ? `${Math.round(pct)}% · resets in ${fmtDuration(w.resetsAt - nowMs)}` : `${Math.round(pct)}%`,
      });
    }
    if (meters.length) headline = { value: `${Math.round(meters[0].pct)}%`, label: `${meters[0].label.toLowerCase()} used` };
  }

  const stats = [
    { label: 'Tokens today', value: fmtTokens(tokensToday) },
    { label: 'Last activity', value: lastActivity ? fmtAgo(lastActivity, nowMs) : 'none this week' },
  ];
  if (plan) stats.push({ label: 'Plan', value: String(plan) });
  if (credits) stats.push({ label: 'Credits', value: credits });

  return {
    headline,
    meters,
    stats,
    spark: null,
    note: latestRl
      ? 'Snapshot from your latest Codex session; it updates whenever Codex runs.'
      : 'No rate-limit data yet. Run Codex once (or use /status) to populate it.',
  };
}

module.exports = { fetchCodex, extractTokenCount, normWindow, windowLabel };
