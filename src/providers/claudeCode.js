'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { JsonlCache, listJsonl, exists } = require('./localfiles');
const { httpJson, num, fmtTokens, fmtDuration, fmtAgo, clampPct, startOfLocalDay, expandHome, HOUR } = require('./util');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_TTL = 3 * 60 * 1000; // the card re-reads every minute; the API is rate limited

function claudeDirs(override) {
  if (override) return override.split(',').map(expandHome).filter(Boolean);
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR.split(',').map(expandHome).filter(Boolean);
  return [path.join(os.homedir(), '.config', 'claude'), path.join(os.homedir(), '.claude')];
}

function extractAssistantUsage(obj) {
  const msg = obj && obj.message;
  if (!msg || !msg.usage) return null;
  const u = msg.usage;
  const ts = Date.parse(obj.timestamp || '');
  if (!Number.isFinite(ts)) return null;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  return {
    ts,
    key: msg.id && obj.requestId ? `${msg.id}:${obj.requestId}` : msg.id || null,
    model: msg.model || 'unknown',
    input,
    output,
    cacheWrite,
    cacheRead,
    total: input + output + cacheWrite + cacheRead,
  };
}

function shortModel(m) {
  return String(m)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
}

const cache = new JsonlCache({ needle: '"usage"', extract: extractAssistantUsage });

function keychainCredentials() {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }, (err, out) => {
      resolve(err ? null : String(out).trim());
    });
  });
}

/**
 * Claude Code's own sign-in (OAuth). It lives in <dir>/.credentials.json, or in the
 * Keychain on macOS. We only read it: Claude Code refreshes and rotates it.
 */
async function readOauth(dirs, useKeychain) {
  const raws = [];
  for (const d of dirs) {
    try {
      raws.push(fs.readFileSync(path.join(d, '.credentials.json'), 'utf8'));
    } catch {}
  }
  if (!raws.length && useKeychain) raws.push(await keychainCredentials());
  for (const raw of raws) {
    try {
      const o = JSON.parse(raw).claudeAiOauth;
      if (o && o.accessToken) return { token: o.accessToken, expiresAt: num(o.expiresAt) || null, plan: o.subscriptionType || null };
    } catch {}
  }
  return null;
}

const usageCache = new Map(); // token -> { at, data }

/** Plan limits, as Claude Code's /usage shows them. Cached; serves the last good copy on errors. */
async function fetchPlanUsage(token, fetchImpl, nowMs) {
  const hit = usageCache.get(token);
  if (hit && nowMs - hit.at < USAGE_TTL) return { data: hit.data, at: hit.at };
  try {
    const data = await httpJson(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      fetchImpl,
    });
    usageCache.set(token, { at: nowMs, data });
    return { data, at: nowMs };
  } catch (err) {
    if (err.status === 401 || err.status === 403 || !hit) throw err;
    return { data: hit.data, at: hit.at, stale: true };
  }
}

const LIMITS = [
  ['five_hour', '5-hour limit'],
  ['seven_day', 'Weekly limit'],
  ['seven_day_opus', 'Weekly Opus limit'],
  ['seven_day_sonnet', 'Weekly Sonnet limit'],
];

function planMeters(data, nowMs) {
  const meters = [];
  let tight = null;
  for (const [key, label] of LIMITS) {
    const w = data && data[key];
    if (!w || typeof w !== 'object' || w.utilization == null) continue;
    const resetsAt = Date.parse(w.resets_at || '');
    const expired = Number.isFinite(resetsAt) && resetsAt <= nowMs;
    const pct = expired ? 0 : clampPct(w.utilization);
    const left = Math.round(100 - pct);
    const inTime = Number.isFinite(resetsAt) && !expired ? fmtDuration(resetsAt - nowMs) : '';
    const resets = expired ? 'reset since last check' : inTime ? `resets in ${inTime}` : '';
    meters.push({ label, pct, detail: expired ? resets : [`${left}% left`, inTime].filter(Boolean).join(' · ') });
    if (!tight || pct > tight.pct) tight = { pct, left, label, resets };
  }
  return { meters, tight };
}

