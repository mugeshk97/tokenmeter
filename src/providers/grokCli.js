'use strict';

const os = require('os');
const path = require('path');
const { JsonlCache, listJsonl, exists } = require('./localfiles');
const { num, fmtTokens, fmtUSD, fmtAgo, startOfLocalDay, startOfLocalMonth, HOUR, expandHome } = require('./util');

const TICKS_PER_USD = 1e10;

function grokHome(override) {
  if (override) return expandHome(override);
  return path.join(os.homedir(), '.grok');
}

/** One record per completed turn; the usage on each event covers that turn only. */
function extractTurn(obj) {
  const u = obj && obj.params && obj.params.update;
  if (!u || u.sessionUpdate !== 'turn_completed' || !u.usage) return null;
  const meta = obj.params._meta || u._meta || {};
  const ts = meta.agentTimestampMs ? num(meta.agentTimestampMs) : obj.timestamp ? num(obj.timestamp) * 1000 : null;
  const usage = u.usage;
  const models = {};
  for (const [m, mu] of Object.entries(usage.modelUsage || {})) models[m] = num(mu.totalTokens);
  return {
    ts,
    total: usage.totalTokens != null ? num(usage.totalTokens) : num(usage.inputTokens) + num(usage.outputTokens),
    input: num(usage.inputTokens),
    cached: num(usage.cachedReadTokens),
    usd: num(usage.costUsdTicks) / TICKS_PER_USD,
    models,
  };
}

const cache = new JsonlCache({ needle: 'turn_completed', extract: extractTurn });

/**
 * Grok CLI (grok.com subscription or API key): per-turn usage from
 * ~/.grok/sessions/<cwd>/<session>/updates.jsonl. Fully local, no network.
 */
async function fetchGrokCli({ home } = {}, { now = new Date() } = {}) {
  const root = path.join(grokHome(home), 'sessions');
  if (!exists(root)) throw new Error(`No Grok CLI sessions at ${root.replace(os.homedir(), '~')}`);

  const nowMs = now.getTime();
  const todayStart = startOfLocalDay(now).getTime();
  const monthStart = startOfLocalMonth(now).getTime();
  const files = await listJsonl(root, monthStart, 2);

  let tokensToday = 0;
  let inputToday = 0;
  let cachedToday = 0;
  let usdToday = 0;
  let usdMonth = 0;
  let lastActivity = 0;
  const byModel = new Map();
  const hours = Math.max(1, Math.ceil((nowMs - todayStart) / HOUR));
  const spark = new Array(Math.min(24, hours)).fill(0);

  for (const { file, stat } of files) {
    let recs;
    try {
      recs = await cache.read(file, stat);
    } catch {
      continue;
    }
    for (const r of recs) {
      const ts = r.ts || stat.mtimeMs;
      if (ts > lastActivity) lastActivity = ts;
      if (ts < monthStart) continue;
      usdMonth += r.usd;
      if (ts < todayStart) continue;
      tokensToday += r.total;
      inputToday += r.input;
      cachedToday += r.cached;
      usdToday += r.usd;
      for (const [m, t] of Object.entries(r.models)) byModel.set(m, (byModel.get(m) || 0) + t);
      const i = Math.floor((ts - todayStart) / HOUR);
      if (i >= 0 && i < spark.length) spark[i] += r.total;
    }
  }

  const topModel = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    headline: { value: fmtTokens(tokensToday), label: 'tokens today' },
    foot: `${fmtUSD(usdToday)} today · ${fmtUSD(usdMonth)} mtd`,
    meters: [],
    stats: [
      { label: 'Cost today', value: fmtUSD(usdToday) },
      { label: 'Month to date', value: fmtUSD(usdMonth) },
      { label: 'Top model', value: topModel ? topModel[0] : '-' },
      { label: 'Cache hits', value: inputToday ? `${Math.round((cachedToday / inputToday) * 100)}%` : '-' },
      { label: 'Last activity', value: lastActivity ? fmtAgo(lastActivity, nowMs) : 'none this month' },
    ],
    spark: { label: 'tokens / hour, today', points: spark },
    note: 'Cost is what Grok CLI reports locally (API-equivalent price), not a subscription bill.',
  };
}

module.exports = { fetchGrokCli, extractTurn };
