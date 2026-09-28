'use strict';

/* global usage */
const api = window.usage;

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c) node.append(c);
  return node;
};
const SVG = 'http://www.w3.org/2000/svg';

let state = { cards: [], meta: {} };
let settingsOpen = false;

// ---------- formatting ----------
function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** One product color for every tool: green until 80% is used, then red. */
function lowClass(left) {
  return left <= 20 ? 'bad' : '';
}

const leftOf = (m) => 100 - Math.max(0, Math.min(100, Number(m.pct) || 0));

/** The meter closest to running out: it drives the headline color, the compact bar and the sort. */
function tightest(c) {
  const meters = c.meters || [];
  return meters.length ? meters.reduce((a, b) => (leftOf(b) < leftOf(a) ? b : a)) : null;
}

/** Sort key for "Nearest limit": least left first, then cards without a limit, then ones not set up. */
function limitKey(c) {
  if (c.status === 'unconfigured') return 1000;
  const t = tightest(c);
  return t ? leftOf(t) : 500;
}

// ---------- cards ----------
function sparkline(points, label) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${label}: ${points.length} bars, peak ${Math.round(Math.max(...points, 0)).toLocaleString()}`);
  svg.setAttribute('viewBox', '0 0 100 26');
  svg.setAttribute('preserveAspectRatio', 'none');
  const n = points.length;
  const max = Math.max(...points, 0);
  const slot = 100 / n;
  const gap = n > 40 ? 0.25 : Math.min(1.2, slot * 0.25);
  points.forEach((v, i) => {
    const h = max > 0 ? Math.max(v > 0 ? 1.5 : 0.6, (v / max) * 24) : 0.6;
    const r = document.createElementNS(SVG, 'rect');
    r.setAttribute('x', (i * slot + gap / 2).toFixed(2));
    r.setAttribute('y', (26 - h).toFixed(2));
    r.setAttribute('width', Math.max(0.3, slot - gap).toFixed(2));
    r.setAttribute('height', h.toFixed(2));
    r.setAttribute('rx', '0.6');
    svg.append(r);
  });
  return svg;
}

const STATUS_TEXT = { ok: 'up to date', error: 'error', loading: 'loading', unconfigured: 'not set up' };
const DENSITIES = ['compact', 'normal', 'detailed'];
let pickerOpen = false;

function density() {
  return DENSITIES.includes(state.meta.density) ? state.meta.density : 'normal';
}

/** A bar showing what's LEFT on a limit (m.pct is the share used). */
function meterEl(m, withRow = true) {
  const left = leftOf(m);
  const fill = el('i');
  fill.style.width = `${left}%`;
  const valuetext = m.detail && m.detail.includes('%') ? m.detail : [`${Math.round(left)}% left`, m.detail].filter(Boolean).join(', ');
  return el(
    'div',
    { class: 'meter', role: 'meter', 'aria-valuenow': Math.round(left), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `${m.label} remaining`, 'aria-valuetext': valuetext },
    withRow ? el('div', { class: 'meter-row' }, el('span', { text: m.label }), el('span', { class: 'meter-detail', text: m.detail || `${Math.round(left)}% left` })) : null,
    el('div', { class: `bar ${lowClass(left)}`.trim() }, fill)
  );
}

function hideProvider(id) {
  return api.saveSettings({ config: { providers: { [id]: { enabled: false } } } });
}

function showProvider(id) {
  pickerOpen = false;
  return api.saveSettings({ config: { providers: { [id]: { enabled: true } } } });
}

function shortName(c) {
  const p = (state.meta.providers || []).find((x) => x.id === c.id);
  return (p && p.short) || c.name;
}

function ageText(c) {
  return c.status === 'error' && c.updatedAt ? `stale · ${ago(c.updatedAt)}` : ago(c.updatedAt);
}

function cardHead(c, d) {
  const label = d === 'detailed' ? c.name : shortName(c);
  const status = STATUS_TEXT[c.status] || c.status;
  const age = ageText(c);
  return el(
    'header',
    { class: 'card-head' },
    el('span', { class: 'status-dot', title: status, 'aria-hidden': 'true' }),
    el('h2', { class: 'card-title' }, el('button', { class: 'card-name', text: label, title: `${c.name}: open usage page`, 'aria-label': `${c.name} (${status}), open usage page`, onclick: () => api.openConsole(c.id) })),
    d === 'detailed' ? el('span', { class: 'card-kind', text: c.kind === 'local' ? 'local' : 'api' }) : null,
    d === 'compact' ? null : el('span', { class: 'card-age', text: age }),
    el(
      'button',
      { class: 'card-hide', title: `Hide ${c.name}`, 'aria-label': `Hide ${c.name}`, onclick: () => hideProvider(c.id) },
      icon('M6 6l12 12M18 6L6 18')
    )
  );
}

function icon(d) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

const GRIP = [[1.5, 1.5], [4.5, 1.5], [1.5, 5], [4.5, 5], [1.5, 8.5], [4.5, 8.5]];

function gripEl() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'grip');
  svg.setAttribute('viewBox', '0 0 6 10');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cx, cy] of GRIP) {
    const dot = document.createElementNS(SVG, 'circle');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    dot.setAttribute('r', '1');
    svg.append(dot);
  }
  return svg;
}

function headlineEl(c, d) {
  const t = tightest(c);
  const label = d === 'compact' ? c.headline.short || c.headline.label : c.headline.label;
  return el('div', { class: 'headline' }, el('span', { class: `big ${t ? lowClass(leftOf(t)) : ''}`.trim(), text: c.headline.value }), el('span', { class: 'lbl', text: label || '' }));
}

/** Compact footnote: the error when there is one, otherwise the provider's one-liner. */
function footEl(c) {
  if (c.status === 'error') {
    const short = (c.error || 'error').split(':')[0];
    return el('p', { class: 'foot err', text: c.updatedAt ? `${short} · stale ${ago(c.updatedAt)}` : short, title: c.error || '' });
  }
  return c.foot ? el('p', { class: 'foot', text: c.foot }) : null;
}

function statsEl(stats, cols) {
  const dl = el('dl', { class: 'stats' }, stats.map((s) => el('div', {}, el('dt', { text: s.label }), el('dd', { text: s.value, title: s.value }))));
  if (cols) dl.style.gridTemplateColumns = cols;
  return dl;
}

function sparkEls(c) {
  if (!c.spark || !Array.isArray(c.spark.points) || c.spark.points.length < 2) return [];
  return [sparkline(c.spark.points, c.spark.label), el('div', { class: 'spark-lbl', text: c.spark.label, 'aria-hidden': 'true' })];
}

function renderCard(c) {
  const d = density();
  const card = el('article', { class: `card card-${d}`, 'data-status': c.status, 'data-id': c.id, draggable: 'true', 'aria-busy': c.status === 'loading' ? 'true' : null });
  if (d !== 'compact') card.append(gripEl());
  card.append(cardHead(c, d));

  if (c.status === 'unconfigured') {
    card.append(
      el(
        'div',
        { class: 'setup' },
        el('span', { text: 'Not set up yet.' }),
        el('button', { class: 'link-btn', text: d === 'compact' ? 'Set up' : 'Add key', 'aria-label': `Add key for ${c.name}`, onclick: () => openSettings(c.id) })
      )
    );
    return card;
  }

  if (c.status === 'loading' && !c.headline) {
    card.append(el('div', { class: 'skeleton big' }), d === 'compact' ? null : el('div', { class: 'skeleton' }));
    return card;
  }

  if (c.headline) card.append(headlineEl(c, d));

  const meters = c.meters || [];
  const stats = c.stats || [];
  if (d === 'compact') {
    // One thin bar for the tightest limit and a footnote; hover shows the rest.
    const t = tightest(c);
    if (t) card.append(meterEl(t, false));
    const foot = footEl(c);
    if (foot) card.append(foot);
    return card;
  }

  for (const m of meters) card.append(meterEl(m));

  const shownStats = d === 'normal' ? stats.slice(0, 2) : stats;
  if (shownStats.length) card.append(statsEl(shownStats, d === 'normal' ? '1fr' : null));
  if (d === 'detailed') card.append(...sparkEls(c));

  if (c.error) card.append(el('p', { class: 'err', text: c.error }));
  if (d === 'detailed' && c.note) card.append(el('p', { class: 'note', text: c.note }));
  return card;
}

function hiddenTools() {
  return (state.meta.providers || []).filter((p) => !p.enabled);
}

/** Hidden-tool list, shown at the top of the grid while the header's + button is open. */
function toolPicker() {
  const hidden = hiddenTools();
  if (!pickerOpen || !hidden.length) return [];
  return [
    el(
      'div',
      { class: 'picker', id: 'tool-picker', role: 'group', 'aria-label': 'Add a tool' },
      el('div', { class: 'picker-title', text: 'Add a tool' }),
      hidden.map((p) => {
        return el('button', { class: 'pick', onclick: () => showProvider(p.id) }, el('span', { class: 'swatch', 'aria-hidden': 'true' }), el('span', { text: p.name }), el('span', { class: 'card-kind', text: p.kind === 'local' ? 'local' : 'api' }));
      })
    ),
  ];
}

function togglePicker(open = !pickerOpen) {
  pickerOpen = open && hiddenTools().length > 0;
  render();
  const first = pickerOpen && document.querySelector('#tool-picker .pick');
  if (first) first.focus();
}

// Announce only meaningful changes (a tool failing or recovering), not the ticking "updated" time.
const lastStatus = new Map();

function announceChanges(cards) {
  const msgs = [];
  for (const c of cards) {
    const prev = lastStatus.get(c.id);
    if (prev && prev !== c.status) {
      if (c.status === 'error') msgs.push(`${c.name}: ${c.error || 'error'}`);
      else if (prev === 'error' && c.status === 'ok') msgs.push(`${c.name} is working again`);
    }
    lastStatus.set(c.id, c.status);
  }
  if (msgs.length) $('#announcer').textContent = msgs.join('. ');
}

function sortByLimit() {
  return state.meta.sortByLimit !== false;
}

/** Cards in display order: nearest limit first (stable), or the saved order as main sends it. */
function orderedCards() {
  const cards = state.cards || [];
  return sortByLimit() ? cards.slice().sort((a, b) => limitKey(a) - limitKey(b)) : cards;
}

function render() {
  // Rebuilding the grid mid-drag would remove the element being dragged; catch up on dragend.
  if (drag.id) {
    drag.stale = true;
    return;
  }
  const root = $('#cards');
  const cards = orderedCards();
  const d = density();
  root.className = `cards density-${d}`;
  const tiles = cards.map(renderCard);
  if (!cards.length) tiles.push(el('div', { class: 'empty', text: 'No tools shown. Use + in the header to add one.' }));
  // Re-rendering replaces the DOM; keep keyboard focus on the same control.
  const active = root.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = active && [active.closest('[data-id]')?.dataset.id || '', active.className].join('|');
  root.replaceChildren(...toolPicker(), ...tiles);
  if (focusKey) {
    const [id, cls] = focusKey.split('|');
    const scope = id ? root.querySelector(`[data-id="${CSS.escape(id)}"]`) : root;
    const again = scope && cls && scope.querySelector(`.${cls.split(' ')[0]}`);
    if (again) again.focus();
  }

  const newest = Math.max(0, ...cards.map((c) => c.updatedAt || 0));
  $('#updated').textContent = newest ? `updated ${ago(newest) === 'now' ? 'just now' : `${ago(newest)} ago`} · every ${state.meta.pollMinutes || 5}m` : 'waiting for data…';
  $('#btn-pin').setAttribute('aria-pressed', String(Boolean(state.meta.alwaysOnTop)));
  const hiddenCount = hiddenTools().length;
  if (!hiddenCount) pickerOpen = false;
  const add = $('#btn-add');
  add.disabled = !hiddenCount;
  add.title = hiddenCount ? `Add tool (${hiddenCount} hidden)` : 'All tools are shown';
  add.setAttribute('aria-label', add.title);
  add.setAttribute('aria-expanded', String(pickerOpen));
  $('#demo-banner').hidden = !state.meta.demo;
  const sorted = sortByLimit();
  // The visible text is the name and the state ("Nearest limit" / "Custom order"), so no aria-pressed.
  $('#btn-sort').dataset.on = String(sorted);
  $('#sort-label').textContent = sorted ? 'Nearest limit' : 'Custom order';
  scheduleFit();
  for (const b of document.querySelectorAll('#density button')) {
    const on = b.dataset.density === d;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1; // roving tabindex: one tab stop for the group
  }
}

// ---------- ordering: sort toggle, drag and Alt+arrow ----------
const drag = { id: null, stale: false };

async function setSortByLimit(on) {
  state.meta.sortByLimit = on; // instant feedback; main confirms via state:update
  render();
  await api.saveSettings({ config: { sortByLimit: on } });
}

/** Move card `id` to where `targetId` is now, and save that as the custom order. */
async function moveCard(id, targetId) {
  const shown = orderedCards().map((c) => c.id);
  const from = shown.indexOf(id);
  const to = shown.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return;
  shown.splice(from, 1);
  shown.splice(to, 0, id);
  const byId = new Map(state.cards.map((c) => [c.id, c]));
  state.cards = shown.map((x) => byId.get(x));
  state.meta.sortByLimit = false;
  render();
  // Hidden tools keep their place at the end; config also appends any it doesn't know.
  const rest = (state.meta.providers || []).map((p) => p.id).filter((x) => !shown.includes(x));
  await api.saveSettings({ config: { order: [...shown, ...rest], sortByLimit: false } });
}

function cardOf(target) {
  return target instanceof Element ? target.closest('#cards .card[data-id]') : null;
}

function clearDropTarget() {
  for (const n of document.querySelectorAll('#cards .drop-target')) n.classList.remove('drop-target');
}

function endDrag() {
  const wasStale = drag.stale;
  drag.id = null;
  drag.stale = false;
  clearDropTarget();
  for (const n of document.querySelectorAll('#cards .dragging')) n.classList.remove('dragging');
  if (wasStale) render();
}

const cardsRoot = $('#cards');
cardsRoot.addEventListener('dragstart', (e) => {
  const card = cardOf(e.target);
  if (!card) return;
  drag.id = card.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', drag.id);
  card.classList.add('dragging');
});
cardsRoot.addEventListener('dragover', (e) => {
  const card = cardOf(e.target);
  if (!drag.id || !card) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (card.dataset.id !== drag.id && !card.classList.contains('drop-target')) {
    clearDropTarget();
    card.classList.add('drop-target');
  }
});
cardsRoot.addEventListener('drop', (e) => {
  const card = cardOf(e.target);
  if (!drag.id || !card) return;
  e.preventDefault();
  const id = drag.id;
  drag.id = null; // let moveCard render
  endDrag();
  moveCard(id, card.dataset.id);
});
cardsRoot.addEventListener('dragend', endDrag);

// Keyboard alternative to dragging: Alt+arrow moves the focused card.
cardsRoot.addEventListener('keydown', (e) => {
  if (!e.altKey) return;
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  const card = cardOf(e.target);
  if (!step || !card) return;
  e.preventDefault();
  const ids = orderedCards().map((c) => c.id);
  const target = ids[ids.indexOf(card.dataset.id) + step];
  if (!target) return;
  const name = (state.cards.find((c) => c.id === card.dataset.id) || {}).name;
  moveCard(card.dataset.id, target).then(() => {
    $('#announcer').textContent = `${name} moved to position ${ids.indexOf(target) + 1} of ${ids.length}`;
  });
});

// ---------- window fits its content ----------
let fitTimer = 0;

/** Height the window needs so the visible pane shows everything without scrolling. */
function contentHeight() {
  const pane = settingsOpen ? $('#settings') : $('#cards');
  const cs = getComputedStyle(pane);
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  let inner = 0;
  if (settingsOpen) {
    inner = $('#settings-form').offsetHeight;
  } else {
    // .cards is position:relative, so children's offsetTop is measured from it.
    for (const child of pane.children) inner = Math.max(inner, child.offsetTop + child.offsetHeight - parseFloat(cs.paddingTop));
  }
  const chrome = window.innerHeight - pane.clientHeight;
  return Math.ceil(chrome + pad + inner);
}

function fitNow() {
  if (state.meta.autoFit === false) return;
  clearTimeout(fitTimer);
  api.fitHeight(contentHeight());
}

function scheduleFit() {
  if (state.meta.autoFit === false) return;
  // A timer rather than requestAnimationFrame: rAF doesn't fire while the widget is hidden.
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => api.fitHeight(contentHeight()), 30);
}

async function setDensity(d) {
  state.meta.density = d; // instant feedback; main confirms via state:update
  render();
  fitNow(); // resize in the same frame as the new layout instead of 30ms later
  await api.saveSettings({ config: { density: d } });
}

// ---------- settings ----------
const PROVIDER_FIELDS = {
  claudeCode: {
    help: 'Reads token usage from Claude Code transcripts on this computer. No key needed.',
    fields: [{ name: 'dir', label: 'Claude config folder (optional)', placeholder: '~/.claude (auto-detected)' }],
  },
  codex: {
    help: 'Reads the 5-hour and weekly limit snapshots Codex saves locally. No key needed.',
    fields: [{ name: 'home', label: 'CODEX_HOME (optional)', placeholder: '~/.codex (auto-detected)' }],
  },
  grokCli: {
    help: 'Reads per-turn tokens and cost that Grok CLI logs on this computer. No key needed.',
    fields: [{ name: 'home', label: 'Grok folder (optional)', placeholder: '~/.grok (auto-detected)' }],
  },
  copilot: {
    help: 'Paste the output of `gh auth token` (GitHub account with Copilot). Shows premium, chat and completions quota.',
    secret: { name: 'githubToken', placeholder: 'gho_…' },
    fields: [],
  },
  geminiCli: {
    help: 'Reads token counts from Gemini CLI chats saved on this computer. Gemini API keys have no usage endpoint.',
    fields: [{ name: 'home', label: 'Gemini folder (optional)', placeholder: '~/.gemini (auto-detected)' }],
  },
  anthropic: {
    help: 'Admin API key from Console → Settings → Admin Keys (org accounts only).',
    secret: { name: 'anthropicAdminKey', placeholder: 'sk-ant-admin01-…' },
    fields: [{ name: 'budget', label: 'Monthly budget, USD (0 = none)', type: 'number' }],
  },
  xai: {
    help: 'Management Key from console.x.ai → Settings → Management Keys, plus your team ID.',
    secret: { name: 'xaiManagementKey', placeholder: 'xai-…' },
    fields: [
      { name: 'teamId', label: 'Team ID', placeholder: 'e.g. 65c1e471-…' },
      { name: 'budget', label: 'Monthly budget, USD (0 = none)', type: 'number' },
    ],
  },
  openai: {
    help: 'Org Admin key from platform.openai.com → Settings → Admin keys. Covers Codex on an API key.',
    secret: { name: 'openaiAdminKey', placeholder: 'sk-admin-…' },
    fields: [{ name: 'budget', label: 'Monthly budget, USD (0 = none)', type: 'number' }],
  },
};

let settingsData = null;
const pendingSecrets = {};

function buildProviderFields(data) {
  const wrap = $('#provider-fields');
  wrap.replaceChildren();
  for (const p of data.providers) {
    const def = PROVIDER_FIELDS[p.id] || { fields: [] };
    const pc = data.config.providers[p.id] || {};
    const fs = el('fieldset', { 'data-provider': p.id, id: `fs-${p.id}` }, el('legend', {}, p.name, el('span', { class: 'kind', text: p.kind === 'local' ? 'local files' : 'API' })));
    fs.append(el('label', { class: 'check' }, el('input', { type: 'checkbox', 'data-field': 'enabled', checked: pc.enabled ? true : null }), 'Show on widget'));
    if (def.help) fs.append(el('p', { class: 'hint', id: `help-${p.id}`, text: def.help }));

    if (def.secret) {
      const status = data.secrets[def.secret.name];
      const input = el('input', {
        type: 'password',
        'data-secret': def.secret.name,
        'aria-label': `${p.name} key`,
        'aria-describedby': def.help ? `help-${p.id}` : null,
        placeholder: status === 'saved' ? 'Saved. Leave blank to keep' : status === 'env' ? 'Using environment variable' : def.secret.placeholder,
        spellcheck: 'false',
      });
      const clearBtn = el('button', {
        type: 'button',
        class: 'small',
        text: 'Clear',
        'aria-label': `Clear ${p.name} key`,
        disabled: status === 'saved' ? null : true,
        onclick: () => {
          pendingSecrets[def.secret.name] = null;
          input.value = '';
          input.placeholder = 'Will be removed on Save';
        },
      });
      fs.append(el('label', { class: 'stack' }, el('span', { text: 'Key' }), el('div', { class: 'key-row' }, input, clearBtn)));
    }

    for (const f of def.fields) {
      const val = pc[f.name] ?? '';
      fs.append(
        el(
          'label',
          { class: 'stack' },
          el('span', { text: f.label }),
          el('input', { type: f.type || 'text', 'data-field': f.name, value: String(val), placeholder: f.placeholder || '', min: f.type === 'number' ? '0' : null, step: f.type === 'number' ? 'any' : null, spellcheck: 'false' })
        )
      );
    }
    wrap.append(fs);
  }
}

async function openSettings(focusId) {
  settingsData = await api.getSettings();
  for (const k of Object.keys(pendingSecrets)) delete pendingSecrets[k];
  const f = $('#settings-form');
  const c = settingsData.config;
  f.pollMinutes.value = c.pollMinutes;
  f.alwaysOnTop.checked = Boolean(c.alwaysOnTop);
  f.startAtLogin.checked = Boolean(c.startAtLogin);
  f.forceX11.checked = Boolean(c.forceX11);
  f.forceX11.closest('label').hidden = settingsData.platform !== 'linux'; // XWayland is Linux-only
  f.opacity.value = c.opacity;
  showOpacity();
  f.theme.value = c.theme || 'system';
  f.autoFit.checked = c.autoFit !== false;

  const enc = settingsData.encryption;
  const encEl = $('#enc-status');
  if (enc.weak) {
    encEl.className = 'hint warn';
    encEl.textContent = `No system keyring found (backend: ${enc.backend}). Keys are saved in a user-only file without real encryption.${settingsData.platform === 'linux' ? ' Install gnome-keyring or KWallet for proper encryption.' : ''}`;
  } else {
    encEl.className = 'hint';
    encEl.textContent = `Keys are encrypted with your system keyring (${enc.backend}).`;
  }

  buildProviderFields(settingsData);
  settingsOpen = true;
  $('#toolbar').hidden = true;
  $('#cards').hidden = true;
  $('#settings').hidden = false;
  scheduleFit();
  if (focusId) {
    const target = document.getElementById(`fs-${focusId}`);
    if (target) {
      target.scrollIntoView({ block: 'start' });
      const input = target.querySelector('input[data-secret], input[type=text]');
      if (input) input.focus();
    }
  } else {
    $('#settings h2').focus();
  }
}

function showOpacity() {
  $('#opacity-val').textContent = `${Math.round(Number($('#settings-form').opacity.value) * 100)}%`;
}

function closeSettings() {
  settingsOpen = false;
  const hadFocus = $('#settings').contains(document.activeElement);
  $('#settings').hidden = true;
  $('#toolbar').hidden = false;
  $('#cards').hidden = false;
  render();
  // Focus would otherwise be lost on the now-hidden form.
  if (hadFocus) $('#btn-settings').focus();
}

async function saveSettings(e) {
  e.preventDefault();
  const f = $('#settings-form');
  const config = {
    pollMinutes: Number(f.pollMinutes.value) || 5,
    alwaysOnTop: f.alwaysOnTop.checked,
    startAtLogin: f.startAtLogin.checked,
    forceX11: f.forceX11.checked,
    opacity: Number(f.opacity.value) || 1,
    theme: f.theme.value,
    autoFit: f.autoFit.checked,
    providers: {},
  };
  const secrets = { ...pendingSecrets };
  for (const fs of document.querySelectorAll('#provider-fields fieldset')) {
    const id = fs.dataset.provider;
    const pc = {};
    for (const input of fs.querySelectorAll('[data-field]')) {
      const name = input.dataset.field;
      if (input.type === 'checkbox') pc[name] = input.checked;
      else if (input.type === 'number') pc[name] = Math.max(0, Number(input.value) || 0);
      else pc[name] = input.value.trim();
    }
    config.providers[id] = pc;
    const sec = fs.querySelector('[data-secret]');
    if (sec && sec.value.trim()) secrets[sec.dataset.secret] = sec.value.trim();
  }
  await api.saveSettings({ config, secrets });
  closeSettings();
}

// ---------- wiring ----------
$('#btn-refresh').addEventListener('click', async () => {
  const b = $('#btn-refresh');
  b.classList.add('spinning');
  try {
    await api.refresh();
  } finally {
    setTimeout(() => b.classList.remove('spinning'), 400);
  }
});
$('#btn-pin').addEventListener('click', async () => {
  const on = await api.togglePin();
  $('#btn-pin').setAttribute('aria-pressed', String(Boolean(on)));
});
$('#btn-settings').addEventListener('click', () => (settingsOpen ? closeSettings() : openSettings()));
$('#btn-hide').addEventListener('click', () => api.hide());
$('#btn-add').addEventListener('click', () => {
  if (settingsOpen) closeSettings();
  togglePicker();
});
for (const b of document.querySelectorAll('#density button')) b.addEventListener('click', () => setDensity(b.dataset.density));
$('#density').addEventListener('keydown', (e) => {
  // Radio-group arrow keys
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const next = DENSITIES[(DENSITIES.indexOf(density()) + step + DENSITIES.length) % DENSITIES.length];
  setDensity(next).then(() => document.querySelector(`#density [data-density="${next}"]`).focus());
});
$('#btn-sort').addEventListener('click', () => setSortByLimit(!sortByLimit()));
$('#btn-cancel').addEventListener('click', closeSettings);
$('#settings-form').opacity.addEventListener('input', showOpacity);
$('#settings-form').addEventListener('submit', saveSettings);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsOpen) closeSettings();
  else if (e.key === 'Escape' && pickerOpen) {
    togglePicker(false);
    $('#btn-add').focus();
  }
  if ((e.key === 'r' || e.key === 'F5') && !settingsOpen && !e.target.closest('input')) api.refresh();
});

api.onState((s) => {
  state = s;
  announceChanges(s.cards || []);
  if (!settingsOpen) render();
});
api.onOpenSettings(() => openSettings());
// Width changes reflow the grid (more or fewer columns), which changes the height needed.
new ResizeObserver(scheduleFit).observe($('#cards'));
api.getState().then((s) => {
  state = s;
  render();
});
// Keep relative times fresh.
setInterval(() => {
  if (!settingsOpen) render();
}, 30000);
