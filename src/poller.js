'use strict';

const LOCAL_INTERVAL_MS = 60 * 1000;

class Poller {
  /**
   * @param {object} opts
   * @param {Array} opts.providers  provider registry
   * @param {() => object} opts.getConfig
   * @param {(name: string, env?: string) => string} opts.getSecret
   * @param {(cards: object) => void} opts.onUpdate
   * @param {object} [opts.ctx]  passed to providers (e.g. { fetchImpl })
   */
  constructor({ providers, getConfig, getSecret, onUpdate, ctx = {} }) {
    this.providers = providers;
    this.ctx = ctx;
    this.getConfig = getConfig;
    this.getSecret = getSecret;
    this.onUpdate = onUpdate;
    this.cards = {};
    this.inFlight = new Set();
    this.timers = [];
  }

  secretsFor(p) {
    const s = {};
    for (const name of p.secrets || []) s[name] = this.getSecret(name, p.env && p.env[name]);
    return s;
  }

  baseCard(p) {
    return { id: p.id, name: p.name, accent: p.accent, kind: p.kind, console: p.console };
  }

  emit() {
    this.onUpdate(this.snapshot());
  }

  snapshot() {
    const cfg = this.getConfig();
    const order = cfg.order || this.providers.map((p) => p.id);
    const list = [];
    for (const id of order) {
      const p = this.providers.find((x) => x.id === id);
      if (!p) continue;
      const pc = (cfg.providers && cfg.providers[id]) || {};
      if (!pc.enabled) continue;
      list.push(this.cards[id] || { ...this.baseCard(p), status: 'loading' });
    }
    return list;
  }

  async refreshOne(p) {
    const cfg = this.getConfig();
    const pc = (cfg.providers && cfg.providers[p.id]) || {};
    if (!pc.enabled) return;
    const secrets = this.secretsFor(p);
    if (!p.isConfigured(pc, secrets)) {
      this.cards[p.id] = { ...this.baseCard(p), status: 'unconfigured' };
      this.emit();
      return;
    }
    if (this.inFlight.has(p.id)) return;
    this.inFlight.add(p.id);
    const prev = this.cards[p.id];
    if (!prev || prev.status === 'unconfigured') {
      this.cards[p.id] = { ...this.baseCard(p), status: 'loading' };
      this.emit();
    }
    try {
      const data = await p.run(pc, secrets, { ...this.ctx });
      this.cards[p.id] = { ...this.baseCard(p), ...data, status: 'ok', updatedAt: Date.now(), error: null };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      // Keep the last good numbers visible, flagged as stale.
      const keep = prev && prev.status !== 'unconfigured' && prev.updatedAt ? prev : {};
      this.cards[p.id] = { ...this.baseCard(p), ...keep, status: 'error', error: msg, failedAt: Date.now() };
    } finally {
      this.inFlight.delete(p.id);
    }
    this.emit();
  }

  refresh(kind) {
    return Promise.all(this.providers.filter((p) => !kind || p.kind === kind).map((p) => this.refreshOne(p)));
  }

  refreshById(id) {
    const p = this.providers.find((x) => x.id === id);
    return p ? this.refreshOne(p) : Promise.resolve();
  }

  start() {
    this.stop();
    const cfg = this.getConfig();
    const remoteMs = Math.max(1, Number(cfg.pollMinutes) || 5) * 60 * 1000;
    this.refresh();
    this.timers.push(setInterval(() => this.refresh('local'), LOCAL_INTERVAL_MS));
    this.timers.push(setInterval(() => this.refresh('remote'), remoteMs));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Drop cached cards (e.g. after a key change) and restart timers. */
  reset() {
    this.cards = {};
    this.start();
  }
}

module.exports = { Poller };
