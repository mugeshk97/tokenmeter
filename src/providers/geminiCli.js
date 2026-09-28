'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exists } = require('./localfiles');
const { num, fmtTokens, fmtAgo, startOfLocalDay, HOUR, DAY } = require('./util');

function geminiHome(override) {
  if (override) return override.replace(/^~(?=$|\/)/, os.homedir());
  return path.join(os.homedir(), '.gemini');
}

/** Token records from one saved chat (whole-file JSON, not JSONL). */
function extractMessages(chat) {
  const out = [];
  for (const m of (chat && chat.messages) || []) {
    const t = m && m.tokens;
    if (!t) continue;
    const ts = Date.parse(m.timestamp || '');
    if (!Number.isFinite(ts)) continue;
    out.push({
      id: m.id || null,
      ts,
      model: m.model || 'unknown',
      total: t.total != null ? num(t.total) : num(t.input) + num(t.output),
      output: num(t.output),
    });
  }
  return out;
}

const cache = new Map(); // file -> { key, records }

async function readChat(file, stat) {
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.records;
  const records = extractMessages(JSON.parse(await fs.promises.readFile(file, 'utf8')));
  if (cache.size > 2000) cache.clear();
  cache.set(file, { key, records });
  return records;
}

/** tmp/<projectHash>/chats/session-*.json modified since `sinceMs`. */
async function listChats(tmpDir, sinceMs) {
  const out = [];
  let projects;
  try {
    projects = await fs.promises.readdir(tmpDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const chats = path.join(tmpDir, p.name, 'chats');
    let names;
    try {
      names = await fs.promises.readdir(chats);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('session-') || !name.endsWith('.json')) continue;
      const file = path.join(chats, name);
      try {
        const stat = await fs.promises.stat(file);
        if (stat.isFile() && stat.mtimeMs >= sinceMs) out.push({ file, stat });
      } catch {
        /* vanished */
      }
    }
  }
  return out;
}

/**
 * Gemini CLI: token counts from saved chats in ~/.gemini/tmp/<hash>/chats/.
 * Gemini API keys have no usage endpoint, so this is local only.
 */
async function fetchGeminiCli({ home } = {}, { now = new Date() } = {}) {
  const tmpDir = path.join(geminiHome(home), 'tmp');
  if (!exists(tmpDir)) throw new Error(`No Gemini CLI data at ${tmpDir.replace(os.homedir(), '~')}`);

  const nowMs = now.getTime();
  const todayStart = startOfLocalDay(now).getTime();
  const since = todayStart - 7 * DAY;
  const files = await listChats(tmpDir, since);

  const seen = new Set();
  let tokensToday = 0;
  let outputToday = 0;
  let tokensWeek = 0;
  let lastActivity = 0;
  const byModel = new Map();
  const hours = Math.max(1, Math.ceil((nowMs - todayStart) / HOUR));
  const spark = new Array(Math.min(24, hours)).fill(0);

  for (const { file, stat } of files) {
    let recs;
    try {
      recs = await readChat(file, stat);
    } catch {
      continue; // partial write
    }
    for (const r of recs) {
      if (r.id) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
      }
      if (r.ts > lastActivity) lastActivity = r.ts;
      if (r.ts < since) continue;
      tokensWeek += r.total;
      if (r.ts < todayStart) continue;
      tokensToday += r.total;
      outputToday += r.output;
      byModel.set(r.model, (byModel.get(r.model) || 0) + r.total);
      const i = Math.floor((r.ts - todayStart) / HOUR);
      if (i >= 0 && i < spark.length) spark[i] += r.total;
    }
  }

  const topModel = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    headline: { value: fmtTokens(tokensToday), label: 'tokens today' },
    meters: [],
    stats: [
      { label: 'Output today', value: fmtTokens(outputToday) },
      { label: 'Last 7 days', value: fmtTokens(tokensWeek) },
      { label: 'Top model', value: topModel ? topModel[0].replace(/^gemini-/, '') : '-' },
      { label: 'Last activity', value: lastActivity ? fmtAgo(lastActivity, nowMs) : 'none this week' },
    ],
    spark: { label: 'tokens / hour, today', points: spark },
    note: lastActivity ? null : 'No Gemini CLI chats in the last week.',
  };
}

module.exports = { fetchGeminiCli, extractMessages };
