'use strict';

const { httpJson, startOfLocalMonth, num, fmtUSD, clampPct, capHeadline, budgetMeter } = require('./util');

const BASE = 'https://management-api.x.ai';

function pad(n) {
  return String(n).padStart(2, '0');
}

/** "YYYY-MM-DD HH:mm:ss" in local wall-clock time (used with an explicit timezone). */
function localStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function shortModel(label) {
  return String(label || '').replace(/^Chat\s+/i, '').trim() || '-';
}

/**
 * Grok / xAI API via the Management API.
 * Needs a Management Key (console.x.ai -> Settings -> Management Keys) and the team ID.
 */
async function fetchXai({ managementKey, teamId, budget = 0 }, { fetchImpl, now = new Date(), timeZone } = {}) {
  if (!managementKey) throw new Error('No Management Key set');
  if (!teamId) throw new Error('No team ID set');
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/GMT';
  const headers = { authorization: `Bearer ${managementKey}` };
  const team = encodeURIComponent(teamId);

  const usageReq = httpJson(`${BASE}/v1/billing/teams/${team}/usage`, {
    method: 'POST',
    headers,
    fetchImpl,
    body: {
      analyticsRequest: {
        timeRange: { startTime: localStamp(startOfLocalMonth(now)), endTime: localStamp(now), timezone: tz },
        timeUnit: 'TIME_UNIT_DAY',
        values: [{ name: 'usd', aggregation: 'AGGREGATION_SUM' }],
        groupBy: ['description'],
        filters: [],
      },
    },
  });
  const invoiceReq = httpJson(`${BASE}/v1/billing/teams/${team}/postpaid/invoice/preview`, { headers, fetchImpl });
  const balanceReq = httpJson(`${BASE}/v1/billing/teams/${team}/prepaid/balance`, { headers, fetchImpl });

  const [usageR, invoiceR, balanceR] = await Promise.allSettled([usageReq, invoiceReq, balanceReq]);
  if (usageR.status === 'rejected' && invoiceR.status === 'rejected') throw usageR.reason;

  const warnings = [];
  const stats = [];
  const meters = [];
  const caps = []; // spending caps, for the "left" headline
  let mtd = null;
  let today = null;
  let spark = null;

  if (usageR.status === 'fulfilled') {
    const series = Array.isArray(usageR.value.timeSeries) ? usageR.value.timeSeries : [];
    const byDay = new Map();
    let top = null;
    for (const s of series) {
      let sum = 0;
      for (const p of s.dataPoints || []) {
        const v = num(Array.isArray(p.values) ? p.values[0] : p.value);
        sum += v;
        const key = String(p.timestamp).slice(0, 10);
        byDay.set(key, (byDay.get(key) || 0) + v);
      }
      const label = (s.groupLabels && s.groupLabels[0]) || (s.group && s.group[0]);
      if (!top || sum > top.sum) top = { label, sum };
    }
    const days = [...byDay.keys()].sort();
    mtd = days.reduce((acc, k) => acc + byDay.get(k), 0);
    today = days.length ? byDay.get(days[days.length - 1]) : 0;
    stats.push({ label: 'Month to date', value: fmtUSD(mtd) });
    stats.push({ label: 'Today', value: fmtUSD(today) });
    stats.push({ label: 'Top model', value: top && top.sum > 0 ? shortModel(top.label) : '-' });
    spark = { label: 'USD / day, this month', points: days.map((k) => byDay.get(k)) };
    if (usageR.value.limitReached) warnings.push('Usage series truncated by xAI');
  } else {
    warnings.push(`Usage: ${usageR.reason.message}`);
  }

  if (invoiceR.status === 'fulfilled') {
    const inv = invoiceR.value || {};
    const core = inv.coreInvoice || {};
    const postpaid = num(core.amountAfterVat ?? core.amountBeforeVat) / 100;
    const limit = num(inv.effectiveSpendingLimit) / 100;
    stats.push({ label: 'Postpaid bill', value: fmtUSD(postpaid) });
    if (limit > 0) {
      meters.push({ label: `Spending limit ${fmtUSD(limit)}`, pct: clampPct((postpaid / limit) * 100), detail: `${fmtUSD(postpaid)} used` });
      caps.push({ spent: postpaid, cap: limit, what: 'limit' });
    }
  } else {
    warnings.push(`Invoice: ${invoiceR.reason.message}`);
  }

  if (balanceR.status === 'fulfilled') {
    // Ledger convention: credits are negative (a $10 top-up is "-1000" cents).
    const total = num(balanceR.value && balanceR.value.total) / 100;
    stats.push({ label: 'Prepaid credit', value: fmtUSD(Math.max(0, -total)) });
  }

  if (budget > 0 && mtd !== null) {
    meters.push(budgetMeter(mtd, budget));
    caps.push({ spent: mtd, cap: budget, what: 'budget' });
  }

  // Lead with the cap closest to running out; without one, month to date.
  const tight = caps.sort((a, b) => b.spent / b.cap - a.spent / a.cap)[0];
  return {
    headline: tight ? capHeadline(tight.spent, tight.cap, tight.what) : { value: mtd === null ? '-' : fmtUSD(mtd), label: 'month to date' },
    foot: tight ? `${fmtUSD(tight.spent)} ${tight.what === 'limit' ? 'billed' : 'spent'} this month` : today !== null ? `${fmtUSD(today)} today` : null,
    meters,
    stats,
    spark,
    note: warnings.join(' · ') || null,
  };
}

module.exports = { fetchXai, localStamp };
