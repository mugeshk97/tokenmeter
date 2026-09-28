'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme, net, safeStorage, screen, shell, powerMonitor } = require('electron');
const { Store, readConfigSync } = require('./config');
const { Poller } = require('./poller');
const { PROVIDERS } = require('./providers');
const { setAutostart } = require('./autostart');
const { Updater } = require('./updater');

const ASSETS = path.join(__dirname, '..', 'assets');
const MIN_HEIGHT = 110;
const DEMO = process.env.AIU_DEMO === '1' || process.argv.includes('--demo'); // flag form works in any shell
const SCREENSHOT = process.env.AIU_SCREENSHOT || '';

// --- Pre-ready setup -------------------------------------------------------
/**
 * The app used to be called "AI Usage Widget". Its settings live under that name in
 * ~/.config; copy them over on the first run as Tokenmeter. The old folder is left as-is.
 * Keys encrypted by the old build may need re-entering: the keyring entry is tied to the app name.
 */
function migrateLegacyUserData() {
  const current = app.getPath('userData');
  const legacy = path.join(app.getPath('appData'), 'AI Usage Widget');
  if (legacy === current || fs.existsSync(path.join(current, 'config.json'))) return;
  if (!fs.existsSync(path.join(legacy, 'config.json'))) return;
  try {
    fs.mkdirSync(current, { recursive: true });
    for (const name of ['config.json', 'secrets.json']) {
      const from = path.join(legacy, name);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(current, name));
    }
  } catch (err) {
    console.warn('Settings migration failed:', err.message);
  }
}

// Always-on-top and window positioning are not allowed for native Wayland clients,
// so by default we run through XWayland on Wayland sessions.
{
  migrateLegacyUserData();
  const early = readConfigSync(app.getPath('userData'));
  if (early.forceX11 && process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
    app.commandLine.appendSwitch('ozone-platform', 'x11');
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let store;
let poller;
let updater = null; // only in the packaged app
let win = null;
let tray = null;
let quitting = false;
let lastCards = [];

function meta() {
  return {
    alwaysOnTop: Boolean(store.config.alwaysOnTop),
    pollMinutes: store.config.pollMinutes,
    density: store.config.density,
    sortByLimit: store.config.sortByLimit !== false,
    update: updater ? updater.state : null,
    schedule: poller ? poller.schedule() : null,
    autoFit: store.config.autoFit !== false,
    demo: DEMO,
    // Every provider, including hidden ones, so the widget can offer "Add tool".
    providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, short: p.short || p.name, accent: p.accent, kind: p.kind, enabled: Boolean((store.config.providers[p.id] || {}).enabled) })),
  };
}

// --- Window ----------------------------------------------------------------
function visibleBounds(saved) {
  const { width = 340, height = 620, x, y } = saved || {};
  if (Number.isFinite(x) && Number.isFinite(y)) {
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return x + 60 > a.x && x < a.x + a.width - 60 && y >= a.y - 10 && y < a.y + a.height - 40;
    });
    if (onScreen) return { width, height, x, y };
  }
  const a = screen.getPrimaryDisplay().workArea;
  return { width, height, x: a.x + a.width - width - 16, y: a.y + 16 };
}

/**
 * Resize the window to the content height the page asks for, like a desktop widget.
 * A widget the user placed in the lower half of the screen keeps its bottom edge fixed
 * and grows upward. The anchor only changes when the user moves the window, so
 * repeated grow/shrink never makes it drift.
 */
let anchorBottom = false;
let anchorEdge = 0; // the y of the edge the user placed: top, or bottom if anchorBottom
let fitting = false;

function updateAnchor() {
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  anchorBottom = b.y + b.height / 2 > area.y + area.height / 2;
  anchorEdge = anchorBottom ? b.y + b.height : b.y;
}

function fitHeight(contentHeight) {
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const maxH = Math.max(MIN_HEIGHT, area.height - 32);
  const h = Math.min(maxH, Math.max(MIN_HEIGHT, contentHeight));
  if (Math.abs(h - b.height) < 2) return;
  let y = anchorBottom ? anchorEdge - h : anchorEdge;
  y = Math.min(Math.max(y, area.y), area.y + area.height - h); // stay on screen
  fitting = true;
  win.setBounds({ x: b.x, y, width: b.width, height: h });
  setTimeout(() => (fitting = false), 300); // X11 reports the resulting move asynchronously
}

