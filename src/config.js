'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  pollMinutes: 5,
  alwaysOnTop: true,
  startAtLogin: false,
  forceX11: true,
  opacity: 1,
  theme: 'system',
  density: 'normal', // compact | normal | detailed
  autoFit: true, // window height follows its content
  order: ['claudeCode', 'codex', 'grokCli', 'copilot', 'geminiCli', 'anthropic', 'xai', 'openai'],
  providers: {
    claudeCode: { enabled: true, dir: '' },
    codex: { enabled: true, home: '' },
    grokCli: { enabled: true, home: '' },
    copilot: { enabled: true },
    geminiCli: { enabled: true, home: '' },
    anthropic: { enabled: true, budget: 0 },
    xai: { enabled: true, teamId: '', budget: 0 },
    openai: { enabled: false, budget: 0 },
  },
  window: { width: 340, height: 620 },
};

const DENSITIES = ['compact', 'normal', 'detailed'];

const SECRET_NAMES = ['anthropicAdminKey', 'xaiManagementKey', 'openaiAdminKey', 'githubToken'];

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over.slice() : base.slice();
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (over && typeof over === 'object') {
      for (const k of Object.keys(over)) {
        out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
      }
    }
    return out;
  }
  return over === undefined ? base : over;
}

function writeFileAtomic(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

/** Read only the non-secret config synchronously (safe to call before app 'ready'). */
function readConfigSync(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    const cfg = deepMerge(DEFAULTS, raw);
    // Saved orders predate newer providers; append those so they still show up.
    for (const id of DEFAULTS.order) if (!cfg.order.includes(id)) cfg.order.push(id);
    return cfg;
  } catch {
    return deepMerge(DEFAULTS, {});
  }
}

class Store {
  /**
   * @param {string} dir  userData directory
   * @param {object} safeStorage  Electron safeStorage (or a stub in tests)
   */
  constructor(dir, safeStorage) {
    this.dir = dir;
    this.safeStorage = safeStorage;
    this.config = readConfigSync(dir);
    this.secrets = {};
    this.secretsFile = path.join(dir, 'secrets.json');
    this.loadSecrets();
  }

  encryptionInfo() {
    const ss = this.safeStorage;
    const available = Boolean(ss && ss.isEncryptionAvailable && ss.isEncryptionAvailable());
    let backend = 'unknown';
    try {
      if (ss && ss.getSelectedStorageBackend) backend = ss.getSelectedStorageBackend();
    } catch {
      /* not on linux */
    }
    // 'basic_text' means Chromium fell back to a hard-coded password: effectively obfuscation only.
    const weak = !available || backend === 'basic_text';
    return { available, backend, weak };
  }

  loadSecrets() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8'));
    } catch {
      return;
    }
    for (const name of SECRET_NAMES) {
      const entry = raw[name];
      if (!entry) continue;
      try {
        if (entry.enc && this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
          this.secrets[name] = this.safeStorage.decryptString(Buffer.from(entry.enc, 'base64'));
        } else if (entry.plain) {
          this.secrets[name] = entry.plain;
        }
      } catch {
        /* keyring changed or unavailable; user must re-enter */
      }
    }
  }

  saveSecrets() {
    const out = {};
    const canEncrypt = this.safeStorage && this.safeStorage.isEncryptionAvailable();
    for (const name of SECRET_NAMES) {
      const v = this.secrets[name];
      if (!v) continue;
      out[name] = canEncrypt ? { enc: this.safeStorage.encryptString(v).toString('base64') } : { plain: v };
    }
    writeFileAtomic(this.secretsFile, JSON.stringify(out, null, 2), 0o600);
  }

  saveConfig() {
    writeFileAtomic(path.join(this.dir, 'config.json'), JSON.stringify(this.config, null, 2), 0o644);
  }

  /** Secret value with environment fallback. */
  getSecret(name, envName) {
    return this.secrets[name] || (envName ? process.env[envName] || '' : '');
  }

  /** Which secrets are set, without revealing values. */
  secretFlags(envMap = {}) {
    const flags = {};
    for (const name of SECRET_NAMES) {
      flags[name] = this.secrets[name] ? 'saved' : envMap[name] && process.env[envMap[name]] ? 'env' : '';
    }
    return flags;
  }

  /**
   * Apply settings from the UI.
   * secrets: { name: string }  non-empty string = replace, null = clear, '' or missing = keep.
   */
  update({ config, secrets } = {}) {
    if (config && typeof config === 'object') {
      const clean = { ...config };
      delete clean.window;
      this.config = deepMerge(this.config, clean);
      const pm = Number(this.config.pollMinutes);
      this.config.pollMinutes = Number.isFinite(pm) ? Math.min(120, Math.max(1, Math.round(pm))) : DEFAULTS.pollMinutes;
      const op = Number(this.config.opacity);
      this.config.opacity = Number.isFinite(op) ? Math.min(1, Math.max(0.4, op)) : 1;
      if (!DENSITIES.includes(this.config.density)) this.config.density = DEFAULTS.density;
      this.saveConfig();
    }
    if (secrets && typeof secrets === 'object') {
      let changed = false;
      for (const name of SECRET_NAMES) {
        if (!(name in secrets)) continue;
        const v = secrets[name];
        if (v === null) {
          delete this.secrets[name];
          changed = true;
        } else if (typeof v === 'string' && v.trim()) {
          this.secrets[name] = v.trim();
          changed = true;
        }
      }
      if (changed) this.saveSecrets();
    }
  }

  setWindowBounds(b) {
    this.config.window = { ...this.config.window, ...b };
    this.saveConfig();
  }
}

module.exports = { Store, readConfigSync, DEFAULTS, DENSITIES, SECRET_NAMES, deepMerge };
