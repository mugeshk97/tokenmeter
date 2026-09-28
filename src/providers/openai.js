'use strict';

const { httpJson, qs, floorHour, startOfUtcMonth, num, fmtUSD, fmtTokens, capHeadline, budgetMeter, HOUR } = require('./util');

const BASE = 'https://api.openai.com';

async function paginate(path, params, headers, fetchImpl, maxPages = 10) {
  const out = [];
  let page;
  for (let i = 0; i < maxPages; i++) {
    const res = await httpJson(`${BASE}${path}?${qs({ ...params, page })}`, { headers, fetchImpl });
    if (Array.isArray(res.data)) out.push(...res.data);
    if (!res.has_more || !res.next_page) break;
    page = res.next_page;
  }
  return out;
}

/**
 * OpenAI API org (this is also where Codex spend lands when Codex runs on an API key).
 * Needs an organization Admin key (sk-admin-...).
 */
async function fetchOpenAI({ adminKey, budget = 0 }, { fetchImpl, now = new Date() } = {}) {
  if (!adminKey) throw new Error('No Admin key set');
  const headers = { authorization: `Bearer ${adminKey}` };
  const monthStart = Math.floor(startOfUtcMonth(now).getTime() / 1000);
  const usageStart = Math.floor((floorHour(now.getTime()) - 23 * HOUR) / 1000);

  const [costs, usage] = await Promise.all([
    paginate('/v1/organization/costs', { start_time: monthStart, bucket_width: '1d', limit: 31 }, headers, fetchImpl),
    paginate('/v1/organization/usage/completions', { start_time: usageStart, bucket_width: '1h', limit: 24 }, headers, fetchImpl),
  ]);

  costs.sort((a, b) => num(a.start_time) - num(b.start_time));
  const daily = costs.map((b) => (b.results || []).reduce((s, r) => s + num(r.amount), 0));
  const mtd = daily.reduce((s, v) => s + v, 0);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
  const todayBucket = costs.find((b) => num(b.start_time) === todayUtc);
  const today = todayBucket ? (todayBucket.results || []).reduce((s, r) => s + num(r.amount), 0) : 0;

  usage.sort((a, b) => num(a.start_time) - num(b.start_time));
  let input = 0;
  let cached = 0;
  let output = 0;
  let requests = 0;
  const hourly = usage.map((b) => {
    let t = 0;
    for (const r of b.results || []) {
      input += num(r.input_tokens);
      cached += num(r.input_cached_tokens);
      output += num(r.output_tokens);
      requests += num(r.num_model_requests);
      t += num(r.input_tokens) + num(r.output_tokens);
    }
    return t;
  });

  const meters = budget > 0 ? [budgetMeter(mtd, budget)] : [];

  return {
    headline: budget > 0 ? capHeadline(mtd, budget, 'budget') : { value: fmtUSD(mtd), label: 'month to date' },
    foot: budget > 0 ? `${fmtUSD(mtd)} spent this month` : `${fmtUSD(today)} today`,
    meters,
    stats: [
      { label: 'Month to date', value: fmtUSD(mtd) },
      { label: 'Today (UTC)', value: fmtUSD(today) },
      { label: 'Tokens 24h', value: fmtTokens(input + output) },
      { label: 'In / Out 24h', value: `${fmtTokens(input)} / ${fmtTokens(output)}` },
      { label: 'Requests 24h', value: fmtTokens(requests) },
    ],
    spark: { label: 'tokens / hour, last 24h', points: hourly },
    note: cached > 0 ? `${Math.round((cached / Math.max(1, input)) * 100)}% of input tokens were cached` : null,
  };
}

module.exports = { fetchOpenAI };
