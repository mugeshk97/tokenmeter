'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
const FILE = path.join(DIR, 'tokenmeter.desktop');
const LEGACY_FILE = path.join(DIR, 'ai-usage-widget.desktop'); // name before the Tokenmeter rename

function quote(p) {
  return /[\s"'\\$`]/.test(p) ? `"${p.replace(/(["\\$`])/g, '\\$1')}"` : p;
}

/** Command that relaunches this exact build (AppImage, packaged binary, or `electron .` in dev). */
function launchCommand(app) {
  if (process.env.APPIMAGE) return quote(process.env.APPIMAGE);
  if (app.isPackaged) return quote(process.execPath);
  return `${quote(process.execPath)} ${quote(app.getAppPath())}`;
}

function setAutostart(app, enabled, iconPath) {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }
  try {
    fs.unlinkSync(LEGACY_FILE);
  } catch {
    /* not present */
  }
  if (!enabled) {
    try {
      fs.unlinkSync(FILE);
    } catch {
      /* not present */
    }
    return;
  }
  const icon = iconPath || path.join(app.getAppPath(), 'assets', 'icon.png');
  const desktop = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Tokenmeter',
    'Comment=AI token and quota usage on your desktop',
    `Exec=${launchCommand(app)}`,
    `Icon=${icon}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'X-GNOME-Autostart-Delay=5',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, desktop, { mode: 0o644 });
}

module.exports = { setAutostart, AUTOSTART_FILE: FILE, LEGACY_AUTOSTART_FILE: LEGACY_FILE };
