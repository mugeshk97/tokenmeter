'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fetchAnthropic } = require('../src/providers/anthropic');
const { fetchXai } = require('../src/providers/xai');
const { fetchOpenAI } = require('../src/providers/openai');
const { fetchCodex } = require('../src/providers/codex');
const { fetchClaudeCode, buildBlocks } = require('../src/providers/claudeCode');
const { fetchCopilot } = require('../src/providers/copilot');
const { fetchGrokCli } = require('../src/providers/grokCli');
const { fetchGeminiCli } = require('../src/providers/geminiCli');
const { Store } = require('../src/config');
const { Poller } = require('../src/poller');

function mockFetch(routes, log = []) {
  return async (url, init = {}) => {
    log.push({ url, init });
    for (const [re, handler] of routes) {
      if (re.test(url)) {
        const out = typeof handler === 'function' ? handler(url, init) : handler;
        const status = out.status || 200;
        return { ok: status < 400, status, text: async () => JSON.stringify(out.body ?? out) };
      }
    }
    return { ok: false, status: 404, text: async () => '{"error":{"message":"no route"}}' };
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aiu-'));
}

// ---------------------------------------------------------------- Anthropic
test('anthropic: sums hourly tokens, converts cost cents, follows pagination', async () => {
  const now = new Date('2026-09-28T10:30:00Z');
  const log = [];
  const fetchImpl = mockFetch(
    [
      [
        /usage_report\/messages.*page=p2/,
        {
          data: [{ starting_at: '2026-09-28T10:00:00Z', results: [{ uncached_input_tokens: 100, cache_read_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100 }, output_tokens: 50 }] }],
          has_more: false,
          next_page: null,
        },
      ],
      [
        /usage_report\/messages/,
        {
          data: [{ starting_at: '2026-09-28T09:00:00Z', results: [{ uncached_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 200 }] }],
          has_more: true,
          next_page: 'p2',
        },
      ],
      [
        /cost_report/,
        {
          data: [
            { starting_at: '2026-09-27T00:00:00Z', results: [{ currency: 'USD', amount: '1250.5' }] },
            { starting_at: '2026-09-28T00:00:00Z', results: [{ currency: 'USD', amount: '300' }, { currency: 'USD', amount: '49.5' }] },
          ],
          has_more: false,
        },
      ],
    ],
    log
  );

  const card = await fetchAnthropic({ adminKey: 'sk-ant-admin01-test', budget: 100 }, { fetchImpl, now });
  assert.equal(card.headline.value, '$16.00'); // (1250.5 + 349.5) cents
  const stat = Object.fromEntries(card.stats.map((s) => [s.label, s.value]));
  assert.equal(stat['Today (UTC)'], '$3.50');
  assert.equal(stat['Tokens 24h'], '1.8K'); // 1200 + 550
  assert.equal(stat['Cache hits'], '20%'); // 300 / (1100+300+100)
  assert.deepEqual(card.spark.points, [1200, 550]);
  assert.equal(card.meters[0].pct, 16);

  const first = log[0];
  assert.equal(first.init.headers['x-api-key'], 'sk-ant-admin01-test');
  assert.equal(first.init.headers['anthropic-version'], '2023-06-01');
  assert.match(first.url, /starting_at=2026-09-27T11%3A00%3A00Z/);
  assert.match(first.url, /bucket_width=1h/);
  assert.ok(log.some((l) => /cost_report\?starting_at=2026-09-01T00%3A00%3A00Z/.test(l.url)));
});

test('anthropic: 401 produces a friendly error without the key', async () => {
  const fetchImpl = mockFetch([[/./, { status: 401, body: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } }]]);
  await assert.rejects(fetchAnthropic({ adminKey: 'sk-ant-secret' }, { fetchImpl }), (err) => {
    assert.match(err.message, /Unauthorized/);
    assert.doesNotMatch(err.message, /sk-ant-secret/);
    return true;
  });
});