/**
 * Claude Code on a Pro/Max plan: the real 5-hour and weekly limits from Anthropic's
 * usage endpoint (using Claude Code's own sign-in, sent only to Anthropic), plus token
 * totals from local transcripts (~/.claude/projects/**\/*.jsonl).
 */
async function fetchClaudeCode({ dir } = {}, { now = new Date(), fetchImpl } = {}) {
  const dirs = claudeDirs(dir);
  const roots = dirs.map((d) => path.join(d, 'projects')).filter(exists);
  const nowMs = now.getTime();
  const todayStart = startOfLocalDay(now).getTime();

  const seen = new Set();
  const today = [];
  for (const root of roots) {
    const files = await listJsonl(root, todayStart);
    for (const { file, stat } of files) {
      let recs;
      try {
        recs = await cache.read(file, stat);
      } catch {
        continue;
      }
      for (const r of recs) {
        if (r.ts < todayStart) continue;
        if (r.key) {
          if (seen.has(r.key)) continue;
          seen.add(r.key);
        }
        today.push(r);
      }
    }
  }
  today.sort((a, b) => a.ts - b.ts);

  const todayTotal = today.reduce((s, e) => s + e.total, 0);
  const todayOut = today.reduce((s, e) => s + e.output, 0);
  const byModel = new Map();
  for (const e of today) byModel.set(e.model, (byModel.get(e.model) || 0) + e.total);
  const topModel = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0];

  // Hourly sparkline for today
  const hours = Math.max(1, Math.ceil((nowMs - todayStart) / HOUR));
  const spark = new Array(Math.min(24, hours)).fill(0);
  for (const e of today) {
    const i = Math.floor((e.ts - todayStart) / HOUR);
    if (i >= 0 && i < spark.length) spark[i] += e.total;
  }

  // Plan limits. A dir override (Settings or tests) never falls back to the Keychain.
  const auth = await readOauth(dirs, !dir && !process.env.CLAUDE_CONFIG_DIR && process.platform === 'darwin');
  if (!auth && !roots.length) throw new Error('Claude Code not found: no sign-in or ~/.claude/projects folder');

  let meters = [];
  let tight = null;
  let note = null;
  if (!auth || (auth.expiresAt && auth.expiresAt <= nowMs)) {
    note = 'Sign in to Claude Code (or open it once) to show plan limits.';
  } else {
    try {
      const usage = await fetchPlanUsage(auth.token, fetchImpl, nowMs);
      ({ meters, tight } = planMeters(usage.data, nowMs));
      if (usage.stale) note = `Limits as of ${fmtAgo(usage.at, nowMs)}; couldn't refresh.`;
    } catch (err) {
      note = err.status === 401 || err.status === 403 ? 'Sign in to Claude Code (or open it once) to show plan limits.' : `Plan limits unavailable: ${err.message}`;
    }
  }

  let headline = { value: fmtTokens(todayTotal), label: 'tokens today' };
  let foot = 'no plan limit data';
  if (tight) {
    // Lead with whichever limit is closest to running out.
    const what = tight.label === '5-hour limit' ? 'of 5-hour limit' : 'this week';
    headline = { value: `${tight.left}%`, label: `left ${what}`, short: `left ${what}` };
    foot = tight.resets || `${fmtTokens(todayTotal)} tokens today`;
  }

  const lastTs = today.length ? today[today.length - 1].ts : 0;
  const stats = [
    { label: 'Tokens today', value: fmtTokens(todayTotal) },
    { label: 'Output today', value: fmtTokens(todayOut) },
    { label: 'Top model', value: topModel ? shortModel(topModel[0]) : '-' },
    { label: 'Last activity', value: lastTs ? fmtAgo(lastTs, nowMs) : 'none today' },
  ];
  if (auth && auth.plan) stats.push({ label: 'Plan', value: String(auth.plan) });

  return {
    headline,
    foot,
    meters,
    stats,
    spark: { label: 'tokens / hour, today', points: spark },
    note,
  };
}

module.exports = { fetchClaudeCode, extractAssistantUsage, claudeDirs, planMeters };