function createWindow() {
  const bounds = visibleBounds(store.config.window);
  win = new BrowserWindow({
    ...bounds,
    minWidth: 280,
    minHeight: MIN_HEIGHT,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: Boolean(store.config.alwaysOnTop),
    skipTaskbar: true,
    show: false,
    title: 'Tokenmeter',
    backgroundColor: '#0f1115',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  // visibleOnFullScreen: on macOS, stay visible over full-screen apps too.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setOpacity(Number(store.config.opacity) || 1);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.once('ready-to-show', () => {
    if (!SCREENSHOT) win.showInactive();
  });

  let saveTimer;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) store.setWindowBounds(win.getBounds());
    }, 600);
  };
  win.on('move', () => {
    if (!fitting) updateAnchor();
    saveBounds();
  });
  updateAnchor();
  win.on('resize', saveBounds);

  win.on('close', (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      win.hide();
      buildTrayMenu();
    }
  });
  win.on('closed', () => {
    win = null;
  });

  if (SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.AIU_SCREENSHOT_JS) {
          await win.webContents.executeJavaScript(process.env.AIU_SCREENSHOT_JS);
          await new Promise((r) => setTimeout(r, 600));
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(SCREENSHOT, img.toPNG());
        quitting = true;
        app.exit(0);
      }, 1800);
    });
  }
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
  buildTrayMenu();
}

function toggleWindow() {
  if (win && win.isVisible()) win.hide();
  else showWindow();
  buildTrayMenu();
}

function setAlwaysOnTop(v) {
  store.update({ config: { alwaysOnTop: Boolean(v) } });
  if (win) win.setAlwaysOnTop(Boolean(v));
  buildTrayMenu();
  pushState();
}

// --- Tray ------------------------------------------------------------------
function buildTrayMenu() {
  if (!tray) return;
  const visible = Boolean(win && win.isVisible());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: visible ? 'Hide widget' : 'Show widget', click: toggleWindow },
      { label: 'Refresh now', click: () => poller.refresh() },
      ...(updater
        ? [
            updater.state.status === 'ready'
              ? { label: `Restart to update to ${updater.state.version}`, click: () => updater.act() }
              : updater.state.status === 'available'
                ? { label: `Download update ${updater.state.version}…`, click: () => updater.act() }
                : { label: 'Check for updates', enabled: updater.state.status !== 'checking' && updater.state.status !== 'downloading', click: () => updater.check() },
          ]
        : []),
      { type: 'separator' },
      { label: 'Always on top', type: 'checkbox', checked: Boolean(store.config.alwaysOnTop), click: (m) => setAlwaysOnTop(m.checked) },
      {
        label: 'Start at login',
        type: 'checkbox',
        checked: Boolean(store.config.startAtLogin),
        click: (m) => applySettings({ config: { startAtLogin: m.checked } }),
      },
      {
        label: 'Settings…',
        click: () => {
          showWindow();
          win.webContents.send('ui:open-settings');
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function trayTooltip(cards) {
  const lines = cards
    .filter((c) => c.status === 'ok' && c.headline)
    .map((c) => `${c.name}: ${c.headline.value} ${c.headline.label || ''}`.trim());
  return lines.length ? lines.join('\n') : 'Tokenmeter';
}

/**
 * One-color tray mark at the size each OS draws it: 16px on Windows, 18pt in the macOS menu bar,
 * 22px on Linux panels, with a 2x version for HiDPI screens.
 * - macOS: black template image; the menu bar recolors it for light and dark.
 * - Windows: follows the taskbar's light/dark theme.
 * - Linux: white; most panels (GNOME's top bar included) are dark even in light mode.
 */
function trayImage() {
  const tone = process.platform === 'darwin' ? 'black' : process.platform === 'win32' && !nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'black' : 'white';
  const size = { win32: 16, darwin: 18 }[process.platform];
  if (!size) return nativeImage.createFromPath(path.join(ASSETS, `tray-${tone}.png`)); // picks the @2x file itself
  const img = nativeImage.createEmpty();
  for (const [file, scaleFactor] of [[`tray-${tone}.png`, 1], [`tray-${tone}@2x.png`, 2]]) {
    const src = nativeImage.createFromPath(path.join(ASSETS, file)).resize({ width: size * scaleFactor, height: size * scaleFactor, quality: 'best' });
    img.addRepresentation({ scaleFactor, width: size * scaleFactor, height: size * scaleFactor, buffer: src.toPNG() });
  }
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function createTray() {
  try {
    tray = new Tray(trayImage());
    // Windows: redraw the icon when the taskbar switches between light and dark.
    if (process.platform === 'win32') nativeTheme.on('updated', () => tray && tray.setImage(trayImage()));
    tray.setToolTip('Tokenmeter');
    tray.on('click', toggleWindow);
    buildTrayMenu();
  } catch (err) {
    console.warn('Tray unavailable:', err.message);
    tray = null;
  }
}

// --- State & settings ------------------------------------------------------
function visibleCards() {
  if (!DEMO) return lastCards;
  // Demo cards are fixed; apply the user's show/hide and order to them here.
  const order = store.config.order || [];
  return lastCards
    .filter((c) => (store.config.providers[c.id] || {}).enabled)
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state:update', { cards: visibleCards(), meta: meta() });
}

function onCards(cards) {
  lastCards = cards;
  pushState();
  if (tray) tray.setToolTip(trayTooltip(cards));
}

function settingsPayload() {
  const envMap = {};
  for (const p of PROVIDERS) Object.assign(envMap, p.env || {});
  const { window: _w, ...config } = store.config;
  return {
    config,
    secrets: store.secretFlags(envMap),
    encryption: store.encryptionInfo(),
    providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, kind: p.kind, secrets: p.secrets, env: p.env || {} })),
    session: process.env.XDG_SESSION_TYPE || 'unknown',
    platform: process.platform,
  };
}

