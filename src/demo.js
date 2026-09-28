'use strict';

// Sample cards for `npm run demo` (UI preview only; shown with a "sample data" banner).
function wave(n, base, amp, seed = 1) {
  return Array.from({ length: n }, (_, i) => Math.max(0, Math.round(base + amp * Math.sin((i + seed) / 2.3) + amp * 0.4 * Math.cos(i * seed))));
}

function demoCards() {
  const now = Date.now();
  return [
    {
      id: 'claudeCode', name: 'Claude Code', accent: '#e8a87c', kind: 'local', status: 'ok', updatedAt: now - 20e3,
      headline: { value: '3.4M', label: 'tokens this session' },
      meters: [{ label: '5-hour session window', pct: 58, detail: 'resets in 2h 6m' }],
      stats: [
        { label: 'Tokens today', value: '9.8M' }, { label: 'Output today', value: '212K' },
        { label: 'Top model', value: 'opus-4-7' }, { label: 'Last activity', value: '2m ago' },
      ],
      spark: { label: 'tokens / hour, today', points: wave(8, 900000, 700000, 2) },
    },
    {
      id: 'codex', name: 'Codex', accent: '#b28cff', kind: 'local', status: 'ok', updatedAt: now - 40e3,
      headline: { value: '34%', label: '5-hour limit used' },
      meters: [
        { label: '5-hour limit', pct: 34, detail: '34% · resets in 3h 12m' },
        { label: 'Weekly limit', pct: 71, detail: '71% · resets in 2d 4h' },
      ],
      stats: [{ label: 'Tokens today', value: '1.2M' }, { label: 'Last activity', value: '18m ago' }, { label: 'Plan', value: 'plus' }],
      note: 'Snapshot from your latest Codex session; it updates whenever Codex runs.',
    },
    {
      id: 'grokCli', name: 'Grok CLI', accent: '#8fb8ff', kind: 'local', status: 'ok', updatedAt: now - 30e3,
      headline: { value: '2.1M', label: 'tokens today' },
      meters: [],
      stats: [
        { label: 'Cost today', value: '$3.84' }, { label: 'Month to date', value: '$89.42' },
        { label: 'Top model', value: 'grok-4.7' }, { label: 'Cache hits', value: '74%' }, { label: 'Last activity', value: '6m ago' },
      ],
      spark: { label: 'tokens / hour, today', points: wave(8, 300000, 250000, 4) },
      note: 'Cost is what Grok CLI reports locally (API-equivalent price), not a subscription bill.',
    },
    {
      id: 'copilot', name: 'GitHub Copilot', accent: '#7d8590', kind: 'remote', status: 'ok', updatedAt: now - 2 * 60e3,
      headline: { value: '41%', label: 'premium requests used' },
      meters: [
        { label: 'Premium requests', pct: 41, detail: '123/300 · resets in 2d 19h' },
      ],
      stats: [{ label: 'Chat', value: 'unlimited' }, { label: 'Completions', value: 'unlimited' }, { label: 'Plan', value: 'copilot pro' }, { label: 'Resets', value: '2026-10-01' }],
    },
    {
      id: 'geminiCli', name: 'Gemini CLI', accent: '#4f9dff', kind: 'local', status: 'ok', updatedAt: now - 50e3,
      headline: { value: '640K', label: 'tokens today' },
      meters: [],
      stats: [{ label: 'Output today', value: '18K' }, { label: 'Last 7 days', value: '3.2M' }, { label: 'Top model', value: '3.1-pro-preview' }, { label: 'Last activity', value: '1h ago' }],
      spark: { label: 'tokens / hour, today', points: wave(8, 80000, 60000, 6) },
    },
    {
      id: 'anthropic', name: 'Claude API', accent: '#d97757', kind: 'remote', status: 'ok', updatedAt: now - 3 * 60e3,
      headline: { value: '$42.18', label: 'month to date' },
      meters: [{ label: 'Monthly budget $100.00', pct: 42, detail: '42%' }],
      stats: [
        { label: 'Today (UTC)', value: '$3.07' }, { label: 'Tokens 24h', value: '6.1M' },
        { label: 'In / Out 24h', value: '5.7M / 412K' }, { label: 'Cache hits', value: '63%' },
      ],
      spark: { label: 'tokens / hour, last 24h', points: wave(24, 250000, 200000, 3) },
    },
    {
      id: 'xai', name: 'xAI API', accent: '#6ea8fe', kind: 'remote', status: 'error', updatedAt: now - 11 * 60e3,
      error: 'Rate limited: will retry on the next poll',
      headline: { value: '$7.90', label: 'month to date' },
      meters: [{ label: 'Spending limit $200.00', pct: 4, detail: '$7.90 used' }],
      stats: [
        { label: 'Today', value: '$0.44' }, { label: 'Top model', value: 'grok-4-fast' },
        { label: 'Postpaid bill', value: '$7.90' }, { label: 'Prepaid credit', value: '$25.00' },
      ],
      spark: { label: 'USD / day, this month', points: wave(28, 30, 25, 5) },
    },
    { id: 'openai', name: 'OpenAI API', accent: '#10a37f', kind: 'remote', status: 'unconfigured' },
  ];
}

module.exports = { demoCards };
