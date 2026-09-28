'use strict';

// Auto-update from GitHub Releases (electron-updater). Installs that can replace themselves
// (Windows installer, Linux AppImage) download in the background and install on restart; the
// others (Linux .deb, macOS until the app is signed with a Developer ID) only say an update is out
// and link to the download page.

const RELEASES_URL = 'https://github.com/mugeshk97/tokenmeter/releases/latest';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15 * 1000;

/**
 * 'auto' when this install can update itself, 'notify' when it can only point at the download.
 * @param {{ platform: string, appImage?: string, autoInstall?: boolean }} env
 */
function updateMode({ platform, appImage, autoInstall = true }) {
  if (!autoInstall) return 'notify';
  if (platform === 'win32') return 'auto';
  if (platform === 'linux' && appImage) return 'auto'; // a .deb would need a root password prompt
  return 'notify'; // macOS: Squirrel.Mac only installs apps signed with a Developer ID
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
    this.state = { status: 'idle', version: null, mode: this.mode() };
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
    return updateMode({ platform: process.platform, appImage: process.env.APPIMAGE, autoInstall: this.getAutoInstall() });
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
    else if (this.state.status === 'available') this.openExternal(RELEASES_URL);
  }
}

module.exports = { Updater, updateMode, RELEASES_URL };