// Provider settings minus the show/hide flag: showing or hiding a card shouldn't refetch everything.
function fetchSignature() {
  const providers = {};
  for (const [id, pc] of Object.entries(store.config.providers)) providers[id] = { ...pc, enabled: undefined };
  return JSON.stringify({ c: providers, p: store.config.pollMinutes, s: store.secretFlags() });
}

function enabledIds() {
  return Object.keys(store.config.providers).filter((id) => store.config.providers[id].enabled);
}

function applySettings(payload) {
  const before = fetchSignature();
  const enabledBefore = enabledIds();
  const prev = { ...store.config };
  store.update(payload || {});
  const changed = (k) => prev[k] !== store.config[k];
  // Only touch what changed: re-applying always-on-top/opacity makes the window manager
  // redraw the window, which flickered on every density switch or card show/hide.
  if (changed('theme')) applyTheme();
  if (win && changed('alwaysOnTop')) win.setAlwaysOnTop(Boolean(store.config.alwaysOnTop));
  if (win && changed('opacity')) win.setOpacity(Number(store.config.opacity) || 1);
  if (changed('startAtLogin')) {
    try {
      setAutostart(app, Boolean(store.config.startAtLogin), iconForAutostart());
    } catch (err) {
      console.warn('Autostart update failed:', err.message);
    }
  }
  const secretsTouched = payload && payload.secrets && Object.values(payload.secrets).some((v) => v === null || (typeof v === 'string' && v.trim()));
  if (!DEMO && (before !== fetchSignature() || secretsTouched)) {
    poller.reset();
  } else if (!DEMO) {
    for (const id of enabledIds()) if (!enabledBefore.includes(id)) poller.refreshById(id);
    poller.emit(); // re-filter cards for hidden/shown providers
  } else {
    pushState();
  }
  if (changed('alwaysOnTop') || changed('startAtLogin')) buildTrayMenu();
  return settingsPayload();
}

function applyTheme() {
  const t = process.env.AIU_THEME || store.config.theme;
  nativeTheme.themeSource = t === 'dark' || t === 'light' ? t : 'system';
}

function iconForAutostart() {
  // Copy the icon out of the (possibly read-only, temporary) app bundle.
  const dest = path.join(app.getPath('userData'), 'icon.png');
  try {
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(ASSETS, 'icon.png'), dest);
  } catch {
    /* ignore */
  }
  return dest;
}

function fromOurPage(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && url.startsWith('file://') && url.endsWith('/renderer/index.html');
}

