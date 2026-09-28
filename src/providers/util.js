'use strict';

const os = require('os');
const { version } = require('../../package.json');

const UA = `tokenmeter/${version} (${process.platform})`;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function friendlyStatus(status) {
  if (status === 401) return 'Unauthorized: the key was rejected';
  if (status === 403) return 'Forbidden: the key lacks permission for this endpoint';
  if (status === 404) return 'Not found: check the team/org ID or endpoint';
  if (status === 429) return 'Rate limited: will retry on the next poll';
  if (status >= 500) return `Provider error (${status})`;
  return `HTTP ${status}`;
}

/**
 * Fetch JSON with a timeout. Errors never include request headers,
 * so keys cannot leak into the UI.
 */
async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await doFetch(url, {
      method,
      headers: { 'user-agent': UA, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('Request timed out');
    throw new Error(`Network error: ${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = '';
    try {
      const j = JSON.parse(text);
      detail = (j.error && (j.error.message || j.error)) || j.message || j.code || '';
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch {
      detail = text.slice(0, 160);
    }
    throw new HttpError(res.status, `${friendlyStatus(res.status)}${detail ? ` - ${String(detail).slice(0, 200)}` : ''}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Provider returned invalid JSON');
  }
}

function qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    const vals = Array.isArray(v) ? v : [v];
    for (const item of vals) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
  }
  return parts.join('&');
}

/** ISO-8601 without milliseconds: 2026-09-28T00:00:00Z */
function isoNoMs(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function floorHour(ms) {
  return Math.floor(ms / HOUR) * HOUR;
}

function startOfLocalDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfLocalMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function startOfUtcMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function num(x) {
  if (x === null || x === undefined) return 0;
  if (typeof x === 'object' && 'val' in x) return num(x.val);
  if (typeof x === 'object' && 'value' in x) return num(x.value);
  const n = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(n) ? n : 0;
}

function fmtUSD(v) {
  const n = num(v);
  if (Math.abs(n) >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(v) {
  const n = num(v);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms <= 0) return 'now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 48) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

function fmtAgo(ms, now = Date.now()) {
  if (!ms) return 'never';
  const diff = now - ms;
  if (diff < 45 * 1000) return 'just now';
  return `${fmtDuration(diff)} ago`;
}

/** "$100" for whole amounts, otherwise fmtUSD. For labels like "left of $100 budget". */
function fmtUSDRound(v) {
  const n = num(v);
  return Number.isInteger(n) ? `$${n.toLocaleString('en-US')}` : fmtUSD(n);
}

/** Remaining-first headline for a spending cap (monthly budget or spending limit). */
function capHeadline(spent, cap, what) {
  return { value: fmtUSD(Math.max(0, cap - spent)), label: `left of ${fmtUSDRound(cap)} ${what}`, short: `left of ${fmtUSDRound(cap)}` };
}

/** Meter for a monthly budget, with what's left in the detail. */
function budgetMeter(spent, budget) {
  const pct = clampPct((spent / budget) * 100);
  return { label: `Monthly budget ${fmtUSD(budget)}`, pct, detail: `${Math.round(100 - pct)}% left` };
}

/** Expand a leading ~ in a user-entered folder, with / or \\ after it (Windows). */
function expandHome(p) {
  return String(p).trim().replace(/^~(?=$|[\\/])/, os.homedir());
}

function clampPct(p) {
  const n = num(p);
  return Math.max(0, Math.min(100, n));
}

module.exports = {
  UA,
  HOUR,
  DAY,
  HttpError,
  httpJson,
  qs,
  isoNoMs,
  floorHour,
  startOfLocalDay,
  startOfLocalMonth,
  startOfUtcMonth,
  num,
  fmtUSD,
  fmtUSDRound,
  capHeadline,
  budgetMeter,
  fmtTokens,
  fmtDuration,
  fmtAgo,
  clampPct,
  expandHome,
};
