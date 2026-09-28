'use strict';

const { httpJson, qs, isoNoMs, floorHour, startOfUtcMonth, num, fmtUSD, fmtTokens, capHeadline, budgetMeter, HOUR } = require('./util');

const BASE = 'https://api.anthropic.com';

async function paginate(path, params, headers, fetchImpl, maxPages = 10) {
  const out = [];
  let page;
  for (let i = 0; i < maxPages; i++) {
    const url = `${BASE}${path}?${qs({ ...params, page })}`;
    const res = await httpJson(url, { headers, fetchImpl });
    if (Array.isArray(res.data)) out.push(...res.data);
    if (!res.has_more || !res.next_page) break;
    page = res.next_page;
  }
  return out;
}

function bucketTokens(results = []) {
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  for (const r of results) {
    input += num(r.uncached_input_tokens);
    cacheRead += num(r.cache_read_input_tokens);
    const cc = r.cache_creation || {};
    cacheWrite += num(cc.ephemeral_1h_input_tokens) + num(cc.ephemeral_5m_input_tokens);
    output += num(r.output_tokens);
  }
  return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output };
}

/**
 * Claude API (Console org) via the Usage & Cost Admin API.
 * Needs an Admin API key (sk-ant-admin01-...).
 */
async function fetchAnthropic({ adminKey, budget = 0 }, { fetchImpl, now = new Date() } = {}) {
  if (!adminKey) throw new Error('No Admin API key set');
  const headers = { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' };

  const usageStart = new Date(floorHour(now.getTime()) - 23 * HOUR);
  const monthStart = startOfUtcMonth(now);

  const [usage, cost] = await Promise.all([
    paginate('/v1/organizations/usage_report/messages', { starting_at: isoNoMs(usageStart), bucket_width: '1h', limit: 24 }, headers, fetchImpl),
    paginate('/v1/organizations/cost_report', { starting_at: isoNoMs(monthStart), bucket_width: '1d', limit: 31 }, headers, fetchImpl),
  ]);

  // Tokens, last 24h (hourly buckets)
  usage.sort((a, b) => Date.parse(a.starting_at) - Date.parse(b.starting_at));
  const hourly = usage.map((b) => bucketTokens(b.results));
  const tok = hourly.reduce(
    (acc, t) => ({
      input: acc.input + t.input,
      cacheRead: acc.cacheRead + t.cacheRead,
      cacheWrite: acc.cacheWrite + t.cacheWrite,
      output: acc.output + t.output,
      total: acc.total + t.total,
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
  );

  // Cost month-to-date (daily buckets, amounts are decimal strings in cents)
  cost.sort((a, b) => Date.parse(a.starting_at) - Date.parse(b.starting_at));
  const daily = cost.map((b) => (b.results || []).reduce((s, r) => s + num(r.amount) / 100, 0));
  const mtd = daily.reduce((s, v) => s + v, 0);
  const todayKey = isoNoMs(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))).slice(0, 10);
  const todayBucket = cost.find((b) => String(b.starting_at).slice(0, 10) === todayKey);
  const today = todayBucket ? (todayBucket.results || []).reduce((s, r) => s + num(r.amount) / 100, 0) : 0;

  const promptSide = tok.input + tok.cacheRead + tok.cacheWrite;
  const cacheHit = promptSide > 0 ? Math.round((tok.cacheRead / promptSide) * 100) : null;

  const meters = budget > 0 ? [budgetMeter(mtd, budget)] : [];

  return {
    headline: budget > 0 ? capHeadline(mtd, budget, 'budget') : { value: fmtUSD(mtd), label: 'month to date' },
    foot: budget > 0 ? `${fmtUSD(mtd)} spent this month` : `${fmtUSD(today)} today`,
    meters,
    stats: [
      { label: 'Month to date', value: fmtUSD(mtd) },
      { label: 'Cost today (UTC)', value: fmtUSD(today) },
      { label: 'Tokens 24h', value: fmtTokens(tok.total) },
      { label: 'In / Out 24h', value: `${fmtTokens(promptSide)} / ${fmtTokens(tok.output)}` },
      { label: 'Cache hits', value: cacheHit === null ? '-' : `${cacheHit}%` },
    ],
    spark: { label: 'tokens / hour, last 24h', points: hourly.map((t) => t.total) },
    note: 'Data can lag ~5 min. Cost excludes Priority Tier.',
  };
}

module.exports = { fetchAnthropic, bucketTokens };