function registerIpc() {
  const guard = (fn) => (event, ...args) => {
    if (!fromOurPage(event)) throw new Error('blocked');
    return fn(...args);
  };
  ipcMain.handle('state:get', guard(() => ({ cards: visibleCards(), meta: meta() })));
  ipcMain.handle(
    'refresh',
    guard((id) => {
      if (DEMO) return null;
      return typeof id === 'string' ? poller.refreshById(id) : poller.refresh();
    })
  );
  ipcMain.handle('settings:get', guard(() => settingsPayload()));
  ipcMain.handle(
    'settings:save',
    guard((payload) => {
      if (!payload || typeof payload !== 'object') throw new Error('bad payload');
      return applySettings(payload);
    })
  );
  ipcMain.handle(
    'window:hide',
    guard(() => {
      if (tray) win.hide();
      else win.minimize();
      buildTrayMenu();
    })
  );
  ipcMain.handle(
    'window:togglePin',
    guard(() => {
      setAlwaysOnTop(!store.config.alwaysOnTop);
      return store.config.alwaysOnTop;
    })
  );
  ipcMain.handle(
    'window:fit',
    guard((height) => {
      if (!win || win.isDestroyed() || store.config.autoFit === false) return;
      const h = Math.round(Number(height));
      if (!Number.isFinite(h)) return;
      fitHeight(h);
    })
  );
  // Script-driven window drag for the pinned widget. The pinned top bar can't be a native drag
  // area (Electron sends no hover events over those, and hover reveals the controls).
  // The OS cursor position is used rather than the page's pointer coordinates, which can shift
  // with the window as it moves and make it overshoot.
  let dragFrom = null;
  ipcMain.on('window:drag', (event, phase) => {
    if (!fromOurPage(event) || !win || win.isDestroyed() || !store.config.alwaysOnTop) return;
    const c = screen.getCursorScreenPoint();
    if (phase === 'start') {
      const [wx, wy] = win.getPosition();
      dragFrom = { wx, wy, x: c.x, y: c.y };
    } else if (phase === 'move' && dragFrom) {
      win.setPosition(dragFrom.wx + c.x - dragFrom.x, dragFrom.wy + c.y - dragFrom.y);
    } else {
      dragFrom = null;
    }
  });
  // Right-click menu on a card: a pointer alternative to dragging and the hover-only × button.
  ipcMain.handle(
    'card:menu',
    guard((opts) => {
      const o = opts && typeof opts === 'object' ? opts : {};
      const name = String(o.name || 'tool').slice(0, 60);
      return new Promise((resolve) => {
        let done = false;
        const finish = (action) => {
          if (!done) {
            done = true;
            resolve(action);
          }
        };
        const items = [];
        if (!o.locked) {
          items.push(
            { label: String(o.prevLabel || 'Move left').slice(0, 20), enabled: Boolean(o.canPrev), click: () => finish('prev') },
            { label: String(o.nextLabel || 'Move right').slice(0, 20), enabled: Boolean(o.canNext), click: () => finish('next') },
            { type: 'separator' },
            { label: `Hide ${name}`, click: () => finish('hide') },
            { type: 'separator' }
          );
        }
        items.push({ label: 'Open usage page', click: () => finish('open') });
        // The close callback can fire before a click is delivered; give the click a moment first.
        Menu.buildFromTemplate(items).popup({ window: win, callback: () => setTimeout(() => finish(null), 100) });
      });
    })
  );
  // Header update button: restart into a downloaded update, or open the download page.
  ipcMain.handle('update:act', guard(() => updater && updater.act()));
  ipcMain.handle(
    'open:console',
    guard((id) => {
      const p = PROVIDERS.find((x) => x.id === id);
      if (p && /^https:\/\//.test(p.console)) shell.openExternal(p.console);
    })
  );
}

// --- Lifecycle -------------------------------------------------------------
app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  // A desktop widget lives in the menu bar, not the Dock (macOS).
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  store = new Store(app.getPath('userData'), safeStorage);
  applyTheme();
  // Rewrite the login entry on each start: it moves the pre-rename file to tokenmeter.desktop
  // and keeps Exec pointing at this build after an update or reinstall.
  if (store.config.startAtLogin && !SCREENSHOT) {
    try {
      setAutostart(app, true, iconForAutostart());
    } catch (err) {
      console.warn('Autostart update failed:', err.message);
    }
  }

  if (DEMO) {
    const { demoCards } = require('./demo');
    const startedAt = Date.now();
    poller = { refresh() {}, refreshById() {}, reset() {}, stop() {}, schedule: () => ({ lastAt: startedAt, everyMs: store.config.pollMinutes * 60e3 }) };
    lastCards = demoCards();
  } else {
    poller = new Poller({
      providers: PROVIDERS,
      getConfig: () => store.config,
      getSecret: (name, env) => store.getSecret(name, env),
      onUpdate: onCards,
      // Chromium's network stack: honours the system proxy settings, unlike Node's fetch.
      ctx: { fetchImpl: (url, init) => net.fetch(url, init) },
    });
  }

  registerIpc();
  if (app.isPackaged && !DEMO && !SCREENSHOT) {
    updater = new Updater({
      getAutoInstall: () => store.config.autoUpdate !== false,
      onChange: () => {
        pushState();
        buildTrayMenu();
      },
      openExternal: (url) => shell.openExternal(url),
    });
    updater.start();
  }
  createWindow();
  if (!SCREENSHOT) createTray();
  if (!DEMO) poller.start();

  powerMonitor.on('resume', () => poller.refresh());
});

app.on('before-quit', () => {
  quitting = true;
  if (poller) poller.stop();
  if (updater) updater.stop();
});

// Keep running in the tray when the window is hidden.
app.on('window-all-closed', () => {
  if (!tray) app.quit();
});