// ---------------------------------------------------------------- xAI
test('xai: month-to-date from usage series, limit meter from invoice, tolerates balance failure', async () => {
  const log = [];
  const fetchImpl = mockFetch(
    [
      [
        /\/usage$/,
        {
          timeSeries: [
            { groupLabels: ['Chat grok-4-0709'], dataPoints: [{ timestamp: '2026-09-27T00:00:00Z', values: [1.5] }, { timestamp: '2026-09-28T00:00:00Z', values: [0.25] }] },
            { groupLabels: ['grok-2-image-1212'], dataPoints: [{ timestamp: '2026-09-27T00:00:00Z', values: [0.14] }, { timestamp: '2026-09-28T00:00:00Z', values: [0] }] },
          ],
          limitReached: false,
        },
      ],
      [/invoice\/preview/, { coreInvoice: { amountBeforeVat: '189', amountAfterVat: '189' }, effectiveSpendingLimit: '20000', billingCycle: { year: 2026, month: 9 } }],
      [/prepaid\/balance/, { status: 500, body: { message: 'boom' } }],
    ],
    log
  );
  const card = await fetchXai({ managementKey: 'xai-mgmt', teamId: 'team-1' }, { fetchImpl, now: new Date('2026-09-28T08:00:00Z'), timeZone: 'Asia/Kolkata' });
  assert.equal(card.headline.value, '$1.89');
  const stat = Object.fromEntries(card.stats.map((s) => [s.label, s.value]));
  assert.equal(stat.Today, '$0.25');
  assert.equal(stat['Top model'], 'grok-4-0709');
  assert.equal(stat['Postpaid bill'], '$1.89');
  assert.equal(card.meters[0].label, 'Spending limit $200.00');
  assert.ok(card.meters[0].pct > 0.9 && card.meters[0].pct < 1);

  const usageCall = log.find((l) => /\/usage$/.test(l.url));
  assert.equal(usageCall.init.method, 'POST');
  assert.equal(usageCall.init.headers.authorization, 'Bearer xai-mgmt');
  const body = JSON.parse(usageCall.init.body);
  assert.equal(body.analyticsRequest.timeRange.timezone, 'Asia/Kolkata');
  assert.equal(body.analyticsRequest.timeUnit, 'TIME_UNIT_DAY');
  assert.match(usageCall.url, /\/v1\/billing\/teams\/team-1\/usage$/);
});

test('xai: prepaid balance sign convention', async () => {
  const fetchImpl = mockFetch([
    [/\/usage$/, { timeSeries: [] }],
    [/invoice\/preview/, { coreInvoice: {}, effectiveSpendingLimit: '0' }],
    [/prepaid\/balance/, { changes: [], total: { val: '-2500' } }],
  ]);
  const card = await fetchXai({ managementKey: 'k', teamId: 't' }, { fetchImpl });
  const stat = Object.fromEntries(card.stats.map((s) => [s.label, s.value]));
  assert.equal(stat['Prepaid credit'], '$25.00');
  assert.equal(card.meters.length, 0);
});

// ---------------------------------------------------------------- OpenAI
test('openai: costs in dollars, tokens per hour', async () => {
  const now = new Date('2026-09-28T10:30:00Z');
  const today = Date.UTC(2026, 8, 28) / 1000;
  const fetchImpl = mockFetch([
    [
      /organization\/costs/,
      {
        data: [
          { start_time: today - 86400, results: [{ amount: { value: 2.5, currency: 'usd' } }] },
          { start_time: today, results: [{ amount: { value: 0.75, currency: 'usd' } }] },
        ],
        has_more: false,
      },
    ],
    [/usage\/completions/, { data: [{ start_time: 1, results: [{ input_tokens: 1000, output_tokens: 500, input_cached_tokens: 500, num_model_requests: 3 }] }], has_more: false }],
  ]);
  const card = await fetchOpenAI({ adminKey: 'sk-admin-x' }, { fetchImpl, now });
  assert.equal(card.headline.value, '$3.25');
  const stat = Object.fromEntries(card.stats.map((s) => [s.label, s.value]));
  assert.equal(stat['Today (UTC)'], '$0.75');
  assert.equal(stat['Tokens 24h'], '1.5K');
  assert.equal(stat['Requests 24h'], '3');
});

// ---------------------------------------------------------------- Codex (local)
test('codex: reads latest rate-limit snapshot and today tokens (nested format)', async () => {
  const home = tmpdir();
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const dir = path.join(home, 'sessions', String(y), m, d);
  fs.mkdirSync(dir, { recursive: true });
  const yesterday = new Date(now.getTime() - 26 * 3600e3).toISOString();
  const t1 = new Date(now.getTime() - 60e3).toISOString();
  const lines = [
    { timestamp: yesterday, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1000 } }, rate_limits: null } },
    { timestamp: t1, type: 'response_item', payload: { type: 'message' } },
    {
      timestamp: t1,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: 4500 } },
        rate_limits: { primary: { used_percent: 34.0, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 71.5, window_minutes: 10080, resets_at: Math.floor(now.getTime() / 1000) + 2 * 86400 }, plan_type: 'plus' },
      },
    },
  ];
  fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"partial":');

  const card = await fetchCodex({ home }, { now });
  assert.equal(card.headline.value, '34%');
  assert.equal(card.meters[0].label, '5-hour limit');
  assert.match(card.meters[0].detail, /^34% · resets in 59m$/); // event was 1 min ago with 3600s left
  assert.equal(card.meters[1].label, 'Weekly limit');
  assert.equal(Math.round(card.meters[1].pct), 72);
  const stat = Object.fromEntries(card.stats.map((s) => [s.label, s.value]));
  assert.equal(stat['Tokens today'], '3.5K'); // 4500 - 1000 carried from yesterday
  assert.equal(stat.Plan, 'plus');
});

