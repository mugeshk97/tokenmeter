'use strict';

const { httpJson, num, clampPct, fmtDuration } = require('./util');

const QUOTAS = [
  ['premium_interactions', 'Premium requests'],
  ['chat', 'Chat'],
  ['completions', 'Completions'],
];

/**
 * GitHub Copilot quota for the token's account. Uses the same (undocumented)
 * endpoint as the Copilot editor extensions: /copilot_internal/user.
 */
async function fetchCopilot({ token }, { fetchImpl, now = new Date() } = {}) {
  let user;
  try {
    user = await httpJson('https://api.github.com/copilot_internal/user', {
      headers: { authorization: `token ${token}`, 'x-github-api-version': '2025-04-01' },
      fetchImpl,
    });
  } catch (err) {
    if (err.status === 401 || err.status === 404) {
      throw new Error('Token rejected: paste the output of `gh auth token` from the account that has Copilot');
    }
    throw err;
  }

  const nowMs = now.getTime();
  const snaps = user.quota_snapshots || {};
  const resetMs = Date.parse(user.quota_reset_date_utc || user.quota_reset_date || '') || null;
  const resetText = resetMs ? `resets in ${fmtDuration(resetMs - nowMs)}` : null;

  const meters = [];
  const stats = [];
  let overage = 0;
  for (const [key, label] of QUOTAS) {
    const q = snaps[key];
    if (!q) continue;
    overage += num(q.overage_count);
    if (q.unlimited) {
      stats.push({ label, value: 'unlimited' });
      continue;
    }
    const entitlement = num(q.entitlement);
    if (entitlement <= 0) continue;
    const remaining = num(q.remaining ?? q.quota_remaining);
    const pct = clampPct(q.percent_remaining != null ? 100 - num(q.percent_remaining) : ((entitlement - remaining) / entitlement) * 100);
    const used = Math.max(0, Math.round(entitlement - remaining));
    meters.push({ key, label, pct, detail: `${used}/${entitlement}${resetText ? ` · ${resetText}` : ''}` });
  }

  // Premium requests matter most; otherwise show whichever quota is closest to running out.
  const main = meters.find((m) => m.key === 'premium_interactions') || [...meters].sort((a, b) => b.pct - a.pct)[0];
  const headline = main
    ? { value: `${Math.round(main.pct)}%`, label: `${main.label.toLowerCase()} used` }
    : { value: '-', label: 'no metered quota' };

  const plan = user.access_type_sku || user.copilot_plan;
  if (plan) stats.push({ label: 'Plan', value: String(plan).replace(/_/g, ' ') });
  if (resetMs) stats.push({ label: 'Resets', value: new Date(resetMs).toISOString().slice(0, 10) });
  if (overage > 0) stats.push({ label: 'Overage', value: String(overage) });

  return {
    headline,
    meters: meters.map(({ key: _k, ...m }) => m),
    stats,
    spark: null,
    note: meters.length ? null : 'This plan has no metered Copilot quota.',
  };
}

module.exports = { fetchCopilot };
