'use strict';

// Auto-update from GitHub Releases (electron-updater). The Windows installer downloads in the
// background and installs on restart. Elsewhere the app only says an update is out: Linux .deb
// installs update through apt (the repo on GitHub Pages), and macOS can't replace itself until the
// app is signed with a Developer ID, so it links to the download page.

const fs = require('fs');

const RELEASES_URL = 'https://github.com/mugeshk97/tokenmeter/releases/latest';
const APT_URL = 'https://mugeshk97.github.io/tokenmeter/#linux'; // apt setup instructions
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15 * 1000;

/**
 * 'auto' when this install can update itself, 'notify' when it can only say an update is out.
 * @param {{ platform: string, autoInstall?: boolean }} env
 */
function updateMode({ platform, autoInstall = true }) {
  if (!autoInstall) return 'notify';
  if (platform === 'win32') return 'auto';
  return 'notify'; // Linux: apt installs it; macOS: Squirrel.Mac needs a Developer ID signature
}

/** True when Homebrew installed this copy (mugeshk97/tap), so `brew upgrade` is the way to update. */
function installedWithBrew(platform = process.platform, exists = fs.existsSync) {
  return platform === 'darwin' && ['/opt/homebrew/Caskroom/tokenmeter', '/usr/local/Caskroom/tokenmeter'].some((p) => exists(p));
}

/** Where the update button points when this install can't update itself. */
function updateHelpUrl(platform) {
  return platform === 'linux' ? APT_URL : RELEASES_URL;
}

class Updater {
  /**
   * @param {object} opts
   * @param {() => boolean} opts.getAutoInstall  the "Install updates automatically" setting
   * @param {(state: object) => void} opts.onChange
   * @param {(url: string) => void} opts.openExternal
   * @param {object} [opts.autoUpdater]  injected in tests; electron-updater's otherwise
   */
  constructor({ getAutoInstall, onChange, openExternal, autoUpdater }) {
    this.getAutoInstall = getAutoInstall;
    this.onChange = onChange;
    this.openExternal = openExternal;
    this.au = autoUpdater || require('electron-updater').autoUpdater;
    this.state = { status: 'idle', version: null, mode: this.mode(), platform: process.platform, brew: installedWithBrew() };
    this.timers = [];

    this.au.autoDownload = false; // decided per check, from the mode
    this.au.autoInstallOnAppQuit = true;
    this.au.logger = console;
    // For testing a release locally: point the updater at a folder served over HTTP.
    if (process.env.TOKENMETER_UPDATE_URL) this.au.setFeedURL({ provider: 'generic', url: process.env.TOKENMETER_UPDATE_URL });

    this.au.on('checking-for-update', () => this.set({ status: 'checking' }));
    this.au.on('update-not-available', () => this.set({ status: 'current', version: null }));
    this.au.on('update-available', (info) => {
      const mode = this.mode();
      this.set({ status: mode === 'auto' ? 'downloading' : 'available', version: info.version, mode });
      if (mode === 'auto') this.au.downloadUpdate().catch((err) => this.fail(err));
    });
    this.au.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }));
    this.au.on('error', (err) => this.fail(err));
  }

  mode() {
    return updateMode({ platform: process.platform, autoInstall: this.getAutoInstall() });
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  fail(err) {
    console.warn('Update check failed:', (err && err.message) || err);
    // Keep a downloaded update; otherwise go quiet until the next check (offline is normal).
    if (this.state.status !== 'ready') this.set({ status: 'idle' });
  }

  check() {
    if (this.state.status === 'downloading' || this.state.status === 'ready') return Promise.resolve();
    return this.au.checkForUpdates().catch((err) => this.fail(err));
  }

  start() {
    this.timers.push(setTimeout(() => this.check(), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => this.check(), CHECK_EVERY_MS));
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** The header button: restart into a downloaded update, or open the download page. */
  act() {
    if (this.state.status === 'ready') this.au.quitAndInstall();
    else if (this.state.status === 'available') this.openExternal(updateHelpUrl(process.platform));
  }
}

module.exports = { Updater, updateMode, updateHelpUrl, installedWithBrew, RELEASES_URL, APT_URL };
