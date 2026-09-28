'use strict';

// Renders assets/logo.svg and assets/tray.svg to every icon the app and installers use:
// the window/tray PNGs, a Linux icon set, a Windows .ico and a macOS .icns.
// Each size is drawn from the SVG (not scaled from one PNG), so small sizes stay sharp.
// Run with: npm run icons   (uses Electron's Chromium, so no extra tools are needed)
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');
const logo = fs.readFileSync(path.join(ASSETS, 'logo.svg'), 'utf8');
const tray = fs.readFileSync(path.join(ASSETS, 'tray.svg'), 'utf8');
const tint = (svg, color) => svg.replace('color="#000000"', `color="${color}"`);

// [file, svg, size, padding]: the window icon (Linux/Windows title bars, autostart entry) and the tray.
const OUTPUTS = [
  ['icon.png', logo, 256, 0],
  ['tray-black.png', tint(tray, '#000000'), 22, 0],
  ['tray-black@2x.png', tint(tray, '#000000'), 44, 0],
  ['tray-white.png', tint(tray, '#ffffff'), 22, 0],
  ['tray-white@2x.png', tint(tray, '#ffffff'), 44, 0],
];

const MAC_PAD = 100 / 1024; // macOS icons sit inside Apple's 824/1024 grid

// Linux desktops pick the closest size from assets/icons/linux/NxN.png.
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
// Windows reads these from the .ico for the taskbar, Explorer and the installer.
const WIN_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
// macOS .icns: [type code, pixel size]. Retina types reuse the doubled pixel size.
const MAC_TYPES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];

/** ICO: a directory of PNG images (supported since Windows Vista). */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); // 0 means 256
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); // color planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

/** ICNS: 'icns' + total length, then [type, length, PNG] entries. */
function icns(entries) {
  const parts = entries.map(({ type, data }) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'ascii');
    h.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([h, data]);
  });
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'ascii');
  h.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([h, ...parts]);
}

async function render(win, svg, size, pad) {
  const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const js = `new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = ${size};
      c.getContext('2d').drawImage(img, ${pad}, ${pad}, ${size - 2 * pad}, ${size - 2 * pad});
      resolve(c.toDataURL('image/png').split(',')[1]);
    };
    img.onerror = reject;
    img.src = ${JSON.stringify(url)};
  })`;
  return Buffer.from(await win.webContents.executeJavaScript(js), 'base64');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const out = (file, data, note) => {
    fs.mkdirSync(path.dirname(path.join(ASSETS, file)), { recursive: true });
    fs.writeFileSync(path.join(ASSETS, file), data);
    console.log(`assets/${file} ${note}`);
  };
  for (const [file, svg, size, pad] of OUTPUTS) out(file, await render(win, svg, size, pad), `${size}px`);

  for (const size of LINUX_SIZES) out(`icons/linux/${size}x${size}.png`, await render(win, logo, size, 0), `${size}px`);

  const winPngs = [];
  for (const size of WIN_SIZES) winPngs.push({ size, data: await render(win, logo, size, 0) });
  out('icon.ico', ico(winPngs), WIN_SIZES.join('/'));

  const macPngs = [];
  for (const [type, size] of MAC_TYPES) macPngs.push({ type, data: await render(win, logo, size, size * MAC_PAD) });
  out('icon.icns', icns(macPngs), MAC_TYPES.map(([t, n]) => `${t}:${n}`).join(' '));

  app.exit(0);
});