test('codex: flat legacy format and expired window', async () => {
  const home = tmpdir();
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const t = new Date(now.getTime() - 6 * 3600e3).toISOString();
  const line = {
    timestamp: t,
    type: 'event_msg',
    payload: { type: 'token_count', info: null, rate_limits: { primary_used_percent: 90, primary_window_minutes: 300, primary_resets_in_seconds: 600, secondary_used_percent: 10, secondary_window_minutes: 10080, secondary_resets_in_seconds: 86400 } },
  };
  fs.writeFileSync(path.join(dir, 'rollout-old.jsonl'), JSON.stringify(line) + '\n');
  const card = await fetchCodex({ home }, { now });
  assert.equal(card.meters[0].pct, 0);
  assert.match(card.meters[0].detail, /reset since last use/);
  assert.equal(card.meters[1].pct, 10);
});

test('codex: missing folder gives a clear error', async () => {
  await assert.rejects(fetchCodex({ home: path.join(tmpdir(), 'nope') }), /No Codex sessions/);
});

// ---------------------------------------------------------------- Claude Code (local)
test('claude code: dedupes streamed lines and finds the active 5h block', async () => {
  const root = tmpdir();
  const proj = path.join(root, 'projects', '-home-me-app');
  fs.mkdirSync(proj, { recursive: true });
  const now = new Date();
  const mk = (minsAgo, id, req, out, model = 'claude-opus-4-7-20260601') => ({
    type: 'assistant',
    timestamp: new Date(now.getTime() - minsAgo * 60e3).toISOString(),
    requestId: req,
    message: { id, model, usage: { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } },
  });
  const lines = [mk(30, 'msg_1', 'req_1', 50), mk(30, 'msg_1', 'req_1', 50), mk(10, 'msg_2', 'req_2', 200), { type: 'user', message: { content: 'hi' } }];
  fs.writeFileSync(path.join(proj, 's.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));

  const card = await fetchClaudeCode({ dir: root }, { now });
  // two unique messages: (10+50+100+1000) + (10+200+100+1000)
  assert.equal(card.headline.value, '2.5K');
  assert.equal(card.headline.label, 'tokens this session');
  assert.equal(card.meters[0].label, '5-hour session window');
  const stat = Object.fromEntries(card.stats.map((s) => [s.label, s.value]));
  assert.equal(stat['Top model'], 'opus-4-7');
});

test('claude code: blocks split on 5h gaps', () => {
  const H = 3600e3;
  const base = Date.UTC(2026, 8, 28, 0, 20);
  const blocks = buildBlocks([
    { ts: base, total: 1, output: 0 },
    { ts: base + 2 * H, total: 1, output: 0 },
    { ts: base + 4.5 * H, total: 1, output: 0 }, // 04:50, still inside block 00:00-05:00
    { ts: base + 5.2 * H, total: 1, output: 0 }, // past 05:00 -> new block
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].start, Date.UTC(2026, 8, 28, 0, 0));
  assert.equal(blocks[0].tokens, 3);
});

// ---------------------------------------------------------------- Config store
test('store: encrypts secrets, blank keeps, null clears, env fallback', () => {
  const dir = tmpdir();
  const ss = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (s) => Buffer.from(`ENC:${s}`),
    decryptString: (b) => b.toString().replace(/^ENC:/, ''),
  };
  const s1 = new Store(dir, ss);
  s1.update({ config: { pollMinutes: 0, providers: { xai: { teamId: 'abc' } } }, secrets: { anthropicAdminKey: ' sk-ant-admin01-x ' } });
  assert.equal(s1.config.pollMinutes, 1);
  assert.equal(s1.config.providers.xai.teamId, 'abc');
  assert.equal(s1.config.providers.xai.enabled, true); // defaults preserved
  const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
  assert.doesNotMatch(raw, /sk-ant-admin01-x/);

  const s2 = new Store(dir, ss);
  assert.equal(s2.getSecret('anthropicAdminKey'), 'sk-ant-admin01-x');
  s2.update({ secrets: { anthropicAdminKey: '' } });
  assert.equal(s2.getSecret('anthropicAdminKey'), 'sk-ant-admin01-x');
  s2.update({ secrets: { anthropicAdminKey: null } });
  assert.equal(s2.getSecret('anthropicAdminKey'), '');

  process.env.AIU_TEST_KEY = 'from-env';
  assert.equal(s2.getSecret('openaiAdminKey', 'AIU_TEST_KEY'), 'from-env');
  assert.equal(s2.secretFlags({ openaiAdminKey: 'AIU_TEST_KEY' }).openaiAdminKey, 'env');
  delete process.env.AIU_TEST_KEY;
  assert.equal(s2.encryptionInfo().weak, false);
});

// ---------------------------------------------------------------- Copilot
function copilotUser(over = {}) {
  const snap = (id, entitlement, remaining, extra = {}) => ({
    quota_id: id, entitlement, remaining, quota_remaining: remaining, unlimited: false, overage_count: 0,
    percent_remaining: entitlement ? (remaining / entitlement) * 100 : 0, ...extra,
  });
  return {
    login: 'me', copilot_plan: 'individual', access_type_sku: 'free_limited_copilot',
    quota_reset_date_utc: '2026-10-01T00:00:00.000Z',
    quota_snapshots: {
      chat: snap('chat', 200, 200),
      completions: snap('completions', 2000, 1881),
      premium_interactions: snap('premium_interactions', 0, 0),
    },
    ...over,
  };
}

test('copilot: quota meters, most-used headline when no premium quota, token header', async () => {
  const log = [];
  const fetchImpl = mockFetch([[/copilot_internal\/user/, copilotUser()]], log);
  const out = await fetchCopilot({ token: 'gho_secret' }, { fetchImpl, now: new Date('2026-09-28T00:00:00Z') });
  assert.equal(log[0].init.headers.authorization, 'token gho_secret');
  assert.deepEqual(out.meters.map((m) => m.label), ['Chat', 'Completions']);
  assert.equal(Math.round(out.meters[1].pct), 6);
  assert.match(out.meters[1].detail, /^119\/2000 · resets in 3d/);
  assert.equal(out.headline.label, 'completions used'); // most-used quota when premium has none
  assert.equal(out.headline.value, '6%');
  assert.ok(out.stats.some((s) => s.label === 'Resets' && s.value === '2026-10-01'));
});

test('copilot: premium headline and unlimited quotas as stats', async () => {
  const user = copilotUser();
  user.quota_snapshots.premium_interactions = { entitlement: 300, remaining: 225, percent_remaining: 75, unlimited: false, overage_count: 2 };
  user.quota_snapshots.chat = { unlimited: true, entitlement: 0 };
  user.quota_snapshots.completions = { unlimited: true, entitlement: 0 };
  const out = await fetchCopilot({ token: 't' }, { fetchImpl: mockFetch([[/copilot_internal/, user]]) });
  assert.equal(out.headline.value, '25%');
  assert.equal(out.headline.label, 'premium requests used');
  assert.equal(out.meters.length, 1);
  assert.ok(out.stats.some((s) => s.label === 'Chat' && s.value === 'unlimited'));
  assert.ok(out.stats.some((s) => s.label === 'Overage' && s.value === '2'));
});

test('copilot: 401 gives a friendly error without the token', async () => {
  const fetchImpl = mockFetch([[/copilot_internal/, { status: 401, body: { message: 'Bad credentials' } }]]);
  await assert.rejects(fetchCopilot({ token: 'gho_leakcheck' }, { fetchImpl }), (err) => {
    assert.match(err.message, /Token rejected/);
    assert.doesNotMatch(err.message, /gho_leakcheck/);
    return true;
  });
});

// ---------------------------------------------------------------- Grok CLI
function grokTurn(tsSec, { input, output, cached = 0, ticks, model = 'grok-4.6-build' }) {
  const usage = { inputTokens: input, outputTokens: output, totalTokens: input + output, cachedReadTokens: cached, costUsdTicks: ticks };
  return JSON.stringify({
    timestamp: tsSec,
    method: '_x.ai/session/update',
    params: { sessionId: 's', update: { sessionUpdate: 'turn_completed', usage: { ...usage, modelUsage: { [model]: usage } } }, _meta: { agentTimestampMs: tsSec * 1000 } },
  });
}

test('grok cli: sums per-turn usage today, converts cost ticks, month to date', async () => {
  const home = tmpdir();
  const dir = path.join(home, 'sessions', '%2Fproj', 'sess1');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date(2026, 8, 28, 12, 0, 0);
  const sec = (d) => Math.floor(d.getTime() / 1000);
  fs.writeFileSync(
    path.join(dir, 'updates.jsonl'),
    [
      grokTurn(sec(new Date(2026, 8, 27, 10)), { input: 5000, output: 100, ticks: 5e9 }), // yesterday, $0.50
      '{"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}',
      grokTurn(sec(new Date(2026, 8, 28, 9)), { input: 1000, output: 200, cached: 500, ticks: 1e9 }), // $0.10
      grokTurn(sec(new Date(2026, 8, 28, 11)), { input: 3000, output: 300, cached: 1500, ticks: 2e9, model: 'grok-4.7' }), // $0.20
    ].join('\n') + '\n'
  );
  fs.writeFileSync(path.join(home, 'sessions', '%2Fproj', 'prompt_history.jsonl'), '{"prompt":"hi"}\n');

  const out = await fetchGrokCli({ home }, { now });
  const stat = (l) => out.stats.find((s) => s.label === l).value;
  assert.equal(out.headline.value, '4.5K'); // 1200 + 3300, summed not max
  assert.equal(stat('Cost today'), '$0.30');
  assert.equal(stat('Month to date'), '$0.80');
  assert.equal(stat('Top model'), 'grok-4.7');
  assert.equal(stat('Cache hits'), '50%');
  assert.equal(out.spark.points[9], 1200);
  assert.equal(out.spark.points[11], 3300);
});

test('grok cli: missing folder gives a clear error', async () => {
  await assert.rejects(fetchGrokCli({ home: path.join(tmpdir(), 'nope') }), /No Grok CLI sessions/);
});

// ---------------------------------------------------------------- Gemini CLI
test('gemini cli: tokens today, dedupes messages across files, ignores logs.json', async () => {
  const home = tmpdir();
  const chats = path.join(home, 'tmp', 'abc123', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const msg = (id, d, total, model = 'gemini-3-flash-preview') => ({ id, timestamp: d.toISOString(), type: 'gemini', model, tokens: { input: total - 10, output: 10, total } });
  const today = (h) => new Date(2026, 8, 28, h);
  const a = { sessionId: 's', messages: [{ id: 'u1', type: 'user', content: 'hi', timestamp: today(8).toISOString() }, msg('m1', today(8), 1000), msg('m0', new Date(2026, 8, 26, 8), 400)] };
  const b = { sessionId: 's', messages: [msg('m1', today(8), 1000), msg('m2', today(10), 3000, 'gemini-3.1-pro-preview')] };
  fs.writeFileSync(path.join(chats, 'session-2026-09-28T08-00-aaaa.json'), JSON.stringify(a));
  fs.writeFileSync(path.join(chats, 'session-2026-09-28T10-00-aaaa.json'), JSON.stringify(b));
  fs.writeFileSync(path.join(home, 'tmp', 'abc123', 'logs.json'), JSON.stringify([{ tokens: { total: 99999 } }]));

  const out = await fetchGeminiCli({ home }, { now: new Date(2026, 8, 28, 12) });
  const stat = (l) => out.stats.find((s) => s.label === l).value;
  assert.equal(out.headline.value, '4.0K');
  assert.equal(stat('Last 7 days'), '4.4K');
  assert.equal(stat('Top model'), '3.1-pro-preview');
  assert.equal(stat('Output today'), '20');
});

// ---------------------------------------------------------------- Config migration
test('store: saved order from before new providers gets them appended', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ order: ['xai', 'claudeCode', 'codex', 'anthropic', 'openai'] }));
  const s = new Store(dir, null);
  assert.deepEqual(s.config.order.slice(0, 5), ['xai', 'claudeCode', 'codex', 'anthropic', 'openai']);
  for (const id of ['grokCli', 'copilot', 'geminiCli']) assert.ok(s.config.order.includes(id));
  assert.equal(s.config.providers.copilot.enabled, true);
});

// ---------------------------------------------------------------- Poller
test('poller: keeps last good data when a refresh fails', async () => {
  let fail = false;
  const provider = {
    id: 'p',
    name: 'P',
    kind: 'remote',
    secrets: [],
    isConfigured: () => true,
    run: async () => {
      if (fail) throw new Error('Rate limited');
      return { headline: { value: '$1.00', label: 'mtd' } };
    },
  };
  let last;
  const poller = new Poller({
    providers: [provider],
    getConfig: () => ({ order: ['p'], providers: { p: { enabled: true } } }),
    getSecret: () => '',
    onUpdate: (cards) => (last = cards),
  });
  await poller.refresh();
  assert.equal(last[0].status, 'ok');
  fail = true;
  await poller.refresh();
  assert.equal(last[0].status, 'error');
  assert.equal(last[0].headline.value, '$1.00');
  assert.equal(last[0].error, 'Rate limited');
});
