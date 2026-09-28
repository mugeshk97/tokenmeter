'use strict';

const os = require('os');
const path = require('path');
const { JsonlCache, listJsonl, exists } = require('./localfiles');
const { num, fmtTokens, fmtDuration, fmtAgo, floorHour, startOfLocalDay, HOUR, DAY } = require('./util');

const BLOCK_MS = 5 * HOUR;

function claudeDirs(override) {
  const expand = (p) => p.trim().replace(/^~(?=$|\/)/, os.homedir());
  if (override) return override.split(',').map(expand).filter(Boolean);
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR.split(',').map(expand).filter(Boolean);
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

/** Group entries into 5-hour session blocks (same rule Claude Code's limits use). */
function buildBlocks(entries) {
  const blocks = [];
  let cur = null;
  let lastTs = 0;
  for (const e of entries) {
    if (!cur || e.ts >= cur.start + BLOCK_MS || e.ts - lastTs >= BLOCK_MS) {
      cur = { start: floorHour(e.ts), end: floorHour(e.ts) + BLOCK_MS, tokens: 0, output: 0, first: e.ts, last: e.ts };
      blocks.push(cur);
    }
    cur.tokens += e.total;
    cur.output += e.output;
    cur.last = e.ts;
    lastTs = e.ts;
  }
  return blocks;
}

function shortModel(m) {
  return String(m)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
}

const cache = new JsonlCache({ needle: '"usage"', extract: extractAssistantUsage });

/**
 * Claude Code on a Pro/Max plan: token totals from local transcripts
 * (~/.claude/projects/**\/*.jsonl). Fully local, no network.
 */
async function fetchClaudeCode({ dir } = {}, { now = new Date() } = {}) {
  const roots = claudeDirs(dir)
    .map((d) => path.join(d, 'projects'))
    .filter(exists);
  if (!roots.length) throw new Error('No Claude Code projects folder found (~/.claude/projects)');

  const nowMs = now.getTime();
  const todayStart = startOfLocalDay(now).getTime();
  const since = Math.min(todayStart, nowMs - BLOCK_MS * 2) - DAY;

  const seen = new Set();
  const entries = [];
  for (const root of roots) {
    const files = await listJsonl(root, since);
    for (const { file, stat } of files) {
      let recs;
      try {
        recs = await cache.read(file, stat);
      } catch {
        continue;
      }
      for (const r of recs) {
        if (r.ts < since) continue;
        if (r.key) {
          if (seen.has(r.key)) continue;
          seen.add(r.key);
        }
        entries.push(r);
      }
    }
  }
  entries.sort((a, b) => a.ts - b.ts);

  const today = entries.filter((e) => e.ts >= todayStart);
  const todayTotal = today.reduce((s, e) => s + e.total, 0);
  const todayOut = today.reduce((s, e) => s + e.output, 0);
  const byModel = new Map();
  for (const e of today) byModel.set(e.model, (byModel.get(e.model) || 0) + e.total);
  const topModel = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0];

  const blocks = buildBlocks(entries);
  const last = blocks[blocks.length - 1];
  const active = last && nowMs < last.end && nowMs - last.last < BLOCK_MS ? last : null;

  // Hourly sparkline for today
  const hours = Math.max(1, Math.ceil((nowMs - todayStart) / HOUR));
  const spark = new Array(Math.min(24, hours)).fill(0);
  for (const e of today) {
    const i = Math.floor((e.ts - todayStart) / HOUR);
    if (i >= 0 && i < spark.length) spark[i] += e.total;
  }

  const meters = [];
  const stats = [];
  let headline;
  let foot;
  if (active) {
    const elapsed = nowMs - active.start;
    const left = fmtDuration(active.end - nowMs);
    meters.push({
      label: '5-hour session window',
      pct: Math.min(100, (elapsed / BLOCK_MS) * 100),
      detail: `resets in ${left}`,
    });
    // Lead with the time left in the session; its tokens move to the footnote and stats.
    headline = { value: left, label: 'left in 5-hour session', short: 'left · 5h session' };
    foot = `${fmtTokens(active.tokens)} tokens this session`;
    stats.push({ label: 'Session tokens', value: fmtTokens(active.tokens) });
  } else {
    headline = { value: fmtTokens(todayTotal), label: 'tokens today' };
    foot = 'no active session';
  }

  const lastTs = entries.length ? entries[entries.length - 1].ts : 0;
  return {
    headline,
    foot,
    meters,
    stats: [
      ...stats,
      { label: 'Tokens today', value: fmtTokens(todayTotal) },
      { label: 'Output today', value: fmtTokens(todayOut) },
      { label: 'Top model', value: topModel ? shortModel(topModel[0]) : '-' },
      { label: 'Last activity', value: lastTs ? fmtAgo(lastTs, nowMs) : 'none' },
    ],
    spark: { label: 'tokens / hour, today', points: spark },
    note: active ? null : 'No active 5-hour session.',
  };
}

module.exports = { fetchClaudeCode, extractAssistantUsage, buildBlocks, claudeDirs };
