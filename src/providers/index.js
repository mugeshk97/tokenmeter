'use strict';

const { fetchAnthropic } = require('./anthropic');
const { fetchXai } = require('./xai');
const { fetchOpenAI } = require('./openai');
const { fetchCodex } = require('./codex');
const { fetchClaudeCode } = require('./claudeCode');
const { fetchGrokCli } = require('./grokCli');
const { fetchGeminiCli } = require('./geminiCli');
const { fetchCopilot } = require('./copilot');

/**
 * kind: 'remote' polls on the user interval; 'local' re-reads files every minute.
 * secrets: names of secrets the provider needs (stored encrypted, never sent to the UI).
 * env: optional environment-variable fallbacks.
 */
const PROVIDERS = [
  {
    id: 'claudeCode',
    name: 'Claude Code',
    short: 'Claude Code', // tile label in compact/normal sizes
    kind: 'local',
    accent: '#e8a87c',
    console: 'https://claude.ai/settings/usage',
    secrets: [],
    isConfigured: () => true,
    run: (cfg) => fetchClaudeCode({ dir: cfg.dir }),
  },
  {
    id: 'codex',
    name: 'Codex',
    short: 'Codex',
    kind: 'local',
    accent: '#b28cff',
    console: 'https://chatgpt.com/codex/settings/usage',
    secrets: [],
    isConfigured: () => true,
    run: (cfg) => fetchCodex({ home: cfg.home }),
  },
  {
    id: 'grokCli',
    name: 'Grok CLI',
    short: 'Grok CLI',
    kind: 'local',
    accent: '#8fb8ff',
    console: 'https://grok.com',
    secrets: [],
    isConfigured: () => true,
    run: (cfg) => fetchGrokCli({ home: cfg.home }),
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    short: 'Copilot',
    kind: 'remote',
    accent: '#7d8590',
    console: 'https://github.com/settings/copilot',
    secrets: ['githubToken'],
    env: { githubToken: 'GITHUB_TOKEN' },
    isConfigured: (cfg, s) => Boolean(s.githubToken),
    run: (cfg, s, ctx) => fetchCopilot({ token: s.githubToken }, ctx),
  },
  {
    id: 'geminiCli',
    name: 'Gemini CLI',
    short: 'Gemini CLI',
    kind: 'local',
    accent: '#4f9dff',
    console: 'https://aistudio.google.com/usage',
    secrets: [],
    isConfigured: () => true,
    run: (cfg) => fetchGeminiCli({ home: cfg.home }),
  },
  {
    id: 'anthropic',
    name: 'Claude API',
    short: 'Claude API',
    kind: 'remote',
    accent: '#d97757',
    console: 'https://platform.claude.com/usage',
    secrets: ['anthropicAdminKey'],
    env: { anthropicAdminKey: 'ANTHROPIC_ADMIN_KEY' },
    isConfigured: (cfg, s) => Boolean(s.anthropicAdminKey),
    run: (cfg, s, ctx) => fetchAnthropic({ adminKey: s.anthropicAdminKey, budget: Number(cfg.budget) || 0 }, ctx),
  },
  {
    id: 'xai',
    name: 'xAI API',
    short: 'xAI API',
    kind: 'remote',
    accent: '#6ea8fe',
    console: 'https://console.x.ai',
    secrets: ['xaiManagementKey'],
    env: { xaiManagementKey: 'XAI_MANAGEMENT_API_KEY' },
    isConfigured: (cfg, s) => Boolean(s.xaiManagementKey && (cfg.teamId || process.env.XAI_TEAM_ID)),
    run: (cfg, s, ctx) => fetchXai({ managementKey: s.xaiManagementKey, teamId: cfg.teamId || process.env.XAI_TEAM_ID, budget: Number(cfg.budget) || 0 }, ctx),
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    short: 'OpenAI API',
    kind: 'remote',
    accent: '#10a37f',
    console: 'https://platform.openai.com/usage',
    secrets: ['openaiAdminKey'],
    env: { openaiAdminKey: 'OPENAI_ADMIN_KEY' },
    isConfigured: (cfg, s) => Boolean(s.openaiAdminKey),
    run: (cfg, s, ctx) => fetchOpenAI({ adminKey: s.openaiAdminKey, budget: Number(cfg.budget) || 0 }, ctx),
  },
];

module.exports = { PROVIDERS };
